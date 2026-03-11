// ─── Rule-Based CI Job Analysis ─────────────────────────────────
//
// Fast, deterministic analysis of discovered CI jobs to recommend
// whether each job is safe to delegate. No LLM calls, no external
// API calls -- pure pattern matching on job keys and commands.

// Local type definitions matching the shared @ghagga/types package.
// The server package does not directly depend on @ghagga/types,
// so we define compatible interfaces here.

type RecommendationConfidence = 'high' | 'medium' | 'low';

export interface JobRecommendation {
  delegable: boolean;
  confidence: RecommendationConfidence;
  reason: string;
  suggestedProfile: string | null;
}

interface DiscoveredCiJob {
  source: string;
  sourceFile: string;
  jobKey: string;
  displayName: string;
  command: string | null;
  suggestedProfile: string;
  runtime: string;
  recommendation?: JobRecommendation;
}

// ─── Pattern Lists ──────────────────────────────────────────────

// Commands that indicate a JVM/Gradle project (not supported in MVP profiles)
const JVM_PATTERNS = ['gradlew', 'gradle', 'mvn', 'maven'];

// Commands that indicate .NET (not supported)
const DOTNET_PATTERNS = ['dotnet', 'csharp', 'msbuild'];

// Commands that indicate Rust (not supported)
const RUST_PATTERNS = ['cargo', 'rustup'];

// Commands that indicate PHP (not supported)
const PHP_PATTERNS = ['composer', 'artisan'];

// Job keys that indicate deployment/release (never delegable)
const DEPLOY_KEYWORDS = ['deploy', 'release', 'publish', 'push'];

// Job keys that indicate Docker operations (need registry creds)
const DOCKER_JOB_KEYWORDS = ['docker', 'build-and-push', 'native-build'];

// Job keys that indicate staging/production environments
const ENV_KEYWORDS = ['staging', 'production'];

// Job keys that indicate security scanning (may need tokens)
const SECURITY_KEYWORDS = ['scan', 'trivy', 'owasp', 'security'];

// Job keys for utility/orchestration jobs (not CI checks)
const UTILITY_KEYWORDS = ['keep-alive', 'ping', 'cleanup'];

// Job keys for orchestration/setup steps
const ORCHESTRATION_KEYWORDS = ['setup', 'prepare', 'summary', 'status', 'verification'];

// Commands that indicate external service dependencies
const CREDENTIAL_COMMANDS = ['docker', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'ssh'];

// Environment variable expansion patterns
const ENV_VAR_PATTERNS = ['${{', '${GITHUB', '$GITHUB_ENV'];

// Standard safe test runner commands
const SAFE_TEST_COMMANDS = ['npm test', 'npx jest', 'npx vitest', 'pytest', 'go test'];

// Lint-related job key patterns
const LINT_KEYWORDS = ['lint', 'eslint', 'biome', 'prettier', 'format', 'style', 'ruff', 'flake8'];

// Test-related job key patterns
const TEST_KEYWORDS = ['test', 'spec', 'jest', 'vitest', 'pytest', 'mocha'];

// Typecheck-related job key patterns
const TYPECHECK_KEYWORDS = ['typecheck', 'type-check', 'tsc'];

// ─── Helpers ────────────────────────────────────────────────────

function keyContains(jobKey: string, keywords: string[]): boolean {
  const lower = jobKey.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function commandContains(command: string | null, patterns: string[]): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function commandContainsAny(command: string | null, patterns: string[]): boolean {
  return commandContains(command, patterns);
}

function isEmptyOrTrivialCommand(command: string | null): boolean {
  if (!command) return true;
  const trimmed = command.trim();
  if (trimmed === '' || trimmed === '|') return true;
  if (trimmed.startsWith('sleep')) return true;
  // Just a chmod on gradlew -- miscategorized step
  if (/^chmod\s+\+x\s+.*gradlew/.test(trimmed)) return true;
  return false;
}

function isStandardTestRunner(command: string | null): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return SAFE_TEST_COMMANDS.some((c) => lower.includes(c));
}

function hasMatrixVariables(command: string | null): boolean {
  if (!command) return false;
  return command.includes('matrix.');
}

// ─── Main Analysis ──────────────────────────────────────────────

function makeRecommendation(
  delegable: boolean,
  confidence: RecommendationConfidence,
  reason: string,
  suggestedProfile: string | null = null,
): JobRecommendation {
  return { delegable, confidence, reason, suggestedProfile };
}

/**
 * Analyze a single discovered CI job and produce a delegation recommendation.
 * Rules are evaluated in priority order -- first match wins.
 */
export function analyzeJob(job: DiscoveredCiJob): JobRecommendation {
  const { jobKey, command } = job;

  // ── Priority 1: Profile/Runtime mismatch (unsupported runtimes) ──

  if (commandContains(command, JVM_PATTERNS)) {
    return makeRecommendation(
      false,
      'high',
      'JVM/Gradle project — no matching execution profile available',
    );
  }

  if (commandContains(command, DOTNET_PATTERNS)) {
    return makeRecommendation(
      false,
      'high',
      '.NET project — no matching execution profile available',
    );
  }

  if (commandContains(command, RUST_PATTERNS)) {
    return makeRecommendation(
      false,
      'high',
      'Rust project — no matching execution profile available',
    );
  }

  if (commandContains(command, PHP_PATTERNS)) {
    return makeRecommendation(
      false,
      'high',
      'PHP project — no matching execution profile available',
    );
  }

  // ── Priority 2: Empty/trivial command ──

  if (isEmptyOrTrivialCommand(command)) {
    return makeRecommendation(false, 'high', 'No meaningful command detected — cannot delegate');
  }

  // ── Priority 3: Unsafe patterns (by job key) ──

  if (keyContains(jobKey, DEPLOY_KEYWORDS)) {
    return makeRecommendation(
      false,
      'high',
      'Deployment/release job — requires credentials and external access',
    );
  }

  if (keyContains(jobKey, DOCKER_JOB_KEYWORDS)) {
    return makeRecommendation(false, 'high', 'Docker/native build — requires registry credentials');
  }

  if (keyContains(jobKey, ENV_KEYWORDS)) {
    return makeRecommendation(
      false,
      'high',
      'Environment-specific job — targets staging/production',
    );
  }

  if (keyContains(jobKey, SECURITY_KEYWORDS)) {
    return makeRecommendation(
      false,
      'medium',
      'Security scanning — may require tokens or external access',
    );
  }

  if (keyContains(jobKey, UTILITY_KEYWORDS)) {
    return makeRecommendation(false, 'high', 'Utility job — not a CI check');
  }

  // ── Priority 4: Unsafe patterns (by command content) ──

  if (commandContainsAny(command, CREDENTIAL_COMMANDS)) {
    return makeRecommendation(
      false,
      'high',
      'Command requires external credentials or infrastructure access',
    );
  }

  if (commandContains(command, ENV_VAR_PATTERNS)) {
    return makeRecommendation(
      false,
      'medium',
      'Command uses CI environment variables — likely needs CI context',
    );
  }

  // ── Priority 5: Orchestration/setup steps ──

  if (keyContains(jobKey, ORCHESTRATION_KEYWORDS)) {
    return makeRecommendation(
      false,
      'medium',
      'Orchestration/setup step — not a standalone CI check',
    );
  }

  // ── Priority 6: Matrix variables ──

  if (hasMatrixVariables(command)) {
    return makeRecommendation(false, 'low', 'Uses CI matrix variables — complex CI configuration');
  }

  // ── Priority 7: Safe pattern detection ──

  const isLint = keyContains(jobKey, LINT_KEYWORDS);
  const isTest = keyContains(jobKey, TEST_KEYWORDS);
  const isTypecheck = keyContains(jobKey, TYPECHECK_KEYWORDS);

  if (isTypecheck) {
    return makeRecommendation(
      true,
      'high',
      'Type checking job — safe to delegate with no external dependencies',
    );
  }

  if (isLint) {
    return makeRecommendation(
      true,
      'high',
      'Linting job — safe to delegate with no external dependencies',
    );
  }

  if (isTest && isStandardTestRunner(command)) {
    return makeRecommendation(
      true,
      'medium',
      'Standard test runner detected — likely safe to delegate',
    );
  }

  if (isTest) {
    return makeRecommendation(
      true,
      'low',
      'Test-related job — review command to ensure no external dependencies',
    );
  }

  // ── Priority 8: Neutral/unknown ──

  // If it's a "check" keyword with a simple command
  if (jobKey.toLowerCase().includes('check') && command && command.split(' ').length <= 5) {
    return makeRecommendation(
      true,
      'low',
      'Check job with simple command — review before delegating',
    );
  }

  return makeRecommendation(
    false,
    'low',
    'Unable to determine safety — review manually before delegating',
  );
}

/**
 * Analyze all discovered jobs and attach recommendations.
 * Returns a new array with recommendation fields populated,
 * sorted by delegation priority.
 */
export function analyzeDiscoveredJobs(jobs: DiscoveredCiJob[]): DiscoveredCiJob[] {
  const analyzed = jobs.map((job) => ({
    ...job,
    recommendation: analyzeJob(job),
  }));

  return sortByRecommendation(analyzed);
}

/**
 * Sort discovered jobs by recommendation priority:
 * 1. Recommended (delegable, high/medium confidence)
 * 2. Needs review (low confidence either way)
 * 3. Not recommended (not delegable, high/medium confidence)
 */
function sortByRecommendation(jobs: DiscoveredCiJob[]): DiscoveredCiJob[] {
  return [...jobs].sort((a, b) => {
    const scoreA = recommendationSortScore(a);
    const scoreB = recommendationSortScore(b);
    return scoreA - scoreB;
  });
}

function recommendationSortScore(job: DiscoveredCiJob): number {
  const rec = job.recommendation;
  if (!rec) return 1; // Treat missing recommendation as "needs review"

  if (rec.delegable && rec.confidence !== 'low') return 0; // Recommended
  if (rec.confidence === 'low') return 1; // Needs review
  return 2; // Not recommended
}
