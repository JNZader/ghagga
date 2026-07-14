/**
 * ghagga-triage-engine — Public API
 *
 * Config-driven code-aware issue triage and reproduction engine. See
 * design.md for the full pipeline; this PR ships only the foundation:
 * config schema/loader + shared types (ReproEvidence, IssueDraft,
 * PostableReply). forge/locate/reproduce/triage/queue land in later PRs.
 */

// ─── Config ─────────────────────────────────────────────────────

export { loadConfig, type ResolveConfigPathOptions, resolveConfigPath } from './config/load.js';
export {
  type LoginRecipe,
  type LoginStep,
  type TriageConfig,
  TriageConfigSchema,
} from './config/schema.js';

// ─── Shared Types ───────────────────────────────────────────────

export type { DraftStatus, IssueDraft } from './types/draft.js';
export type { NetworkFailure, ReproEvidence } from './types/evidence.js';
export { approveDraft, type PostableReply } from './types/postable.js';

// ─── Forge Adapter ──────────────────────────────────────────────

export {
  createForgeAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  type ForgeAdapter,
  type ForgeAdapterConfig,
  type ForgeComment,
  type ForgeIssue,
  type ForgeIssueFilter,
} from './forge/index.js';

// ─── LOCATE ─────────────────────────────────────────────────────

export {
  DEFAULT_STOPWORDS,
  type ExpandOptions,
  expand,
  extractKeywords,
  firstHitLine,
  GRAPH_RESOLVABLE_LANGUAGES,
  type KeywordExtractionInput,
  type LocateIssueInput,
  type LocateResult,
  locate,
  type RerankIssueInput,
  rerankSeed,
  type ScoredCandidate,
  scoreCandidates,
  walkCodeScope,
} from './locate/index.js';
