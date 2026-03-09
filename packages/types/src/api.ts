import type { DelegatedCiClassification, DelegatedCiRunState } from './delegated-ci.js';

// ─── Enums / Unions ─────────────────────────────────────────────

export type ReviewStatus = 'PASSED' | 'FAILED' | 'NEEDS_HUMAN_REVIEW' | 'SKIPPED';

export type ReviewMode = 'simple' | 'workflow' | 'consensus';

export type LLMProvider = 'anthropic' | 'openai' | 'google' | 'github' | 'ollama' | 'qwen';

/** Providers available in the SaaS dashboard (excludes Ollama) */
export type SaaSProvider = 'anthropic' | 'openai' | 'google' | 'github' | 'qwen';

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
}

/** Chain entry for updates (sent to PUT /api/settings) */
export interface ProviderChainUpdate {
  provider: SaaSProvider;
  model: string;
  apiKey?: string; // only sent when new/changed
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
  customRules: string;
  ignorePatterns: string[];
  enabledTools: string[];
  disabledTools: string[];
  registeredTools: RegisteredTool[];
  delegatedCiPolicy: DelegatedCiPolicyView | null;
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

// ─── Runner ─────────────────────────────────────────────────────

/** Response from GET /api/runner/status */
export interface RunnerStatus {
  exists: boolean;
  repoFullName?: string;
  isPrivate?: boolean;
  warning?: string;
}

/** Response from POST /api/runner/create */
export interface RunnerCreateResult {
  created: boolean;
  repoFullName: string;
  secretConfigured: boolean;
  isPrivate: boolean;
  warning?: string;
}

/** Response from POST /api/runner/configure-secret */
export interface RunnerConfigureResult {
  configured: boolean;
}

/** Error response from runner endpoints */
export interface RunnerError {
  error: string;
  message?: string;
  repoFullName?: string;
  retryAfter?: number;
}

// ─── Delegated CI ───────────────────────────────────────────────

/** API view of a repository's delegated CI policy (GET /api/repos/:id/delegated-ci) */
export interface DelegatedCiPolicyView {
  enabled: boolean;
  allowManualTrigger: boolean;
  allowPullRequestTrigger: boolean;
  jobs: Array<{
    jobKey: string;
    displayName: string;
    classification: DelegatedCiClassification;
    profile: string;
    enabled: boolean;
    allowArtifacts: false | string[];
    allowCache: boolean;
    maxDurationMinutes?: number;
    rationale?: string;
  }>;
}

/** API view of a delegated CI run */
export interface DelegatedCiRunView {
  id: number;
  repositoryId: number;
  prNumber: number | null;
  jobKey: string;
  classification: DelegatedCiClassification;
  state: DelegatedCiRunState;
  reasonCode: string | null;
  reasonDetail: string | null;
  profile: string;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** API response for listing delegated CI runs */
export interface DelegatedCiRunsResponse {
  runs: DelegatedCiRunView[];
  total: number;
}
