// ─── Rule-Based CI Job Analysis ─────────────────────────────────
//
// Fast, deterministic analysis of discovered CI jobs to recommend
// whether each job is safe to delegate. No LLM calls, no external
// API calls -- pure pattern matching on job keys and commands.

// Local type definitions matching the shared @ghagga/types package.
// The server package does not directly depend on @ghagga/types,
// so we define compatible interfaces here.

type RecommendationConfidence = 'high' | 'medium' | 'low';

type DetectedLanguage = 'node' | 'python' | 'go' | 'jvm' | 'rust' | 'dotnet' | 'php';

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

// Commands that indicate a JVM/Gradle project
const JVM_COMMAND_PATTERNS = ['gradlew', 'gradle', 'mvn', 'maven'];

// Commands that indicate .NET
const DOTNET_COMMAND_PATTERNS = ['dotnet', 'msbuild'];

// Commands that indicate Rust
const RUST_COMMAND_PATTERNS = ['cargo', 'rustup'];

// Commands that indicate PHP
const PHP_COMMAND_PATTERNS = ['composer', 'artisan', 'phpunit', 'php -l'];

// Commands that indicate Go
const GO_COMMAND_PATTERNS = ['go test', 'go build', 'go run', 'golangci-lint'];

// Commands that indicate Node/TypeScript
const NODE_COMMAND_PATTERNS = ['npm', 'npx', 'yarn', 'pnpm', 'node ', 'tsc'];

// Commands that indicate Python
const PYTHON_COMMAND_PATTERNS = ['pytest', 'python', 'pip', 'ruff', 'flake8', 'mypy'];

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

// Lint-related job key patterns
const LINT_KEYWORDS = ['lint', 'eslint', 'biome', 'prettier', 'format', 'style', 'ruff', 'flake8'];

// Test-related job key patterns
const TEST_KEYWORDS = ['test', 'spec', 'jest', 'vitest', 'pytest', 'mocha'];

// Build-related job key patterns
const BUILD_KEYWORDS = ['build', 'compile', 'classes'];

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

function hasMatrixVariables(command: string | null): boolean {
  if (!command) return false;
  return command.includes('matrix.');
}

// ─── Language Detection ─────────────────────────────────────────

/**
 * Detect the target language from patterns in the job key.
 * This takes priority over command-based detection because job keys like
 * "test-csharp" clearly indicate the language even when the command
 * is a generic setup step (e.g. `chmod +x gradlew`).
 */
function detectLanguageFromJobKey(jobKey: string): DetectedLanguage | null {
  const lower = jobKey.toLowerCase();

  // JVM languages
  if (/(?:jvm|java|kotlin|gradle|maven)/.test(lower)) return 'jvm';

  // .NET / C#
  if (/(?:csharp|c-sharp|dotnet|\.net)/.test(lower)) return 'dotnet';

  // Go
  if (/(?:^|\W|-)(?:go|golang)(?:$|\W|-)/.test(lower)) return 'go';

  // Python
  if (/(?:python|py(?:test)?)/.test(lower)) return 'python';

  // PHP
  if (/(?:php|laravel)/.test(lower)) return 'php';

  // TypeScript / Node
  if (/(?:typescript|(?:^|\W|-)ts(?:$|\W|-)|node|npm|nestjs)/.test(lower)) return 'node';

  // Rust
  if (/(?:rust|axum|cargo)/.test(lower)) return 'rust';

  return null;
}

/**
 * Detect language from the command string.
 * Used as a fallback when the job key doesn't reveal the language.
 */
function detectLanguageFromCommand(command: string | null): DetectedLanguage | null {
  if (!command) return null;

  if (commandContains(command, JVM_COMMAND_PATTERNS)) return 'jvm';
  if (commandContains(command, DOTNET_COMMAND_PATTERNS)) return 'dotnet';
  if (commandContains(command, RUST_COMMAND_PATTERNS)) return 'rust';
  if (commandContains(command, PHP_COMMAND_PATTERNS)) return 'php';
  if (commandContains(command, GO_COMMAND_PATTERNS)) return 'go';
  if (commandContains(command, NODE_COMMAND_PATTERNS)) return 'node';
  if (commandContains(command, PYTHON_COMMAND_PATTERNS)) return 'python';

  return null;
}

// ─── Profile Suggestion ─────────────────────────────────────────

/**
 * Map a detected language + job type to the correct execution profile ID.
 */
function suggestProfile(
  language: DetectedLanguage,
  isTest: boolean,
  isBuild: boolean,
  isLint: boolean,
  command: string | null,
): string | null {
  const isMaven = commandContains(command, ['maven', 'mvn']);

  switch (language) {
    case 'jvm':
      if (isTest) return isMaven ? 'jvm-maven-test' : 'jvm-gradle-test';
      if (isBuild) return isMaven ? 'jvm-maven-build' : 'jvm-gradle-build';
      if (isLint) return isMaven ? 'jvm-maven-build' : 'jvm-gradle-build';
      // Default JVM jobs to gradle build
      return isMaven ? 'jvm-maven-build' : 'jvm-gradle-build';

    case 'dotnet':
      if (isTest) return 'dotnet-test';
      if (isBuild) return 'dotnet-build';
      if (isLint) return 'dotnet-build';
      return 'dotnet-build';

    case 'go':
      if (isTest) return 'go-test';
      if (isLint) return 'go-lint';
      return 'go-test';

    case 'python':
      if (isTest) return 'python-pytest';
      if (isLint) return 'python-lint';
      return 'python-pytest';

    case 'php':
      if (isTest) return 'php-test';
      if (isLint) return 'php-lint';
      return 'php-test';

    case 'node':
      if (isTest) return 'node-unit';
      if (isLint) return 'node-lint';
      return 'node-unit';

    case 'rust':
      if (isTest) return 'rust-test';
      if (isBuild) return 'rust-build';
      if (isLint) return 'rust-build';
      return 'rust-build';
  }
}

// ─── Empty/Trivial Command Check ────────────────────────────────

/**
 * Check if a command is empty or trivial.
 * A `chmod +x gradlew` is only trivial if we don't have a job-key-based
 * language override — callers pass the detected language to disambiguate.
 */
function isEmptyOrTrivialCommand(
  command: string | null,
  languageFromKey: DetectedLanguage | null,
): boolean {
  if (!command) return true;
  const trimmed = command.trim();
  if (trimmed === '' || trimmed === '|') return true;
  if (trimmed.startsWith('sleep')) return true;

  // `chmod +x gradlew` is only trivial when the job key does NOT
  // indicate a specific non-JVM language (Problem B fix)
  if (/^chmod\s+\+x\s+.*gradlew/.test(trimmed)) {
    // If the job key says it's for a specific language (e.g. test-csharp,
    // test-go), the real command comes later — this is just a setup step
    // but the job IS meaningful.
    if (languageFromKey !== null && languageFromKey !== 'jvm') return false;
    // If no language from key or it's JVM, treat as trivial setup
    if (languageFromKey === null) return true;
    // If key says JVM, this is a setup step for a JVM job — not trivial
    return false;
  }

  return false;
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

  // ── Step 0: Detect language from both job key and command ──
  const languageFromKey = detectLanguageFromJobKey(jobKey);
  const languageFromCommand = detectLanguageFromCommand(command);
  // Job key takes priority (fixes Problem B: test-csharp + gradlew)
  const detectedLanguage = languageFromKey ?? languageFromCommand;

  // ── Step 1: Job-type classification ──
  const isLint = keyContains(jobKey, LINT_KEYWORDS);
  const isTest = keyContains(jobKey, TEST_KEYWORDS);
  const isBuild = keyContains(jobKey, BUILD_KEYWORDS);
  const isTypecheck = keyContains(jobKey, TYPECHECK_KEYWORDS);

  // ── Priority 1: Empty/trivial command ──
  if (isEmptyOrTrivialCommand(command, languageFromKey)) {
    return makeRecommendation(false, 'high', 'No meaningful command detected — cannot delegate');
  }

  // ── Priority 2: Unsafe patterns (by job key) ──

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

  // ── Priority 3: Unsafe patterns (by command content) ──

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

  // ── Priority 4: Orchestration/setup steps ──

  if (keyContains(jobKey, ORCHESTRATION_KEYWORDS)) {
    return makeRecommendation(
      false,
      'medium',
      'Orchestration/setup step — not a standalone CI check',
    );
  }

  // ── Priority 5: Matrix variables ──

  if (hasMatrixVariables(command)) {
    return makeRecommendation(false, 'low', 'Uses CI matrix variables — complex CI configuration');
  }

  // ── Priority 6: Language-aware profile matching ──
  // If we detected a language, suggest the appropriate profile

  if (detectedLanguage) {
    const profile = suggestProfile(detectedLanguage, isTest, isBuild, isLint, command);

    if (isTypecheck) {
      return makeRecommendation(
        true,
        'high',
        'Type checking job — safe to delegate with no external dependencies',
        profile ?? 'node-lint',
      );
    }

    if (isLint) {
      return makeRecommendation(
        true,
        'high',
        'Linting job — safe to delegate with no external dependencies',
        profile,
      );
    }

    if (isTest) {
      return makeRecommendation(
        true,
        'medium',
        'Test job with matching execution profile — safe to delegate',
        profile,
      );
    }

    if (isBuild) {
      return makeRecommendation(
        true,
        'medium',
        'Build job with matching execution profile — safe to delegate',
        profile,
      );
    }

    // Language detected but no clear job type — still recommend with the profile
    return makeRecommendation(
      true,
      'low',
      'Detected language with matching profile — review before delegating',
      profile,
    );
  }

  // ── Priority 7: Safe pattern detection (no language detected) ──

  if (isTypecheck) {
    return makeRecommendation(
      true,
      'high',
      'Type checking job — safe to delegate with no external dependencies',
      'node-lint',
    );
  }

  if (isLint) {
    return makeRecommendation(
      true,
      'high',
      'Linting job — safe to delegate with no external dependencies',
      'node-lint',
    );
  }

  if (isTest) {
    return makeRecommendation(
      true,
      'low',
      'Test-related job — review command to ensure no external dependencies',
      'node-unit',
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
