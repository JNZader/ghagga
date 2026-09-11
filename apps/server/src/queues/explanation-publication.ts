import type { ExplanationOutcome, ExplanationRequest } from 'ghagga-core';
import {
  deriveExplanationInvocationKey,
  EXPLANATION_PUBLICATION_CREATE_OUTCOMES,
  type ExplanationPublicationChannel,
  type ExplanationPublicationCreateReservation,
  type ExplanationPublicationCreateSettlement,
  type ExplanationPublicationPatchReservation,
  type ExplanationPublicationPatchSettlement,
  type reserveExplanationPublicationCreate,
  type reserveExplanationPublicationPatch,
  type settleExplanationPublicationCreate,
  type settleExplanationPublicationPatch,
} from 'ghagga-db';
import type { CommentId, ExplanationCommentLookup, ExplanationCommentRef } from 'ghagga-forge';

export const EXPLANATION_PUBLICATION_RESULT = {
  PUBLISHED: 'PUBLISHED',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  STALE: 'STALE',
  AMBIGUOUS: 'AMBIGUOUS',
} as const;
export type ExplanationPublicationResult =
  (typeof EXPLANATION_PUBLICATION_RESULT)[keyof typeof EXPLANATION_PUBLICATION_RESULT];

export const EXPLANATION_PUBLICATION_GUARD = {
  AUTHORIZED: 'AUTHORIZED',
  DISABLED: 'DISABLED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  STALE: 'STALE',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ExplanationPublicationGuardKind =
  (typeof EXPLANATION_PUBLICATION_GUARD)[keyof typeof EXPLANATION_PUBLICATION_GUARD];

export const EXPLANATION_PUBLICATION_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  CREATE_STARTED: 'CREATE_STARTED',
  PUBLISHED: 'PUBLISHED',
  PATCH_STARTED: 'PATCH_STARTED',
} as const;

interface NotStartedPublication {
  readonly status: typeof EXPLANATION_PUBLICATION_STATUS.NOT_STARTED;
  readonly version: number;
}
interface PublishedPublication {
  readonly status: typeof EXPLANATION_PUBLICATION_STATUS.PUBLISHED;
  readonly version: number;
  readonly commentId: number;
}
interface ReservedPublication {
  readonly status:
    | typeof EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED
    | typeof EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED;
  readonly version: number;
  readonly publicationFence: string;
  readonly commentId?: number;
}
type CurrentPublication = NotStartedPublication | PublishedPublication | ReservedPublication;

export interface AuthorizedExplanationPublicationGuard {
  readonly kind: typeof EXPLANATION_PUBLICATION_GUARD.AUTHORIZED;
  readonly currentHeadSha: string;
  readonly expectedBotAuthorId: number;
  readonly currentPublication: CurrentPublication;
  readonly reference: ExplanationCommentRef;
}
export interface RejectedExplanationPublicationGuard {
  readonly kind: Exclude<
    ExplanationPublicationGuardKind,
    typeof EXPLANATION_PUBLICATION_GUARD.AUTHORIZED
  >;
}
export type ExplanationPublicationGuard =
  | AuthorizedExplanationPublicationGuard
  | RejectedExplanationPublicationGuard;

export interface ExplanationPublicationInput {
  readonly request: ExplanationRequest;
  readonly outcome: ExplanationOutcome;
  readonly channel: ExplanationPublicationChannel;
  readonly body: string;
}
export interface ExplanationPublicationDependencies {
  readonly db: Parameters<typeof reserveExplanationPublicationCreate>[0];
  readonly guard: (
    request: ExplanationRequest,
    channel: ExplanationPublicationChannel,
  ) => Promise<ExplanationPublicationGuard>;
  readonly lookup: (reference: ExplanationCommentRef) => Promise<ExplanationCommentLookup>;
  readonly create: (reference: ExplanationCommentRef, body: string) => Promise<CommentId>;
  readonly update: (
    reference: ExplanationCommentRef,
    commentId: CommentId,
    body: string,
  ) => Promise<void>;
  readonly reserveCreate: typeof reserveExplanationPublicationCreate;
  readonly reservePatch: typeof reserveExplanationPublicationPatch;
  readonly settleCreate: typeof settleExplanationPublicationCreate;
  readonly settlePatch: typeof settleExplanationPublicationPatch;
}

interface CreateAction {
  readonly kind: 'CREATE';
  readonly guard: AuthorizedExplanationPublicationGuard;
}
interface PatchAction {
  readonly kind: 'PATCH';
  readonly guard: AuthorizedExplanationPublicationGuard;
  readonly commentId: CommentId;
  readonly databaseCommentId: number;
}
interface ReconcileAction {
  readonly kind: 'RECONCILE_CREATE' | 'RECONCILE_PATCH';
  readonly guard: AuthorizedExplanationPublicationGuard;
  readonly commentId: CommentId;
  readonly databaseCommentId: number;
}
type PublicationAction = CreateAction | PatchAction | ReconcileAction;
type ReservedCreate = Extract<ExplanationPublicationCreateReservation, { status: 'reserved' }>;
type ReservedPatch = Extract<ExplanationPublicationPatchReservation, { status: 'reserved' }>;

function isReservedPublication(
  publication: CurrentPublication,
): publication is ReservedPublication {
  return (
    publication.status === EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED ||
    publication.status === EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function toDatabaseCommentId(commentId: CommentId): number | null {
  return commentId.kind === 'github:issue-comment' && isPositiveSafeInteger(commentId.raw)
    ? commentId.raw
    : null;
}
function sameReference(left: ExplanationCommentRef, right: ExplanationCommentRef): boolean {
  return (
    left.forgeInstance === right.forgeInstance &&
    left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId &&
    left.changeRequest.iid === right.changeRequest.iid &&
    left.changeRequest.repo.kind === right.changeRequest.repo.kind &&
    left.changeRequest.repo.nativeId === right.changeRequest.repo.nativeId &&
    left.changeRequest.repo.path === right.changeRequest.repo.path &&
    left.ownerId === right.ownerId &&
    left.channel === right.channel &&
    left.invocationId === right.invocationId
  );
}
function hasExactTrustedReference(
  input: ExplanationPublicationInput,
  guard: AuthorizedExplanationPublicationGuard,
): boolean {
  const invocationId = deriveExplanationInvocationKey(input.request.identity);
  return (
    invocationId !== null &&
    guard.currentHeadSha === input.request.identity.requestedHeadSha &&
    isPositiveSafeInteger(guard.expectedBotAuthorId) &&
    guard.reference.forgeInstance === input.request.identity.forgeInstance &&
    guard.reference.installationId === input.request.identity.installationId &&
    guard.reference.repositoryId === input.request.identity.repositoryId &&
    guard.reference.changeRequest.iid === input.request.identity.pullRequestNumber &&
    guard.reference.changeRequest.repo.kind === 'github' &&
    guard.reference.changeRequest.repo.nativeId === input.request.identity.repositoryId &&
    guard.reference.channel === input.channel &&
    guard.reference.ownerId === String(guard.expectedBotAuthorId) &&
    guard.reference.invocationId === invocationId
  );
}
function isForbiddenOutcome(outcome: ExplanationOutcome): boolean {
  return outcome.kind === 'DISABLED' || outcome.kind === 'UNAUTHORIZED' || outcome.kind === 'STALE';
}

async function prepareInitialAction(
  input: ExplanationPublicationInput,
  dependencies: ExplanationPublicationDependencies,
): Promise<PublicationAction | null> {
  let guard: ExplanationPublicationGuard;
  try {
    guard = await dependencies.guard(input.request, input.channel);
  } catch {
    return null;
  }
  if (guard.kind !== EXPLANATION_PUBLICATION_GUARD.AUTHORIZED) return null;
  if (!hasExactTrustedReference(input, guard)) return null;
  if (!isNonNegativeSafeInteger(guard.currentPublication.version)) return null;
  let lookup: ExplanationCommentLookup;
  try {
    lookup = await dependencies.lookup(guard.reference);
  } catch {
    return null;
  }
  if (guard.currentPublication.status === EXPLANATION_PUBLICATION_STATUS.NOT_STARTED) {
    return lookup.kind === 'ABSENT' ? { kind: 'CREATE', guard } : null;
  }
  if (
    guard.currentPublication.status === EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED ||
    guard.currentPublication.status === EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED
  ) {
    if (lookup.kind !== 'FOUND' || !sameReference(lookup.reference, guard.reference)) return null;
    const databaseCommentId = toDatabaseCommentId(lookup.commentId);
    if (databaseCommentId === null) return null;
    if (
      guard.currentPublication.status === EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED &&
      guard.currentPublication.commentId !== undefined &&
      guard.currentPublication.commentId !== databaseCommentId
    ) {
      return null;
    }
    return {
      kind:
        guard.currentPublication.status === EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED
          ? 'RECONCILE_CREATE'
          : 'RECONCILE_PATCH',
      guard,
      commentId: lookup.commentId,
      databaseCommentId,
    };
  }
  if (guard.currentPublication.status !== EXPLANATION_PUBLICATION_STATUS.PUBLISHED) return null;
  if (lookup.kind !== 'FOUND' || !sameReference(lookup.reference, guard.reference)) return null;
  const databaseCommentId = toDatabaseCommentId(lookup.commentId);
  if (databaseCommentId === null || databaseCommentId !== guard.currentPublication.commentId)
    return null;
  return { kind: 'PATCH', guard, commentId: lookup.commentId, databaseCommentId };
}

function publicationVersion(
  reservation: ReservedCreate | ReservedPatch,
  channel: ExplanationPublicationChannel,
): number | null {
  const version =
    channel === 'progress'
      ? reservation.invocation.progressPublicationVersion
      : reservation.invocation.answerPublicationVersion;
  return isPositiveSafeInteger(version) ? version : null;
}
async function recheckReservedAction(
  input: ExplanationPublicationInput,
  dependencies: ExplanationPublicationDependencies,
  initial: PublicationAction,
  version: number,
  fence: string,
): Promise<boolean> {
  let guard: ExplanationPublicationGuard;
  try {
    guard = await dependencies.guard(input.request, input.channel);
  } catch {
    return false;
  }
  if (guard.kind !== EXPLANATION_PUBLICATION_GUARD.AUTHORIZED) return false;
  if (!hasExactTrustedReference(input, guard)) return false;
  const expectedStatus =
    initial.kind === 'CREATE'
      ? EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED
      : EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED;
  if (
    guard.currentPublication.status !== expectedStatus ||
    guard.currentPublication.version !== version ||
    guard.expectedBotAuthorId !== initial.guard.expectedBotAuthorId ||
    !sameReference(guard.reference, initial.guard.reference)
  ) {
    return false;
  }
  if (
    !isReservedPublication(guard.currentPublication) ||
    guard.currentPublication.publicationFence !== fence
  ) {
    return false;
  }
  return (
    initial.kind !== 'PATCH' || guard.currentPublication.commentId === initial.databaseCommentId
  );
}
function notPublished(channel: ExplanationPublicationChannel) {
  return { kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED, channel } as const;
}
function ambiguous(channel: ExplanationPublicationChannel) {
  return { kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS, channel } as const;
}
function published(channel: ExplanationPublicationChannel) {
  return { kind: EXPLANATION_PUBLICATION_RESULT.PUBLISHED, channel } as const;
}
async function settleCreate(
  input: ExplanationPublicationInput,
  dependencies: ExplanationPublicationDependencies,
  action: CreateAction,
  expectedPublicationVersion: number,
  publicationFence: string,
  outcome: 'ACKNOWLEDGED' | 'UNCERTAIN',
  commentId?: number,
): Promise<ExplanationPublicationCreateSettlement | null> {
  try {
    return await dependencies.settleCreate(dependencies.db, {
      ...input.request.identity,
      question: input.request.question,
      channel: input.channel,
      expectedPublicationVersion,
      expectedBotAuthorId: action.guard.expectedBotAuthorId,
      publicationFence,
      outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES[outcome],
      ...(commentId === undefined ? {} : { commentId }),
    });
  } catch {
    return null;
  }
}
async function settlePatch(
  input: ExplanationPublicationInput,
  dependencies: ExplanationPublicationDependencies,
  action: PatchAction,
  expectedPublicationVersion: number,
  publicationFence: string,
  outcome: 'ACKNOWLEDGED' | 'UNCERTAIN',
): Promise<ExplanationPublicationPatchSettlement | null> {
  try {
    return await dependencies.settlePatch(dependencies.db, {
      ...input.request.identity,
      question: input.request.question,
      channel: input.channel,
      expectedPublicationVersion,
      expectedBotAuthorId: action.guard.expectedBotAuthorId,
      commentId: action.databaseCommentId,
      publicationFence,
      outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES[outcome],
    });
  } catch {
    return null;
  }
}

export async function publishExplanationOutcome(
  input: ExplanationPublicationInput,
  dependencies: ExplanationPublicationDependencies,
) {
  if (input.body.trim().length === 0 || isForbiddenOutcome(input.outcome)) {
    return notPublished(input.channel);
  }
  const initial = await prepareInitialAction(input, dependencies);
  if (initial === null) return notPublished(input.channel);
  if (initial.kind === 'RECONCILE_CREATE' || initial.kind === 'RECONCILE_PATCH') {
    if (!isReservedPublication(initial.guard.currentPublication)) {
      return ambiguous(input.channel);
    }
    const version = initial.guard.currentPublication.version;
    const fence = initial.guard.currentPublication.publicationFence;
    const settled =
      initial.kind === 'RECONCILE_CREATE'
        ? await settleCreate(
            input,
            dependencies,
            { kind: 'CREATE', guard: initial.guard },
            version,
            fence,
            'ACKNOWLEDGED',
            initial.databaseCommentId,
          )
        : await settlePatch(
            input,
            dependencies,
            {
              kind: 'PATCH',
              guard: initial.guard,
              commentId: initial.commentId,
              databaseCommentId: initial.databaseCommentId,
            },
            version,
            fence,
            'ACKNOWLEDGED',
          );
    return settled?.status === 'settled' ? published(input.channel) : ambiguous(input.channel);
  }
  if (initial.kind === 'CREATE') {
    let reservation: ExplanationPublicationCreateReservation;
    try {
      reservation = await dependencies.reserveCreate(dependencies.db, {
        ...input.request.identity,
        question: input.request.question,
        channel: input.channel,
        expectedPublicationVersion: initial.guard.currentPublication.version,
        expectedBotAuthorId: initial.guard.expectedBotAuthorId,
      });
    } catch {
      return notPublished(input.channel);
    }
    if (reservation.status !== 'reserved') return notPublished(input.channel);
    const version = publicationVersion(reservation, input.channel);
    if (version === null) return ambiguous(input.channel);
    if (
      !(await recheckReservedAction(
        input,
        dependencies,
        initial,
        version,
        reservation.publicationFence,
      ))
    ) {
      await settleCreate(
        input,
        dependencies,
        initial,
        version,
        reservation.publicationFence,
        'UNCERTAIN',
      );
      return notPublished(input.channel);
    }
    let commentId: CommentId;
    try {
      commentId = await dependencies.create(initial.guard.reference, input.body);
    } catch {
      await settleCreate(
        input,
        dependencies,
        initial,
        version,
        reservation.publicationFence,
        'UNCERTAIN',
      );
      return ambiguous(input.channel);
    }
    const databaseCommentId = toDatabaseCommentId(commentId);
    if (databaseCommentId === null) {
      await settleCreate(
        input,
        dependencies,
        initial,
        version,
        reservation.publicationFence,
        'UNCERTAIN',
      );
      return ambiguous(input.channel);
    }
    const settled = await settleCreate(
      input,
      dependencies,
      initial,
      version,
      reservation.publicationFence,
      'ACKNOWLEDGED',
      databaseCommentId,
    );
    return settled?.status === 'settled' ? published(input.channel) : ambiguous(input.channel);
  }
  if (initial.kind !== 'PATCH') return notPublished(input.channel);
  let reservation: ExplanationPublicationPatchReservation;
  try {
    reservation = await dependencies.reservePatch(dependencies.db, {
      ...input.request.identity,
      question: input.request.question,
      channel: input.channel,
      expectedPublicationVersion: initial.guard.currentPublication.version,
      expectedBotAuthorId: initial.guard.expectedBotAuthorId,
      commentId: initial.databaseCommentId,
    });
  } catch {
    return notPublished(input.channel);
  }
  if (reservation.status !== 'reserved') return notPublished(input.channel);
  const version = publicationVersion(reservation, input.channel);
  if (version === null) return ambiguous(input.channel);
  if (
    !(await recheckReservedAction(
      input,
      dependencies,
      initial,
      version,
      reservation.publicationFence,
    ))
  ) {
    await settlePatch(
      input,
      dependencies,
      initial,
      version,
      reservation.publicationFence,
      'UNCERTAIN',
    );
    return notPublished(input.channel);
  }
  try {
    await dependencies.update(initial.guard.reference, initial.commentId, input.body);
  } catch {
    await settlePatch(
      input,
      dependencies,
      initial,
      version,
      reservation.publicationFence,
      'UNCERTAIN',
    );
    return ambiguous(input.channel);
  }
  const settled = await settlePatch(
    input,
    dependencies,
    initial,
    version,
    reservation.publicationFence,
    'ACKNOWLEDGED',
  );
  return settled?.status === 'settled' ? published(input.channel) : ambiguous(input.channel);
}
