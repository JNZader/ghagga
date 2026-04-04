/**
 * GHAGGA Core Types
 *
 * These types define the contract between the core review engine
 * and all distribution adapters (server, CLI, action).
 */

// ─── Review Input ───────────────────────────────────────────────

export type ReviewMode = 'simple' | 'workflow' | 'consensus' | 'diagnostic' | 'fan-out';
export type LLMProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'github'
  | 'ollama'
  | 'qwen'
  | 'groq'
  | 'cerebras'
  | 'deepseek'
  | 'openrouter'
  | 'cli-bridge'
  | 'gateway';

/** Providers available in the SaaS dashboard (excludes Ollama) */
export type SaaSProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'github'
  | 'qwen'
  | 'groq'
  | 'cerebras'
  | 'deepseek'
  | 'openrouter'
  | 'cli-bridge'
  | 'gateway';

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

  /** Code intelligence metadata (present when enableCodeIntel is true). */
  codeIntelMetadata?: import('./code-intel/types.js').CodeIntelMetadata;

  /** Pipeline steps that failed but were gracefully degraded. Present when status is 'PARTIAL'. */
  failedSteps?: { step: string; error: string }[];
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
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
  github: 'gpt-4o-mini',
  ollama: 'qwen2.5-coder:7b',
  qwen: 'qwen-coder-plus',
  groq: 'llama-3.3-70b-versatile',
  cerebras: 'llama-3.3-70b',
  deepseek: 'deepseek-chat',
  openrouter: 'deepseek/deepseek-chat',
  'cli-bridge': 'auto',
  gateway: 'auto',
};
