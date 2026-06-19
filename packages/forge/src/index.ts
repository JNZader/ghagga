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

export type { ForgeCredentialProvider } from './ports/credential-provider.js';
export type { ForgeWebhookCodec } from './ports/webhook-codec.js';

// ─── Registry ───────────────────────────────────────────────────

export type { ForgeRegistry, UnknownForgeErrorContext } from './registry.js';
export { MapForgeRegistry, UnknownForgeError } from './registry.js';

// ─── Identity helpers ───────────────────────────────────────────

export { repoRefEquals } from './ref.js';

// ─── Projection helpers ─────────────────────────────────────────

export { toCommitMessages, toFileList, toReviewContext } from './project.js';
