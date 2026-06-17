// Re-export all shared API types from the @ghagga/types package.
// Dashboard-only types (if any) can be added below.
export type {
  DayStats,
  Finding,
  Installation,
  InstallationSettings,
  LLMProvider,
  MemorySession,
  Observation,
  ProviderChainUpdate,
  ProviderChainView,
  RegisteredTool,
  Repository,
  RepositorySettings,
  Review,
  ReviewFinding,
  ReviewMode,
  ReviewStatus,
  ReviewsResponse,
  SaaSProvider,
  Stats,
  User,
  ValidationResponse,
  WorkflowInstallResult,
  WorkflowStatus,
} from '@ghagga/types';

// ─── Dashboard-only: issue-triage drafts (Phase 6) ──────────────
// The wire shape is owned by the server approval API
// (apps/server/src/routes/api/issue-drafts.ts → toDraftDto).

export const ISSUE_DRAFT_STATUSES = ['DRAFT', 'APPROVED', 'REJECTED', 'POSTED'] as const;
export type IssueDraftStatus = (typeof ISSUE_DRAFT_STATUSES)[number];

export const ISSUE_DRAFT_KINDS = ['ANALYSIS', 'DUPLICATE', 'NEEDS_INFO'] as const;
export type IssueDraftKind = (typeof ISSUE_DRAFT_KINDS)[number];

export interface IssueDraftSource {
  title: string;
  type: string;
  ref: string;
}

export interface IssueDedupMatch {
  observationId: number;
  title: string;
  score: number;
}

export interface IssueDraft {
  id: number;
  repositoryId: number;
  issueNumber: number;
  issueTitle: string;
  status: IssueDraftStatus;
  draftKind: IssueDraftKind;
  body: string;
  sources: IssueDraftSource[];
  dedupMatches: IssueDedupMatch[];
  tokensUsed: number;
  postedCommentId: number | null;
  createdAt: string;
  updatedAt: string;
}
