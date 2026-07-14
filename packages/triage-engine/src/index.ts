/**
 * ghagga-triage-engine — Public API
 *
 * Config-driven code-aware issue triage and reproduction engine. See
 * design.md for the full pipeline: config -> forge -> locate -> reproduce
 * (optional) -> triage (wraps ghagga-core runIssueTriage + client-reply
 * generation) -> queue (human-approval gate) -> forge post-back. `queue/`
 * (persistence/approval flow) and CLI/web wiring land in a later PR.
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

// ─── REPRODUCE ──────────────────────────────────────────────────

export type {
  AttachedEvidence,
  EvidenceCapablePage,
  ExecutableLocator,
  ExecutablePage,
  LoginContext,
  LoginLocator,
  LoginPage,
  LoginResult,
  ReproAction,
  SnapshotLocator,
  SnapshotPage,
} from './reproduce/index.js';
export {
  attachEvidenceListeners,
  buildActionLocator,
  captureScopedSnapshot,
  captureUIErrors,
  executeAction,
  isChromiumAvailable,
  PlaywrightNotInstalledError,
  parseAction,
  type ReproduceIssueInput,
  type ReproduceOptions,
  reproduce,
  runLoginRecipe,
} from './reproduce/index.js';

// ─── TRIAGE ─────────────────────────────────────────────────────

export {
  buildClientReplySystemPrompt,
  buildCodeContext,
  type ClientReplyInput,
  DEFAULT_JARGON_BAN,
  formatReproEvidence,
  generateClientReply,
  runTriage,
  type TriageIssueInput,
  type TriageRunInput,
  type TriageRunResult,
} from './triage/index.js';
