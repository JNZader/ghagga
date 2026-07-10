/**
 * GHAGGA Core Types
 *
 * These types define the contract between the core review engine
 * and all distribution adapters (server, CLI, action).
 */

// ─── Re-exports from embed module ──────────────────────────────

export type { EmbeddingProvider, EmbeddingProviderFactory } from './embed.js';

// ─── Review Input ───────────────────────────────────────────────

export type ReviewMode = 'simple' | 'workflow' | 'consensus' | 'diagnostic' | 'fan-out';

/**
 * Supported LLM provider modes.
 * - gateway: delegates to mcp-llm-bridge (recommended for server/action)
 * - cli-bridge: calls local CLIs directly (Claude, OpenCode, Gemini, Copilot) — CLI only
 * - ollama: calls local Ollama instance directly (no subprocess, OpenAI-compatible)
 *
 * Migration: 'anthropic', 'openai', 'google', etc. → set provider: 'gateway' and
 * configure credentials in mcp-llm-bridge vault.
 */
export type LLMProvider = 'gateway' | 'cli-bridge' | 'ollama';

/** Providers available in the SaaS dashboard */
export type SaaSProvider = 'gateway' | 'cli-bridge' | 'ollama';

export type ReviewLevel = 'soft' | 'normal' | 'strict';

// ─── Provider Chain ─────────────────────────────────────────────

/**
 * A single entry in the provider fallback chain.
 * Used by the SaaS server to configure ordered LLM providers per repo.
 * The pipeline tries providers in array order, falling back on retryable errors.
 */
export interface ProviderChainEntry {
  /** LLM provider identifier */
  provider: SaaSProvider;

  /** Model identifier (e.g., "gpt-4o-mini") */
  model: string;

  /** Decrypted API key (populated at runtime by the server, never stored in plaintext) */
  apiKey: string;

  /** OpenCode model in `provider/model` format. Only meaningful when provider === 'cli-bridge'. */
  cliModel?: string;

  /** Gateway base URL. Only meaningful when provider === 'gateway'. */
  gatewayUrl?: string;

  /**
   * Bridge-side provider id to route to (e.g. 'codex-cli', 'cli-claude').
   * Forwarded to the gateway as `provider`, which short-circuits the bridge's
   * model-based routing and selects this provider directly regardless of model.
   * Only meaningful when provider === 'gateway'.
   */
  targetProvider?: string;
}

/**
 * Progress callback for pipeline steps.
 * Used by the CLI in --verbose mode to show real-time progress.
 */
export type ProgressCallback = (event: ProgressEvent) => void;

export interface ProgressEvent {
  /** Pipeline step identifier */
  step: string;

  /** Human-readable message */
  message: string;

  /** Optional details (e.g., specialist output, vote reasoning) */
  detail?: string;
}

export interface ReviewInput {
  /** The unified diff string from the PR or local changes */
  diff: string;

  /** Review mode to use */
  mode: ReviewMode;

  // ── Single provider (CLI/Action backward compat) ──────────

  /** Primary LLM provider (used when providerChain is not set) */
  provider?: LLMProvider;

  /** Model identifier (e.g., "claude-sonnet-4-20250514", "gpt-4o") */
  model?: string;

  /** Decrypted API key for the LLM provider */
  apiKey?: string;

  // ── Provider chain (SaaS mode) ────────────────────────────

  /**
   * Ordered list of providers to try. Index 0 = primary.
   * When set, takes precedence over provider/model/apiKey.
   */
  providerChain?: ProviderChainEntry[];

  /**
   * Whether AI review is enabled. Defaults to true.
   * When false, only static analysis tools run (no LLM calls).
   */
  aiReviewEnabled?: boolean;

  /** Tool and review configuration */
  settings: ReviewSettings;

  /** Optional context about the PR (not available in CLI mode) */
  context?: ReviewContext;

  /**
   * Memory storage backend for search and persist operations.
   * Undefined when memory is disabled or unavailable — pipeline degrades gracefully.
   */
  memoryStorage?: MemoryStorage;

  /**
   * Base URL for the local Ollama instance.
   * Only meaningful when provider === 'ollama'. Defaults to 'http://localhost:11434/v1'.
   */
  ollamaBaseURL?: string;

  /**
   * Optional progress callback for verbose/debug output.
   * Called at each pipeline step with status updates.
   */
  onProgress?: ProgressCallback;

  /**
   * Pre-computed static analysis results from an external runner (e.g., GitHub Actions).
   * When provided, the pipeline skips local tool execution and uses these results directly.
   * Undefined in CLI/Action modes where tools run locally.
   */
  precomputedStaticAnalysis?: StaticAnalysisResult;

  /**
   * Graph loader for blast-radius analysis.
   * Injected by the caller (SaaS: GitHubApiGraphLoader, CLI: SQLiteGraphLoader).
   * When undefined, blast-radius is skipped (current behavior).
   */
  graphLoader?: import('./graph/schema.js').GraphLoader;

  /**
   * File content reader for usage analysis.
   * Injected by the caller to read project source files.
   * When undefined, function-level usage analysis is skipped.
   */
  fileReader?: import('./exploitability/analyzer.js').FileReader;

  /** Enable AI-powered post-analysis enhancement. Default: false. */
  enhance?: boolean;

  /**
   * Code intelligence provider for structural queries via MCP.
   * Injected by the caller (connects to codedb, repoforge graph, etc.).
   * When undefined, code intelligence context is skipped (graceful degradation).
   */
  codeIntelProvider?: import('./code-intel/types.js').CodeIntelProvider;

  /**
   * Embedding provider for semantic features (hybrid search, semantic ranking, negative examples).
   * When undefined, all embedding-dependent features are skipped (graceful degradation).
   */
  embeddingProvider?: import('./embed.js').EmbeddingProvider;

  /**
   * PR author identifier (e.g. GitHub login or git author string).
   * Used by the author trust scoring feature when features.authorTrust is enabled.
   * When absent, trust scoring is skipped gracefully.
   */
  author?: string;

  /**
   * Feature flags for intelligence v2 capabilities.
   * Defaults: hybridSearch/semanticRanking auto-enable when embeddingProvider is set.
   */
  features?: {
    /** Enable hybrid BM25 + semantic vector search. Default: false (auto-enabled when embeddingProvider present). */
    hybridSearch?: boolean;
    /** Enable author trust-based finding prioritization. Default: false. */
    authorTrust?: boolean;
    /** Enable circuit breaker for LLM cascading failures. Default: true. */
    circuitBreaker?: boolean;
    /** Enable semantic re-ranking of findings. Default: false (auto-enabled when embeddingProvider present). */
    semanticRanking?: boolean;
    /** Enable negative example filtering (suppress known false positives). Default: false. */
    negativeExamples?: boolean;
  };
}

export interface ReviewSettings {
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string[];
  ignorePatterns: string[];
  reviewLevel: ReviewLevel;
  /** Force-enable specific tools (overrides auto-detect) */
  enabledTools?: string[];
  /** Force-disable specific tools (overrides always-on and auto-detect) */
  disabledTools?: string[];

  /** Enable blast-radius analysis using dependency graph. Default: false. */
  enableBlastRadius?: boolean;
  /** Max files in blast-radius before falling back to full diff. Default: 50. */
  maxBlastRadiusFiles?: number;
  /** Max traversal depth for dependency graph. Default: 3. */
  traversalDepth?: number;

  /** SOLID + boundary conditions review checklist configuration. */
  checklist?: import('./checklist/types.js').ChecklistConfig;

  /** Enable recursive review loop to validate suggested fixes. Default: false. */
  enableRecursiveReview?: boolean;
  /** Max re-review iterations for recursive review. Default: 2. */
  maxRecursiveIterations?: number;

  /** Lens names to use in fan-out mode (e.g., ["security", "wcag"]). */
  lenses?: string[];
  /** Path to directory containing custom lens JSON definitions. Default: .ghagga/lenses/ */
  lensDir?: string;

  /** Enable bidirectional code-doc validation. Default: false. */
  enableDocValidation?: boolean;

  /** Enable code intelligence structural context via MCP. Default: false. */
  enableCodeIntel?: boolean;
  /** Timeout in ms for code intelligence queries. Default: 5000. */
  codeIntelTimeout?: number;
  /** Max tokens for code intelligence context. Default: 1500. */
  codeIntelMaxTokens?: number;
  /** Max concurrent LLM calls in workflow/consensus modes. Default: 2. */
  reviewConcurrency?: number;
  /** Delay in ms between sequential LLM call batches. Default: 0. */
  reviewDelayMs?: number;

  /**
   * Path to the JSONL file for the self-improving review loop.
   * When set, past feedback is loaded and improvement rules are injected into agent prompts.
   * Default: undefined (feature disabled).
   */
  selfImprovePath?: string;
}

export interface ReviewContext {
  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;

  /** Pull request number */
  prNumber: number;

  /** Commit messages in the PR */
  commitMessages: string[];

  /** List of all file paths in the diff */
  fileList: string[];
}

// ─── Hypothesis Types (Diagnostic Mode) ────────────────────────

export type HypothesisConfidence = 'high' | 'medium' | 'low';

/**
 * A testable hypothesis about a potential bug or issue.
 * Generated by the diagnostic review mode.
 */
export interface Hypothesis {
  /** Hypothesis identifier (e.g., "H1", "H2") */
  id: string;

  /** Short description of what might be wrong */
  title: string;

  /** When/why this would fail — the conditions that trigger the bug */
  conditions: string;

  /** How to test or verify this hypothesis */
  verification: string;

  /** Confidence level based on evidence in the diff */
  confidence: HypothesisConfidence;

  /** Files related to this hypothesis */
  relatedFiles: string[];
}

// ─── Review Output ──────────────────────────────────────────────

export type ReviewStatus = 'PASSED' | 'FAILED' | 'NEEDS_HUMAN_REVIEW' | 'SKIPPED' | 'PARTIAL';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingSource = 'ai' | 'semgrep' | 'trivy' | 'cpd' | (string & {});

export interface ReviewResult {
  /** Overall review status */
  status: ReviewStatus;

  /** Human-readable summary (2-3 sentences) */
  summary: string;

  /** All findings from AI agents and static analysis */
  findings: ReviewFinding[];

  /** Static analysis results per tool */
  staticAnalysis: StaticAnalysisResult;

  /** Memory context that was injected into agent prompts (if any) */
  memoryContext: string | null;

  /** Execution metadata */
  metadata: ReviewMetadata;

  /** Whether AI enhance was applied to this result. */
  enhanced?: boolean;

  /** Metadata from the AI enhance pass (present when enhanced === true). */
  enhanceMetadata?: import('./enhance/types.js').EnhanceMetadata;

  /** Diagnostic hypotheses (present when mode === 'diagnostic'). */
  hypotheses?: Hypothesis[];

  /** Checklist scoring results (present when checklist is enabled). */
  checklistScore?: import('./checklist/scorer.js').ChecklistScoreResult;

  /** Recursive review report (present when enableRecursiveReview is true). */
  recursiveReview?: import('./recursive/types.js').RecursiveReviewReport;

  /** Doc-validation results (present when enableDocValidation is true). */
  docValidation?: import('./doc-validation/types.js').DocValidationResult;

  /**
   * Code intelligence metadata (present when enableCodeIntel is true).
   * `filesFailed` augments CodeIntelMetadata to report per-file query
   * failures (CORE-INTEL-003); optional for backward compatibility.
   */
  codeIntelMetadata?: import('./code-intel/types.js').CodeIntelMetadata & {
    filesFailed?: number;
  };

  /**
   * Entity-level semantic diff, computed in the enrich phase over the
   * FILTERED diff (settled in prepare, NEVER truncated — truncateDiff
   * writes the separate `truncatedDiff` field), so counts stay honest even
   * when the prompt diff was cut.
   *
   * Consumed by `formatReviewComment` for the "What changed" section.
   *
   * Serialization surface (precise truth):
   *   - NOT persisted: server `saveReview` stores discrete columns + the
   *     metadata blob, never top-level result fields.
   *   - NOT on the HTTP API: `toReviewDto` is an explicit pick-list.
   *   - DOES appear in full-result serializations — `ghagga review
   *     --format json` (apps/cli review.ts) and the ACP `review-result`
   *     artifact (acp/adapter.ts) both stringify the entire result. This
   *     is DELIBERATE (additive-optional field; those consumers already
   *     own the raw diff) and pinned by tests in apps/cli review.test.ts
   *     and acp/adapter.test.ts. The CLI JSON output is an observable
   *     contract — removing/renaming this field is a breaking change there.
   */
  semanticDiff?: import('./semantic-diff/index.js').SemanticDiff;

  /**
   * Pipeline steps that failed but were gracefully degraded. Present whenever
   * at least one TRACKED step degraded, REGARDLESS of status — a FAILED or
   * NEEDS_HUMAN_REVIEW review with degraded steps carries it too (only a
   * PASSED review is downgraded to PARTIAL; see pipeline/finalize.ts).
   *
   * NOT exhaustive: a few steps degrade warn-only (call-chain,
   * negative-examples, self-improve, semantic-diff) and never appear here —
   * they surface ONLY through `coverageComplete === false`.
   */
  failedSteps?: { step: string; error: string }[];

  /**
   * First-class coverage signal, ORTHOGONAL to the review verdict (`status`):
   * the verdict says what the review concluded; coverage says how much of the
   * pipeline actually ran to reach it.
   *
   *   - `true`      — every pipeline step ran (full coverage)
   *   - `false`     — at least one step degraded: either a tracked failure
   *                   (see `failedSteps`) OR a warn-only degradation
   *                   (call-chain, negative-examples, self-improve,
   *                   semantic-diff — internal
   *                   steps that never enter `failedSteps` and never trigger
   *                   the PARTIAL downgrade). The verdict stands but was
   *                   produced with incomplete coverage. `false` with an
   *                   absent `failedSteps` is therefore VALID: only warn-only
   *                   steps degraded.
   *   - `undefined` — not applicable: the pipeline never ran (e.g. SKIPPED
   *                   early-returns like flood-skip / all-files-filtered,
   *                   which short-circuit before the finalize phase)
   */
  coverageComplete?: boolean;
}

export interface ReviewFinding {
  /** Severity level */
  severity: FindingSeverity;

  /** Category (e.g., "security", "performance", "style", "bug") */
  category: string;

  /** File path relative to repo root */
  file: string;

  /** Line number (if applicable) */
  line?: number;

  /** Description of the finding */
  message: string;

  /** Suggested fix or improvement */
  suggestion?: string;

  /** Which tool or agent produced this finding */
  source: FindingSource;

  /** AI-assigned group ID (shared by related findings). */
  groupId?: string;

  /** AI-assigned priority score (1-10, where 10 = highest impact). */
  aiPriority?: number;

  /** Whether the AI flagged this as a likely false positive. */
  aiFiltered?: boolean;

  /** Reason for AI filtering (present when aiFiltered === true). */
  filterReason?: string;

  /** Exploitability label for CVE findings (present when exploitability analysis runs). */
  exploitability?: import('./exploitability/types.js').ExploitabilityLabel;

  /** Detailed exploitability analysis (present when exploitability analysis runs). */
  exploitabilityDetail?: import('./exploitability/types.js').ExploitabilityDetail;

  /** Function-level usage label for CVE findings (present when usage analysis runs). */
  usageLabel?: import('./exploitability/types.js').UsageLabel;

  /** Detailed usage analysis (present when usage analysis runs). */
  usageDetail?: import('./exploitability/types.js').UsageDetail;
}

export interface ReviewMetadata {
  /** Review mode used */
  mode: ReviewMode;

  /** LLM provider used (may differ from requested if fallback occurred). 'none' for static-only. */
  provider: LLMProvider | 'none';

  /** Model used. 'static-only' when AI review is disabled. */
  model: string;

  /** Total tokens consumed */
  tokensUsed: number;

  /** Total execution time in milliseconds */
  executionTimeMs: number;

  /** Static analysis tools that ran successfully */
  toolsRun: string[];

  /** Static analysis tools that were skipped or failed */
  toolsSkipped: string[];

  /** Blast-radius analysis results (present when enableBlastRadius is true). */
  blastRadius?: import('./graph/schema.js').BlastRadiusMetadata;

  /** Total additions across all diff files. */
  totalAdditions?: number;

  /** Total deletions across all diff files. */
  totalDeletions?: number;

  /** List of changed file paths (from the diff, after filtering). */
  fileList?: string[];

  /**
   * Models used per specialist/vote (workflow and consensus modes).
   * Format: ["scope-analysis:anthropic/claude-sonnet-4-20250514", ...]
   * Useful for debugging multi-provider distribution.
   */
  modelsUsed?: string[];
}

// ─── Static Analysis ────────────────────────────────────────────

export type ToolStatus = 'success' | 'skipped' | 'error' | 'timeout';

export interface ToolResult {
  /** Whether the tool ran successfully */
  status: ToolStatus;

  /** Findings from this tool */
  findings: ReviewFinding[];

  /** Error message if status is 'error' */
  error?: string;

  /** Execution time in milliseconds */
  executionTimeMs: number;
}

/** Legacy keys that are always guaranteed present */
interface LegacyStaticAnalysisResult {
  semgrep: ToolResult;
  trivy: ToolResult;
  cpd: ToolResult;
}

/**
 * Extensible static analysis result.
 * Legacy keys (semgrep, trivy, cpd) are always present for backward compat.
 * Additional tool keys are present when those tools ran.
 */
export type StaticAnalysisResult = LegacyStaticAnalysisResult & Record<string, ToolResult>;

// ─── Agent Types ────────────────────────────────────────────────

export type WorkflowSpecialist =
  | 'scope-analysis'
  | 'coding-standards'
  | 'error-handling'
  | 'security-audit'
  | 'performance-review';

export type ConsensusStance = 'for' | 'against' | 'neutral';

export interface ConsensusVote {
  /** Which provider cast this vote */
  provider: LLMProvider;

  /** Model used */
  model: string;

  /** Assigned stance */
  stance: ConsensusStance;

  /** Decision: approve, reject, or abstain */
  decision: 'approve' | 'reject' | 'abstain';

  /** Confidence level (0-1) */
  confidence: number;

  /** Reasoning for the decision */
  reasoning: string;
}

// ─── Memory Decay ──────────────────────────────────────────────

/**
 * Configuration for memory strength decay.
 * Observations not re-accessed lose strength over time:
 *   active (strength=1.0) → dormant → decaying → cleared (strength=0.0)
 */
export interface DecayConfig {
  /** Days after last access before decay begins. Default: 7 */
  dormancyDays: number;

  /** Days over which strength linearly drops from 1.0 to 0.0 (after dormancy). Default: 30 */
  decayDays: number;

  /** Days after last access at which strength reaches 0.0. Default: 90 */
  clearanceDays: number;

  /** Minimum strength to include in search results. Default: 0.1 */
  minStrength: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  dormancyDays: 7,
  decayDays: 30,
  clearanceDays: 90,
  minStrength: 0.1,
};

// ─── Memory Types ───────────────────────────────────────────────

export type ObservationType =
  | 'decision'
  | 'pattern'
  | 'bugfix'
  | 'learning'
  | 'architecture'
  | 'config'
  | 'discovery';

export interface MemoryObservation {
  /** Observation type */
  type: ObservationType;

  /** Concise title */
  title: string;

  /** Structured content (what happened, why it matters, what was learned) */
  content: string;

  /** Project identifier (e.g., "owner/repo") */
  project: string;

  /** Session ID this observation belongs to */
  sessionId?: number;

  /** Stable key for upsert (evolving knowledge) */
  topicKey?: string;

  /** Affected file paths */
  filePaths: string[];
}

/**
 * Abstract storage backend for the memory system.
 * Implemented by SqliteMemoryStorage (CLI/Action) and PostgresMemoryStorage (SaaS).
 */
export interface MemoryStorage {
  searchObservations(
    project: string,
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<MemoryObservationRow[]>;

  saveObservation(data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
    severity?: string;
  }): Promise<MemoryObservationRow>;

  createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }>;

  endSession(sessionId: number, summary: string): Promise<void>;

  /** Release resources. SQLite: export to disk. PostgreSQL: no-op. */
  close(): Promise<void>;

  // ── Management methods (this change) ──────────────────────────

  /** List observations with optional filtering and pagination. */
  listObservations(options?: ListObservationsOptions): Promise<MemoryObservationDetail[]>;

  /** Get a single observation by ID. Returns null if not found. */
  getObservation(id: number): Promise<MemoryObservationDetail | null>;

  /** Delete a single observation by ID. Returns true if deleted, false if not found. */
  deleteObservation(id: number): Promise<boolean>;

  /** Get aggregate statistics about the memory store. */
  getStats(): Promise<MemoryStats>;

  /** Delete all observations, optionally scoped to a project. Returns count of deleted rows. */
  clearObservations(options?: { project?: string }): Promise<number>;
}

/**
 * Subset of observation columns returned to consumers.
 * Both adapters map their full row type to this shape.
 */
export interface MemoryObservationRow {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  severity: string | null;

  /** Decay strength score (0.0–1.0). Present when decay is enabled, undefined otherwise. */
  strength?: number;
}

/**
 * Full observation row with all database columns.
 * Used by management commands (list, show, stats).
 * Extends MemoryObservationRow with metadata fields.
 */
export interface MemoryObservationDetail {
  id: number;
  type: string;
  title: string;
  content: string;
  filePaths: string[] | null;
  severity: string | null;
  project: string;
  topicKey: string | null;
  revisionCount: number;
  createdAt: string; // ISO 8601 from SQLite datetime()
  updatedAt: string; // ISO 8601 from SQLite datetime()
}

/**
 * Aggregate statistics about the memory store.
 * Used by the `ghagga memory stats` command.
 */
export interface MemoryStats {
  totalObservations: number;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  oldestObservation: string | null; // ISO 8601, null if empty
  newestObservation: string | null; // ISO 8601, null if empty
}

/**
 * Options for listing observations with filtering and pagination.
 */
export interface ListObservationsOptions {
  project?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

// ─── Memory Versioning ─────────────────────────────────────────

/**
 * A named branch in the memory versioning system.
 * Observations are scoped to branches, enabling isolated experimentation.
 */
export interface MemoryBranch {
  id: number;
  name: string;
  parentId: number | null;
  createdAt: string; // ISO 8601
}

/**
 * A named snapshot capturing the set of observation IDs at a point in time.
 * Used for rollback operations.
 */
export interface MemorySnapshot {
  id: number;
  name: string;
  branchId: number;
  observationIds: number[];
  createdAt: string; // ISO 8601
}

/**
 * A pair of contradicting observations detected during merge.
 * Both observations target the same file and category but suggest conflicting actions.
 */
export interface Contradiction {
  observationA: MemoryObservationRow;
  observationB: MemoryObservationRow;
  reason: string;
}

/**
 * Result of a branch merge operation.
 */
export interface MergeResult {
  /** IDs of observations successfully merged into the target branch. */
  merged: number[];

  /** Contradictions detected during merge (observations are still merged). */
  contradictions: Contradiction[];
}

/**
 * Configuration for the memory versioning system.
 */
export interface VersioningConfig {
  /** Similarity threshold for contradiction detection (0.0–1.0). Default: 0.5 */
  contradictionThreshold: number;
}

export const DEFAULT_VERSIONING_CONFIG: VersioningConfig = {
  contradictionThreshold: 0.5,
};

// ─── Intelligence v2 Types ──────────────────────────────────────

export type AuthorTrustTier = 'trusted' | 'standard' | 'new';

export interface AuthorTrustScore {
  author: string;
  /** Normalized trust score in the range [0, 1]. */
  score: number;
  tier: AuthorTrustTier;
  commitCount: number;
  firstSeenDaysAgo: number;
  lastUpdated: Date;
}

export interface NegativeExample {
  /** SHA256(filePath + lineRange + category) — uniquely identifies a suppressed finding location. */
  findingHash: string;
  /** SHA256(filePath) — identifies the file context for the suppression. */
  contextHash: string;
  category: string;
  reason?: string;
  createdAt: Date;
}

// ─── Audit Types ────────────────────────────────────────────────

export interface AuditInput {
  /** Path to the repository to audit */
  repoPath: string;

  /** Pre-formatted static analysis context (findings as string) */
  staticContext: string;

  /** LLM provider identifier */
  provider: string;

  /** Model identifier */
  model: string;

  /** Decrypted API key */
  apiKey: string;

  /**
   * Optional backend-agnostic generation function.
   * When provided, used instead of creating one from provider/model/apiKey.
   */
  generateFn?: import('./providers/generate-fn.js').GenerateTextFn;

  /** Optional progress callback for verbose/debug output. */
  onProgress?: (event: ProgressEvent) => void;
}

export type AuditStatus = 'completed' | 'no-findings' | 'error';

export interface AuditResult {
  /** Audit outcome */
  status: AuditStatus;

  /** Executive report from the LLM auditor */
  report: string;

  /** Raw static analysis findings passed to the auditor */
  findings: StaticAnalysisResult;

  /** ISO 8601 timestamp of when the audit ran */
  timestamp: string;

  /** Error message when status === 'error' */
  error?: string;
}

// ─── Configuration Defaults ─────────────────────────────────────

export const DEFAULT_SETTINGS: ReviewSettings = {
  enableSemgrep: true,
  enableTrivy: true,
  enableCpd: true,
  enableMemory: true,
  customRules: [],
  ignorePatterns: [
    '*.md',
    '*.txt',
    '.gitignore',
    'LICENSE',
    '*.lock',
    'package-lock.json',
    'pnpm-lock.yaml',
    'bun.lockb',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
    'go.sum',
  ],
  reviewLevel: 'normal',
  enabledTools: [],
  disabledTools: [],
};

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gateway: 'auto',
  'cli-bridge': 'auto',
  ollama: 'llama3',
};
