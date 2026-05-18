// ─── Enums / Unions ─────────────────────────────────────────────

export type ReviewStatus = 'PASSED' | 'FAILED' | 'NEEDS_HUMAN_REVIEW' | 'SKIPPED';

export type ReviewMode = 'simple' | 'workflow' | 'consensus' | 'fan-out';

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

// ─── User ───────────────────────────────────────────────────────

export interface User {
  githubLogin: string;
  githubUserId: number;
  avatarUrl: string;
}

// ─── Reviews ────────────────────────────────────────────────────

export interface Review {
  id: number;
  repo: string;
  prNumber: number;
  status: ReviewStatus;
  mode: ReviewMode;
  summary: string;
  findings: Finding[];
  createdAt: string;
}

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
}

export interface ReviewsResponse {
  reviews: Review[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Stats ──────────────────────────────────────────────────────

export interface Stats {
  totalReviews: number;
  passed: number;
  failed: number;
  needsHumanReview: number;
  skipped: number;
  passRate: number;
  reviewsByDay: DayStats[];
}

export interface DayStats {
  date: string;
  total: number;
  passed: number;
  failed: number;
}

// ─── Repositories ───────────────────────────────────────────────

export interface Repository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  isActive: boolean;
}

// ─── Provider Chain ─────────────────────────────────────────────

/** View of a chain entry from the server (never includes raw keys) */
export interface ProviderChainView {
  provider: SaaSProvider;
  model: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
  /** OpenCode model in `provider/model` format. Only present for cli-bridge entries. */
  cliModel?: string;
  /** Gateway base URL. Only present for gateway entries. */
  gatewayUrl?: string;
}

/** Chain entry for updates (sent to PUT /api/settings) */
export interface ProviderChainUpdate {
  provider: SaaSProvider;
  model: string;
  apiKey?: string; // only sent when new/changed
  /** OpenCode model in `provider/model` format. Only meaningful when provider === 'cli-bridge'. */
  cliModel?: string;
  /** Gateway base URL. Only meaningful when provider === 'gateway'. */
  gatewayUrl?: string;
}

/** Provider validation response from POST /api/providers/validate */
export interface ValidationResponse {
  valid: boolean;
  models: string[];
  error?: string;
}

// ─── Installations ──────────────────────────────────────────────

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
}

// ─── Installation Settings (Global) ─────────────────────────────

export interface InstallationSettings {
  installationId: number;
  accountLogin: string;
  providerChain: ProviderChainView[];
  aiReviewEnabled: boolean;
  reviewMode: string;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  enableBlastRadius?: boolean;
  customRules: string;
  ignorePatterns: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  registeredTools?: RegisteredTool[];
}

// ─── Settings ───────────────────────────────────────────────────

/** Registered tool info returned by GET /api/settings */
export interface RegisteredTool {
  name: string;
  displayName: string;
  category: string;
  tier: 'always-on' | 'auto-detect';
}

export interface RepositorySettings {
  repoId: number;
  repoFullName: string;
  useGlobalSettings: boolean;
  aiReviewEnabled: boolean;
  providerChain: ProviderChainView[];
  reviewMode: ReviewMode;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  enableBlastRadius?: boolean;
  customRules: string;
  ignorePatterns: string[];
  enabledTools: string[];
  disabledTools: string[];
  registeredTools: RegisteredTool[];
  globalSettings?: InstallationSettings;
}

// ─── Memory ─────────────────────────────────────────────────────

export interface MemorySession {
  id: number;
  project: string;
  prNumber: number;
  summary: string;
  createdAt: string;
  observationCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
}

export interface Observation {
  id: number;
  sessionId: number;
  type: 'decision' | 'pattern' | 'bugfix' | 'learning' | 'architecture' | 'config' | 'discovery';
  title: string;
  content: string;
  filePaths: string[];
  severity: string | null;
  topicKey: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Workflow Installation ────────────────────────────────────────

/** Response from GET /api/runner/install-workflow/status/:owner/:repo */
export interface WorkflowStatus {
  installed: boolean;
  workflowInstalledAt: string | null;
  workflowSha: string | null;
}

/** Response from POST /api/runner/install-workflow/:owner/:repo */
export interface WorkflowInstallResult {
  installed: boolean;
  sha: string;
  created: boolean;
}
