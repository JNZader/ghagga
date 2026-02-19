/**
 * Pull Request Event Handler
 *
 * Handles GitHub pull request events, orchestrating the code review process.
 * Fetches PR diff, filters files, runs reviews, and posts comments.
 */

import type {
  PullRequestEventPayload,
  GitHubDiffFile,
  GitHubRepository,
} from '../../_shared/types/index.ts';
import { getSupabaseClient } from '../../_shared/db.ts';
import { TokenBudgeter } from '../../_shared/tokens/index.ts';
import { getProviderRegistry, getRepoCredentials, type PerRepoCredentials } from '../../_shared/providers/index.ts';
import { WorkflowEngine, type WorkflowExecutionResult } from '../../_shared/workflow/index.ts';
import { ConsensusEngine, type ConsensusEngineResult } from '../../_shared/consensus/index.ts';
import {
  runStaticAnalysis,
  formatFindingsAsLLMContext,
  DEFAULT_STATIC_ANALYSIS_CONFIG,
  type StaticAnalysisConfig,
  type StaticAnalysisResult,
} from '../../_shared/static-analysis/index.ts';
import { MemoryService } from '../../_shared/memory/index.ts';
import { EmbeddingService } from '../../_shared/embeddings/service.ts';

/**
 * Review mode configuration
 */
export type ReviewMode = 'simple' | 'workflow' | 'consensus';

/**
 * Repository configuration for reviews
 */
export interface RepoConfig {
  enabled: boolean;
  mode: ReviewMode;
  ignorePatterns: string[];
  customRules: string;
  maxFilesPerReview: number;
  preferredProvider?: string;
  model?: string;
  memory_enabled?: boolean;
}

/**
 * Default repository configuration
 */
const DEFAULT_REPO_CONFIG: RepoConfig = {
  enabled: true,
  mode: 'workflow',
  ignorePatterns: [
    '*.lock',
    '*.min.js',
    '*.min.css',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '*.generated.*',
    'dist/**',
    'build/**',
    'node_modules/**',
    'vendor/**',
    '.git/**',
  ],
  customRules: '',
  maxFilesPerReview: 50,
  memory_enabled: false,
};

/**
 * Result of pull request handling
 */
export interface PullRequestResult {
  success: boolean;
  message: string;
  prNumber: number;
  reviewMode: ReviewMode;
  filesReviewed: number;
  filesSkipped: number;
  commentPosted: boolean;
  commentId?: number;
  error?: string;
}

/**
 * GitHub API client using installation access token
 */
class GitHubClient {
  private accessToken: string;
  private baseUrl = 'https://api.github.com';

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Make an authenticated request to GitHub API
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get PR diff as a list of changed files
   */
  async getPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<GitHubDiffFile[]> {
    const allFiles: GitHubDiffFile[] = [];
    let page = 1;
    while (true) {
      const files = await this.request<GitHubDiffFile[]>(
        'GET',
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`
      );
      allFiles.push(...files);
      if (files.length < 100) break;
      page++;
    }
    return allFiles;
  }

  /**
   * Get the raw diff for a PR
   */
  async getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/vnd.github.v3.diff',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get PR diff: ${response.status}`);
    }

    return response.text();
  }

  /**
   * Post a comment on a PR
   */
  async createPullRequestComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    return this.request<{ id: number; html_url: string }>(
      'POST',
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body }
    );
  }

  /**
   * Get PR commits
   */
  async getPullRequestCommits(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<Array<{ sha: string; message: string }>> {
    const commits = await this.request<Array<{ sha: string; commit: { message: string } }>>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}/commits`
    );
    return commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  /**
   * Get file contents for multiple files (for Semgrep scanning)
   * Only fetches code files, limited to maxFiles to avoid API rate limits.
   */
  async getFileContents(
    owner: string,
    repo: string,
    paths: string[],
    ref: string,
    maxFiles: number = 30
  ): Promise<Array<{ path: string; content: string }>> {
    const CODE_EXTENSIONS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
      '.java', '.kt', '.kts', '.rb', '.php', '.cs', '.cpp',
      '.c', '.h', '.hpp', '.swift', '.scala',
    ]);

    const codePaths = paths.filter((p) => {
      const ext = '.' + p.split('.').pop();
      return CODE_EXTENSIONS.has(ext);
    }).slice(0, maxFiles);

    const results: Array<{ path: string; content: string }> = [];

    // Fetch in parallel (batches of 10 to avoid overwhelming the API)
    for (let i = 0; i < codePaths.length; i += 10) {
      const batch = codePaths.slice(i, i + 10);
      const fetched = await Promise.all(
        batch.map(async (path) => {
          const content = await this.getFileContent(owner, repo, path, ref);
          return content ? { path, content } : null;
        })
      );
      results.push(...fetched.filter((f): f is { path: string; content: string } => f !== null));
    }

    return results;
  }

  /**
   * Get file content from repository
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    try {
      const response = await this.request<{ content: string; encoding: string }>(
        'GET',
        `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`
      );

      if (response.encoding === 'base64') {
        return atob(response.content.replace(/\n/g, ''));
      }

      return response.content;
    } catch {
      return null;
    }
  }
}

/**
 * Get installation access token from GitHub
 */
async function getInstallationAccessToken(
  installationId: number
): Promise<string> {
  const appId = Deno.env.get('GITHUB_APP_ID');
  const privateKey = Deno.env.get('GITHUB_PRIVATE_KEY');

  if (!appId || !privateKey) {
    throw new Error('GitHub App credentials not configured');
  }

  // Decode base64 private key if needed
  let decodedKey = privateKey;
  if (!privateKey.startsWith('-----BEGIN')) {
    try {
      decodedKey = atob(privateKey);
    } catch (e) {
      console.warn('Failed to base64-decode GitHub private key, using raw value:', e instanceof Error ? e.message : 'decode error');
    }
  }

  // Create JWT for GitHub App authentication
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 1 minute ago to account for clock drift
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  const jwt = await createJWT(payload, decodedKey);

  // Exchange JWT for installation access token
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.token;
}

/**
 * Create a JWT for GitHub App authentication
 */
async function createJWT(
  payload: { iat: number; exp: number; iss: string },
  privateKey: string
): Promise<string> {
  // JWT header
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  // Encode header and payload
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const message = `${headerB64}.${payloadB64}`;

  // Import private key
  const pemContents = privateKey
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the message
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(message)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${message}.${signatureB64}`;
}

/**
 * Get repository configuration
 */
async function getRepoConfig(
  owner: string,
  repo: string,
  client: GitHubClient,
  headRef: string
): Promise<RepoConfig> {
  // Try to fetch .ghagga.json from the repository
  const configContent = await client.getFileContent(
    owner,
    repo,
    '.ghagga.json',
    headRef
  );

  if (configContent) {
    try {
      const customConfig = JSON.parse(configContent);

      // Allowlist: only safe fields can be overridden from .ghagga.json
      // Prevents PR authors from injecting mode, provider, customRules, etc.
      const safeConfig: Partial<RepoConfig> = {};
      if (Array.isArray(customConfig.ignorePatterns)) {
        safeConfig.ignorePatterns = [
          ...DEFAULT_REPO_CONFIG.ignorePatterns,
          ...customConfig.ignorePatterns.filter((p: unknown) => typeof p === 'string'),
        ];
      }
      if (typeof customConfig.maxFilesPerReview === 'number' &&
          customConfig.maxFilesPerReview > 0 &&
          customConfig.maxFilesPerReview <= 100) {
        safeConfig.maxFilesPerReview = customConfig.maxFilesPerReview;
      }
      if (typeof customConfig.enabled === 'boolean') {
        safeConfig.enabled = customConfig.enabled;
      }

      return {
        ...DEFAULT_REPO_CONFIG,
        ...safeConfig,
      };
    } catch (e) {
      console.warn(`Failed to parse .ghagga.json: ${e}`);
    }
  }

  // Fall back to database config
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('repo_configs')
      .select('*')
      .eq('repo_full_name', `${owner}/${repo}`)
      .single();

    if (data) {
      return {
        ...DEFAULT_REPO_CONFIG,
        ...data,
      };
    }
  } catch {
    // Ignore database errors, use default
  }

  return DEFAULT_REPO_CONFIG;
}

// getSupabaseClient imported from _shared/db.ts

/**
 * Check if a file should be reviewed based on patterns
 */
export function shouldReviewFile(
  filename: string,
  ignorePatterns: string[]
): boolean {
  for (const pattern of ignorePatterns) {
    if (matchPattern(filename, pattern)) {
      return false;
    }
  }
  return true;
}

/**
 * Simple glob pattern matching
 */
function matchPattern(filename: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const toRegex = (p: string) => {
    return p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
      .replace(/\*\*/g, '{{GLOBSTAR}}')      // Temporarily mark **
      .replace(/\*/g, '[^/]*')               // * matches anything except /
      .replace(/{{GLOBSTAR}}/g, '.*')         // ** matches anything including /
      .replace(/\?/g, '.');                   // ? matches single char
  };

  const regex = new RegExp('^' + toRegex(pattern) + '$');
  if (regex.test(filename)) {
    return true;
  }

  // For patterns without path separators, also match against basename
  // (consistent with .gitignore behavior)
  if (!pattern.includes('/')) {
    const basename = filename.split('/').pop() || filename;
    return regex.test(basename);
  }

  return false;
}

/**
 * Filter files for review
 */
export function filterFilesForReview(
  files: GitHubDiffFile[],
  config: RepoConfig
): { toReview: GitHubDiffFile[]; skipped: GitHubDiffFile[] } {
  const toReview: GitHubDiffFile[] = [];
  const skipped: GitHubDiffFile[] = [];

  for (const file of files) {
    // Skip deleted files (nothing to review)
    if (file.status === 'removed') {
      skipped.push(file);
      continue;
    }

    // Check ignore patterns
    if (!shouldReviewFile(file.filename, config.ignorePatterns)) {
      skipped.push(file);
      continue;
    }

    toReview.push(file);
  }

  // Limit files if needed
  if (toReview.length > config.maxFilesPerReview) {
    const excess = toReview.splice(config.maxFilesPerReview);
    skipped.push(...excess);
  }

  return { toReview, skipped };
}

/**
 * Format diff content for review
 */
function formatDiffForReview(files: GitHubDiffFile[]): string {
  return files
    .map((file) => {
      const header = `## ${file.filename} (${file.status})`;
      const stats = `+${file.additions} -${file.deletions}`;
      const patch = file.patch || '(binary file)';
      return `${header}\n${stats}\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join('\n\n');
}

/**
 * Run simple review (single LLM call)
 */
async function runSimpleReview(
  diff: string,
  rules: string,
  deliveryId: string,
  credentials?: PerRepoCredentials
): Promise<string> {
  const registry = getProviderRegistry();
  const provider = await registry.getBestProvider(undefined, credentials);

  if (!provider) {
    throw new Error('No LLM provider available');
  }

  console.log(`[${deliveryId}] Running simple review with ${provider.name}`);

  const credKey = credentials?.[provider.name as keyof PerRepoCredentials];
  const response = await provider.complete({
    messages: [
      {
        role: 'system',
        content: `You are an expert code reviewer. Analyze the provided code changes and provide constructive feedback.
Focus on:
- Code quality and best practices
- Potential bugs or issues
- Security concerns
- Performance implications
- Suggestions for improvement

${rules ? `\nRepository-specific guidelines:\n${rules}` : ''}

Format your response as a clear, actionable review comment.`,
      },
      {
        role: 'user',
        content: `Please review the following code changes:\n\n${diff}`,
      },
    ],
    maxTokens: 4096,
    temperature: 0.3,
  }, credKey);

  return response.content;
}

/**
 * Run workflow-based review (multi-step analysis)
 */
async function runWorkflowReview(
  diff: string,
  rules: string,
  deliveryId: string,
  credentials?: PerRepoCredentials
): Promise<WorkflowExecutionResult> {
  const registry = getProviderRegistry();

  // Create LLM caller function that uses per-repo credentials
  const llmCaller = async (options: { messages: unknown[]; maxTokens?: number }) => {
    const provider = await registry.getBestProvider(undefined, credentials);
    if (!provider) {
      throw new Error('No LLM provider available');
    }
    const credKey = credentials?.[provider.name as keyof PerRepoCredentials];
    return provider.complete({
      messages: options.messages as { role: string; content: string }[],
      maxTokens: options.maxTokens || 2048,
    }, credKey);
  };

  const engine = new WorkflowEngine(
    {
      provider: {
        name: 'auto',
        model: 'auto',
        maxTokens: 2048,
      },
    },
    llmCaller
  );

  console.log(`[${deliveryId}] Running workflow review`);

  return engine.runParallel(diff, rules);
}

/**
 * Run consensus-based review (multi-model voting)
 */
async function runConsensusReview(
  diff: string,
  rules: string,
  deliveryId: string,
  credentials?: PerRepoCredentials
): Promise<ConsensusEngineResult> {
  const registry = getProviderRegistry();
  const availableProviders = await registry.getAvailableProviders(credentials);

  if (availableProviders.length === 0) {
    throw new Error('No LLM providers available for consensus');
  }

  const engine = new ConsensusEngine();

  // Register available providers
  for (const provider of availableProviders) {
    engine.registerProvider(provider);
  }

  console.log(
    `[${deliveryId}] Running consensus review with ${availableProviders.length} providers`
  );

  // Build proposal for consensus
  const proposal = `## Code Review Request\n\n${rules ? `### Guidelines:\n${rules}\n\n` : ''}### Changes:\n${diff}`;

  // Create model configs based on available providers
  const modelConfigs = availableProviders.slice(0, 3).map((provider, index) => ({
    provider: provider.name,
    model: provider.models[0],
    stance: (['for', 'against', 'neutral'] as const)[index % 3],
  }));

  return engine.runConsensus(proposal, modelConfigs);
}

/**
 * Format review result as a PR comment
 */
function formatReviewComment(
  result: string | WorkflowExecutionResult | ConsensusEngineResult,
  mode: ReviewMode,
  filesReviewed: number,
  filesSkipped: number,
  staticResult?: StaticAnalysisResult
): string {
  const header = `## 🤖 GHAGGA Code Review\n\n`;
  const summary = `*Reviewed ${filesReviewed} files${filesSkipped > 0 ? `, skipped ${filesSkipped}` : ''}*\n\n`;

  // Static Analysis section (before AI review)
  let staticSection = '';
  if (staticResult) {
    staticSection = formatStaticAnalysisSection(staticResult);
  }

  let body: string;

  if (typeof result === 'string') {
    // Simple review
    body = result;
  } else if ('synthesis' in result && 'findings' in result) {
    // Workflow result
    const workflow = result as WorkflowExecutionResult;
    body = `### Analysis Complete\n\n`;
    body += `**Status:** ${workflow.status}\n`;
    body += `**Duration:** ${workflow.totalDuration_ms}ms\n\n`;

    if (workflow.findings.length > 0) {
      body += `### Findings\n\n`;
      for (const finding of workflow.findings) {
        body += `#### ${finding.stepName}\n${finding.findings}\n\n`;
      }
    }

    body += `### Summary\n\n${workflow.synthesis.findings}`;
  } else {
    // Consensus result
    const consensus = result as ConsensusEngineResult;
    body = `### Consensus Review\n\n`;
    body += `**Recommendation:** ${consensus.recommendation.action.toUpperCase()}\n`;
    body += `**Confidence:** ${(consensus.recommendation.confidence * 100).toFixed(0)}%\n\n`;
    body += `### Analysis\n\n${consensus.synthesis}`;
  }

  const footer = `\n\n---\n*Review mode: ${mode} | [GHAGGA](https://github.com/ghagga)*`;

  return header + summary + staticSection + body + footer;
}

/**
 * Format the static analysis section of the PR comment
 */
function formatStaticAnalysisSection(result: StaticAnalysisResult): string {
  const lines: string[] = [];

  const stackLabels: Record<string, string> = {
    'java-gradle': 'Java/Kotlin (Gradle)',
    'java-maven': 'Java/Kotlin (Maven)',
    'node-npm': 'Node.js (npm)',
    'node-yarn': 'Node.js (Yarn)',
    'node-pnpm': 'Node.js (pnpm)',
    'python': 'Python',
    'go': 'Go',
    'rust': 'Rust',
    'unknown': 'Unknown',
  };

  const stackLabel = stackLabels[result.detectedStack] || result.detectedStack;
  const semgrepStatus = result.summary.security.serviceAvailable
    ? `${result.totalTimeMs}ms`
    : 'unavailable';

  lines.push(`### Static Analysis`);
  lines.push(
    `**${result.findings.length} issues found** | Stack: ${stackLabel} | Semgrep: ${semgrepStatus}`
  );
  lines.push('');

  if (!result.summary.security.serviceAvailable && result.summary.security.findings === 0) {
    lines.push('> Security scan skipped. Configure Semgrep service URL in Settings.');
    lines.push('');
  }

  if (result.findings.length > 0) {
    // Group by severity
    const groups: Record<string, typeof result.findings> = {
      error: [],
      warning: [],
      info: [],
      suggestion: [],
    };
    for (const f of result.findings) {
      groups[f.severity].push(f);
    }

    for (const [severity, findings] of Object.entries(groups)) {
      if (findings.length === 0) continue;

      const label = severity.charAt(0).toUpperCase() + severity.slice(1) + 's';
      lines.push(`#### ${label} (${findings.length})`);

      for (const finding of findings) {
        let line = `- **[${finding.ruleId}]** ${finding.message}`;
        if (finding.file) {
          line += ` *(${finding.file}`;
          if (finding.line) line += `:${finding.line}`;
          line += ')*';
        }
        lines.push(line);

        if (finding.suggestion) {
          lines.push(`  > ${finding.suggestion}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build StaticAnalysisConfig from the repo config object
 */
function buildStaticAnalysisConfig(config: RepoConfig): StaticAnalysisConfig {
  return {
    enabled: config.static_analysis_enabled ?? DEFAULT_STATIC_ANALYSIS_CONFIG.enabled,
    aiAttributionCheck: config.ai_attribution_check ?? DEFAULT_STATIC_ANALYSIS_CONFIG.aiAttributionCheck,
    securityPatternsCheck: config.security_patterns_check ?? DEFAULT_STATIC_ANALYSIS_CONFIG.securityPatternsCheck,
    semgrepServiceUrl: config.semgrep_service_url ?? DEFAULT_STATIC_ANALYSIS_CONFIG.semgrepServiceUrl,
    commitMessageCheck: config.commit_message_check ?? DEFAULT_STATIC_ANALYSIS_CONFIG.commitMessageCheck,
    stackAwarePrompts: config.stack_aware_prompts ?? DEFAULT_STATIC_ANALYSIS_CONFIG.stackAwarePrompts,
  };
}

/**
 * Extract review findings from various result types for memory storage
 */
export function extractFindingsFromResult(
  result: string | WorkflowExecutionResult | ConsensusEngineResult
): Array<{ severity: 'error' | 'warning' | 'info' | 'suggestion'; category: string; message: string; file?: string; line?: number; suggestion?: string }> {
  if (typeof result === 'string') {
    // Simple review - create a single observation from the text
    return [{
      severity: 'info',
      category: 'review',
      message: result.slice(0, 500),
    }];
  }

  if ('synthesis' in result && 'findings' in result) {
    // Workflow result
    const workflow = result as WorkflowExecutionResult;
    return workflow.findings.map((f) => ({
      severity: 'info' as const,
      category: f.stepName || 'workflow',
      message: typeof f.findings === 'string' ? f.findings.slice(0, 500) : String(f.findings).slice(0, 500),
    }));
  }

  // Consensus result
  const consensus = result as ConsensusEngineResult;
  return [{
    severity: consensus.recommendation?.action === 'reject' ? 'error' as const : 'info' as const,
    category: 'consensus',
    message: (consensus.synthesis || '').slice(0, 500),
  }];
}

/**
 * Handle a pull request event
 */
export async function handlePullRequest(
  payload: PullRequestEventPayload,
  deliveryId: string
): Promise<PullRequestResult> {
  const { pull_request: pr, repository } = payload;
  const owner = repository?.owner?.login;
  const repo = repository?.name;

  if (!owner || !repo || !repository) {
    return {
      success: false,
      message: 'Missing repository information',
      prNumber: pr.number,
      reviewMode: 'simple',
      filesReviewed: 0,
      filesSkipped: 0,
      commentPosted: false,
      error: 'Repository information not found in payload',
    };
  }

  console.log(
    `[${deliveryId}] Processing PR #${pr.number} in ${owner}/${repo}`
  );

  try {
    // Get installation access token
    const installationId = payload.installation?.id;
    if (!installationId) {
      throw new Error('Installation ID not found');
    }

    const accessToken = await getInstallationAccessToken(installationId);
    const client = new GitHubClient(accessToken);

    // Get repository config
    const config = await getRepoConfig(owner, repo, client, pr.head.sha);

    // Early exit if reviews are disabled (before expensive credential/memory init)
    if (!config.enabled) {
      return {
        success: true,
        message: 'Reviews disabled for this repository',
        prNumber: pr.number,
        reviewMode: config.mode,
        filesReviewed: 0,
        filesSkipped: 0,
        commentPosted: false,
      };
    }

    // Load credentials and initialize memory in parallel
    const supabase = getSupabaseClient();
    let credentials: PerRepoCredentials = {};
    let memoryService: MemoryService | undefined;
    let memorySessionId: string | undefined;
    let memoryContextStr = '';

    const credentialPromise = getRepoCredentials(`${owner}/${repo}`, supabase)
      .catch((credError) => {
        console.warn(`[${deliveryId}] Failed to load per-repo credentials, using env vars:`, credError);
        return {} as PerRepoCredentials;
      });

    const memoryPromise = config.memory_enabled
      ? (async () => {
          const embeddingService = new EmbeddingService({
            provider: 'auto',
            fallback: 'none',
            model: 'text-embedding-3-small',
            openaiApiKey: Deno.env.get('OPENAI_API_KEY'),
            geminiApiKey: Deno.env.get('GEMINI_API_KEY'),
          });

          const svc = new MemoryService(supabase, embeddingService);
          const sessionId = await svc.startSession(
            `${owner}/${repo}`,
            installationId,
            pr.number,
            pr.title
          );

          const queryText = `${pr.title} ${(pr.body || '').slice(0, 500)}`;
          const memoryContext = await svc.consultMemory(
            `${owner}/${repo}`,
            queryText
          );
          const contextStr = svc.formatContextForLLM(memoryContext);

          if (contextStr) {
            console.log(
              `[${deliveryId}] Memory: found ${memoryContext.observations.length} relevant past observations`
            );
          }

          return { svc, sessionId, contextStr };
        })().catch((memError) => {
          console.warn(`[${deliveryId}] Memory initialization failed:`, memError);
          return null;
        })
      : Promise.resolve(null);

    const [credResult, memResult] = await Promise.all([credentialPromise, memoryPromise]);
    credentials = credResult;
    if (memResult) {
      memoryService = memResult.svc;
      memorySessionId = memResult.sessionId;
      memoryContextStr = memResult.contextStr;
    }

    // Get PR files
    const files = await client.getPullRequestFiles(owner, repo, pr.number);
    console.log(`[${deliveryId}] Found ${files.length} changed files`);

    // Filter files for review
    const { toReview, skipped } = filterFilesForReview(files, config);
    console.log(
      `[${deliveryId}] Reviewing ${toReview.length} files, skipping ${skipped.length}`
    );

    if (toReview.length === 0) {
      return {
        success: true,
        message: 'No files to review after filtering',
        prNumber: pr.number,
        reviewMode: config.mode,
        filesReviewed: 0,
        filesSkipped: skipped.length,
        commentPosted: false,
      };
    }

    // Fetch commits and file contents in parallel (for static analysis)
    const [commits, fileContents] = await Promise.all([
      client.getPullRequestCommits(owner, repo, pr.number),
      client.getFileContents(
        owner,
        repo,
        toReview.filter((f) => f.status !== 'removed').map((f) => f.filename),
        pr.head.sha
      ),
    ]);

    console.log(
      `[${deliveryId}] Fetched ${commits.length} commits, ${fileContents.length} file contents`
    );

    // Build static analysis config from repo config (database fields)
    const staticConfig: StaticAnalysisConfig = buildStaticAnalysisConfig(config);

    // Run static analysis (Layer 0 - pre-LLM)
    let staticResult: StaticAnalysisResult | undefined;
    if (staticConfig.enabled) {
      staticResult = await runStaticAnalysis({
        files: toReview,
        fileContents,
        commits,
        config: staticConfig,
      });

      console.log(
        `[${deliveryId}] Static analysis: ${staticResult.findings.length} findings in ${staticResult.totalTimeMs}ms (stack: ${staticResult.detectedStack})`
      );
    }

    // Format diff content
    const diff = formatDiffForReview(toReview);

    // Token budgeting for large diffs
    const tokenEstimate = TokenBudgeter.estimateTokens(diff);
    const allocation = TokenBudgeter.allocate(config.model || 'claude-sonnet-4-20250514');

    let reviewContent = diff;
    if (tokenEstimate > allocation.content) {
      // Truncate diff to fit budget
      reviewContent = TokenBudgeter.truncateToFit(diff, allocation.content);
      console.log(
        `[${deliveryId}] Diff truncated from ${tokenEstimate} to ${allocation.content} tokens`
      );
    }

    // Build static analysis context for LLM
    const staticContext = staticResult
      ? formatFindingsAsLLMContext(staticResult)
      : '';

    // Enrich rules with static analysis context and memory context
    const enrichedRules = [config.customRules, staticContext, memoryContextStr]
      .filter(Boolean)
      .join('\n\n');

    // Run appropriate review mode
    let reviewResult: string | WorkflowExecutionResult | ConsensusEngineResult;

    switch (config.mode) {
      case 'simple':
        reviewResult = await runSimpleReview(reviewContent, enrichedRules, deliveryId, credentials);
        break;
      case 'workflow':
        reviewResult = await runWorkflowReview(reviewContent, enrichedRules, deliveryId, credentials);
        break;
      case 'consensus':
        reviewResult = await runConsensusReview(reviewContent, enrichedRules, deliveryId, credentials);
        break;
      default:
        reviewResult = await runSimpleReview(reviewContent, enrichedRules, deliveryId, credentials);
    }

    // Format and post comment (with static analysis section)
    const comment = formatReviewComment(
      reviewResult,
      config.mode,
      toReview.length,
      skipped.length,
      staticResult
    );

    const { id: commentId } = await client.createPullRequestComment(
      owner,
      repo,
      pr.number,
      comment
    );

    console.log(`[${deliveryId}] Posted review comment (ID: ${commentId})`);

    // Save memory observations (non-blocking, pattern from Hebbian)
    if (memoryService && memorySessionId) {
      try {
        // Extract findings from workflow result for observation extraction
        const reviewFindings = extractFindingsFromResult(reviewResult);

        const observations = memoryService.extractObservationsFromFindings(
          reviewFindings,
          toReview,
          pr.number,
          memorySessionId,
          installationId,
          `${owner}/${repo}`
        );

        await Promise.all(observations.map(obs => memoryService!.addObservation(obs)));

        await memoryService.closeSession(memorySessionId);

        console.log(
          `[${deliveryId}] Memory: saved ${observations.length} observations, session closed`
        );
      } catch (memError) {
        console.warn(`[${deliveryId}] Memory save failed:`, memError);
        // Non-blocking - review was already posted
      }
    }

    return {
      success: true,
      message: 'Review completed and posted',
      prNumber: pr.number,
      reviewMode: config.mode,
      filesReviewed: toReview.length,
      filesSkipped: skipped.length,
      commentPosted: true,
      commentId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${deliveryId}] PR handler error:`, errorMessage);

    return {
      success: false,
      message: 'Error processing pull request',
      prNumber: pr.number,
      reviewMode: 'simple',
      filesReviewed: 0,
      filesSkipped: 0,
      commentPosted: false,
      error: errorMessage,
    };
  }
}
