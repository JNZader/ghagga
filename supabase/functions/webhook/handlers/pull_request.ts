/**
 * Pull Request Event Handler
 *
 * Handles GitHub pull request events, orchestrating the code review process.
 * Fetches PR diff, filters files, runs reviews, and posts comments.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type {
  PullRequestEventPayload,
  GitHubDiffFile,
  GitHubRepository,
} from '../../_shared/types/index.ts';
import { SmartChunker } from '../../_shared/chunking/index.ts';
import { TokenBudgeter } from '../../_shared/tokens/index.ts';
import { getProviderRegistry } from '../../_shared/providers/index.ts';
import { WorkflowEngine, type WorkflowExecutionResult } from '../../_shared/workflow/index.ts';
import { ConsensusEngine, type ConsensusEngineResult } from '../../_shared/consensus/index.ts';

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
    return this.request<GitHubDiffFile[]>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}/files`
    );
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
    } catch {
      // Already decoded or invalid
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
      return {
        ...DEFAULT_REPO_CONFIG,
        ...customConfig,
        ignorePatterns: [
          ...DEFAULT_REPO_CONFIG.ignorePatterns,
          ...(customConfig.ignorePatterns || []),
        ],
      };
    } catch (e) {
      console.warn(`Failed to parse .ghagga.json: ${e}`);
    }
  }

  // Fall back to database config
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('repository_configs')
      .select('*')
      .eq('full_name', `${owner}/${repo}`)
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

/**
 * Get Supabase client
 */
function getSupabaseClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase credentials not configured');
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

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
  // Handle ** for any path
  if (pattern.includes('**')) {
    const parts = pattern.split('**');
    if (parts.length === 2) {
      const [prefix, suffix] = parts;
      const prefixMatch = !prefix || filename.startsWith(prefix);
      const suffixMatch = !suffix || filename.endsWith(suffix.replace(/^\//, ''));
      return prefixMatch && suffixMatch;
    }
  }

  // Handle * for single segment
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
        .replace(/\*/g, '[^/]*') // * matches anything except /
        .replace(/\?/g, '.') + // ? matches single char
      '$'
  );

  return regex.test(filename);
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
  deliveryId: string
): Promise<string> {
  const registry = getProviderRegistry();
  const provider = await registry.getBestProvider();

  if (!provider) {
    throw new Error('No LLM provider available');
  }

  console.log(`[${deliveryId}] Running simple review with ${provider.name}`);

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
  });

  return response.content;
}

/**
 * Run workflow-based review (multi-step analysis)
 */
async function runWorkflowReview(
  diff: string,
  rules: string,
  deliveryId: string
): Promise<WorkflowExecutionResult> {
  const registry = getProviderRegistry();

  // Create LLM caller function
  const llmCaller = async (options: { messages: unknown[]; maxTokens?: number }) => {
    const provider = await registry.getBestProvider();
    if (!provider) {
      throw new Error('No LLM provider available');
    }
    return provider.complete({
      messages: options.messages as { role: string; content: string }[],
      maxTokens: options.maxTokens || 2048,
    });
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
  deliveryId: string
): Promise<ConsensusEngineResult> {
  const registry = getProviderRegistry();
  const availableProviders = await registry.getAvailableProviders();

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
  filesSkipped: number
): string {
  const header = `## 🤖 GHAGGA Code Review\n\n`;
  const summary = `*Reviewed ${filesReviewed} files${filesSkipped > 0 ? `, skipped ${filesSkipped}` : ''}*\n\n`;

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

  return header + summary + body + footer;
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

    // Format diff content
    const diff = formatDiffForReview(toReview);

    // Use smart chunker and token budgeter for large diffs
    const chunker = new SmartChunker();
    const budgeter = new TokenBudgeter();

    const tokenEstimate = budgeter.estimateTokens(diff);
    const allocation = budgeter.allocate('claude-sonnet-4-20250514');

    let reviewContent = diff;
    if (tokenEstimate > allocation.content) {
      // Truncate diff to fit budget
      reviewContent = budgeter.truncateToFit(diff, allocation.content);
      console.log(
        `[${deliveryId}] Diff truncated from ${tokenEstimate} to ${allocation.content} tokens`
      );
    }

    // Run appropriate review mode
    let reviewResult: string | WorkflowExecutionResult | ConsensusEngineResult;

    switch (config.mode) {
      case 'simple':
        reviewResult = await runSimpleReview(reviewContent, config.customRules, deliveryId);
        break;
      case 'workflow':
        reviewResult = await runWorkflowReview(reviewContent, config.customRules, deliveryId);
        break;
      case 'consensus':
        reviewResult = await runConsensusReview(reviewContent, config.customRules, deliveryId);
        break;
      default:
        reviewResult = await runSimpleReview(reviewContent, config.customRules, deliveryId);
    }

    // Format and post comment
    const comment = formatReviewComment(
      reviewResult,
      config.mode,
      toReview.length,
      skipped.length
    );

    const { id: commentId } = await client.createPullRequestComment(
      owner,
      repo,
      pr.number,
      comment
    );

    console.log(`[${deliveryId}] Posted review comment (ID: ${commentId})`);

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
