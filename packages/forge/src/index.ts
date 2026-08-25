/**
 * ghagga-forge — Public API
 *
 * Forge-agnostic ports and canonical domain types. The core review engine and
 * the server talk to these abstractions instead of any concrete forge SDK.
 *
 * Architecture invariants (see individual files for detail):
 * - R-AGNOSTIC: `ghagga-core` MUST NOT import this package (value OR type).
 *   This package MAY import core in TYPE position only.
 * - R-PROJECTION / R-COMMENTID / R-CAPABILITY / R-RESOLVE / R-GRAPH are pinned
 *   by the types and the test suite.
 */

// ─── Domain types & enums ───────────────────────────────────────

export type {
  Actor,
  ActorKind,
  AuthorAssociation,
  ChangedFile,
  ChangeKind,
  ChangeRequest,
  ChangeRequestRef,
  CommentId,
  CommentMarker,
  Commit,
  DiffRefs,
  ForgeCapabilities,
  ForgeEvent,
  ForgeKind,
  NormalizedComment,
  PublishFailure,
  PublishReport,
  RepoRef,
  TenantHint,
  UnifiedDiff,
  UpsertSummaryResult,
} from './types.js';
export {
  ACTOR_KIND,
  AUTHOR_ASSOCIATION,
  CHANGE_KIND,
  FORGE_KIND,
} from './types.js';

// ─── Ports: forge adapter ───────────────────────────────────────

export type {
  FileReadCapable,
  ForgeAdapter,
  ForgeAdapterBase,
  GraphReadCapable,
  InlineCapable,
  InlineComment,
  MarkerExtractable,
  ReactionCapable,
  ReactionKind,
} from './ports/forge-adapter.js';
export { REACTION_KIND } from './ports/forge-adapter.js';

// ─── Ports: CI runner ───────────────────────────────────────────

export type {
  CiDispatchRequest,
  CiDispatchResult,
  CiRunner,
  EnsureWorkflowResult,
} from './ports/ci-runner.js';

// ─── Ports: credentials & webhooks ──────────────────────────────

// ─── Errors ─────────────────────────────────────────────────────
// ForgeAuthError + isForgeAuthError: the typed 401/403 signal the worker catches
// to drive the in-job credential re-mint + retry (P2 401-recovery seam).
export { FORGE_AUTH_STATUSES, ForgeAuthError, getErrorStatus, isForgeAuthError } from './errors.js';
export type { ForgeCredentialProvider } from './ports/credential-provider.js';
export type { ForgeWebhookCodec } from './ports/webhook-codec.js';

// ─── Registry ───────────────────────────────────────────────────

export type { ForgeRegistry, UnknownForgeErrorContext } from './registry.js';
export { MapForgeRegistry, UnknownForgeError } from './registry.js';

// ─── Adapters: GitHub ───────────────────────────────────────────

// Credential providers (real, P2 — replace the P1 temporary source).
// GitHubAppCredentialProvider: TTL-cached/singleflight installation-token source
// for the server worker. StaticTokenProvider: fixed-token source for the CLI/
// GitLab path. Both satisfy ForgeCredentialProvider so the auth strategy is a
// pure construction-site choice (R-TOKEN provider-swap).
export type { GitHubAppCredentialProviderDeps } from './adapters/github/github-app-credential-provider.js';
export {
  BUDGET_SECONDS,
  GitHubAppCredentialProvider,
  SKEW_SECONDS,
} from './adapters/github/github-app-credential-provider.js';
export type {
  GitHubClientPort,
  GitHubInstallationTokenMintWithExpiry,
  GitHubReactionContent,
  MintedInstallationToken,
} from './adapters/github/github-client-port.js';
export type { GitHubForgeAdapterDeps } from './adapters/github/github-forge-adapter.js';
export { GitHubForgeAdapter } from './adapters/github/github-forge-adapter.js';
export { StaticTokenProvider } from './adapters/github/static-token-provider.js';

// ─── Adapters: GitLab (P4 — CLI-invoked summary-comment + inline notes) ──
// GitLabForgeAdapter: forge-neutral MR summary post-back (find-by-marker →
// delete-stale → repost) + InlineCapable publishInline (N independent notes,
// partial-failure first-class). Reaches the SAME ForgeAdapterBase seam the CLI
// post-back routes through, so `--mr` reuses the P3 plumbing unchanged.
export type {
  GitLabClientPort,
  GitLabDiffPosition,
  GitLabNote,
} from './adapters/gitlab/gitlab-client-port.js';
export type { GitLabForgeAdapterDeps } from './adapters/gitlab/gitlab-forge-adapter.js';
export { GitLabForgeAdapter } from './adapters/gitlab/gitlab-forge-adapter.js';

// ─── Identity helpers ───────────────────────────────────────────

// ─── Comment-id boxing (R-COMMENTID) ────────────────────────────
// Sanctioned, side-effect-free boxing helper reusable by both the server
// worker and the P3 CLI (the adapter still RETURNS native numbers; this is the
// caller-local boxing step, NOT a branding of the adapter return type).
export { githubCommentId, gitlabCommentId } from './comment-id.js';
export { repoRefEquals } from './ref.js';

// ─── Projection helpers ─────────────────────────────────────────

export { toCommitMessages, toFileList, toReviewContext } from './project.js';
