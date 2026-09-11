import type { ExplanationOutcome, ExplanationRequest } from 'ghagga-core';
import {
  createDatabaseFromEnv,
  deriveExplanationInvocationKey,
  getEffectiveRepoSettings,
  getInstallationById,
  getRepositoryById,
  lookupExplanationInvocation,
  markExplanationPublicationStale,
  reserveExplanationPublicationCreate,
  reserveExplanationPublicationPatch,
  settleExplanationPublicationCreate,
  settleExplanationPublicationPatch,
} from 'ghagga-db';
import type { CommentId, ExplanationCommentLookup, ExplanationCommentRef } from 'ghagga-forge';
import {
  getCurrentExplanationActorAuthorization,
  getInstallationToken,
  resolveGitHubAppBotAuthorId,
} from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';
import type {
  ConfirmedPersistedExplanationOutcome,
  PersistedExplanationPublicationResult,
  PersistedExplanationPublisher,
} from './explanation.js';
import {
  EXPLANATION_PUBLICATION_GUARD,
  EXPLANATION_PUBLICATION_RESULT,
  EXPLANATION_PUBLICATION_STATUS,
  type ExplanationPublicationDependencies,
  type ExplanationPublicationGuard,
  publishExplanationOutcome,
} from './explanation-publication.js';

type Database = ReturnType<typeof createDatabaseFromEnv>;
type GitHubAdapter = ReturnType<typeof makeGitHubAdapter>;

export interface PersistedExplanationPublisherDependencies {
  readonly createDatabase?: () => Database;
  readonly lookupInvocation?: typeof lookupExplanationInvocation;
  readonly getRepository?: typeof getRepositoryById;
  readonly getInstallation?: typeof getInstallationById;
  readonly getEffectiveSettings?: typeof getEffectiveRepoSettings;
  readonly markStale?: typeof markExplanationPublicationStale;
  readonly mintInstallationToken?: typeof getInstallationToken;
  readonly resolveBotAuthorId?: typeof resolveGitHubAppBotAuthorId;
  readonly authorizeActor?: typeof getCurrentExplanationActorAuthorization;
  readonly createAdapter?: typeof makeGitHubAdapter;
  readonly reserveCreate?: typeof reserveExplanationPublicationCreate;
  readonly reservePatch?: typeof reserveExplanationPublicationPatch;
  readonly settleCreate?: typeof settleExplanationPublicationCreate;
  readonly settlePatch?: typeof settleExplanationPublicationPatch;
  readonly credentials?: () => { readonly appId?: string; readonly privateKey?: string };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseRepositoryName(value: string): { owner: string; repo: string } | null {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function sameIdentity(
  left: ExplanationRequest['identity'],
  right: ExplanationRequest['identity'],
): boolean {
  return (
    left.forgeInstance === right.forgeInstance &&
    left.installationId === right.installationId &&
    left.actorId === right.actorId &&
    left.repositoryId === right.repositoryId &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.requestedHeadSha === right.requestedHeadSha &&
    left.sourceCommentId === right.sourceCommentId &&
    left.questionHash === right.questionHash
  );
}

function sameOutcome(left: unknown, right: ExplanationOutcome): boolean {
  if (typeof left !== 'object' || left === null || Array.isArray(left)) return false;
  const candidate = left as Record<string, unknown>;
  if (candidate.kind !== right.kind) return false;
  if (right.kind === 'ANSWERED') {
    if (typeof candidate.answer !== 'string' || typeof candidate.metadata !== 'object')
      return false;
    const metadata = candidate.metadata;
    if (metadata === null || Array.isArray(metadata)) return false;
    const values = metadata as Record<string, unknown>;
    return (
      candidate.answer === right.answer &&
      values.provider === right.metadata.provider &&
      values.model === right.metadata.model &&
      values.tokensUsed === right.metadata.tokensUsed
    );
  }
  return candidate.reason === right.reason;
}

function isPublicationOutcome(outcome: ExplanationOutcome): boolean {
  return (
    outcome.kind === 'ANSWERED' ||
    outcome.kind === 'INVALID' ||
    outcome.kind === 'AI_UNAVAILABLE' ||
    outcome.kind === 'AMBIGUOUS'
  );
}

function rawAnswerBody(outcome: ExplanationOutcome): string | null {
  if (outcome.kind === 'ANSWERED') return outcome.answer;
  return isPublicationOutcome(outcome) ? outcome.reason : null;
}

function hasExactConfirmedInvocation(
  row: Record<string, unknown>,
  request: ExplanationRequest,
  outcome: ExplanationOutcome,
): boolean {
  const identity = request.identity;
  const expectedAnswer = outcome.kind === 'ANSWERED' ? outcome.answer : null;
  return (
    row.forgeInstance === identity.forgeInstance &&
    row.installationId === identity.installationId &&
    row.actorId === identity.actorId &&
    row.repositoryId === identity.repositoryId &&
    row.pullRequestNumber === identity.pullRequestNumber &&
    row.requestedHeadSha === identity.requestedHeadSha &&
    row.sourceCommentId === identity.sourceCommentId &&
    row.questionHash === identity.questionHash &&
    row.question === request.question &&
    row.executionStatus === outcome.kind &&
    row.outcomeStatus === outcome.kind &&
    row.outcomeAnswer === expectedAnswer &&
    row.outcomeCompletedAt !== null &&
    sameOutcome(row.outcomePayload, outcome)
  );
}

function currentAnswerPublication(row: Record<string, unknown>) {
  const status = row.answerPublicationStatus;
  const version = row.answerPublicationVersion;
  if (!isNonNegativeSafeInteger(version)) return null;
  if (status === EXPLANATION_PUBLICATION_STATUS.NOT_STARTED) {
    return { status, version } as const;
  }
  if (status === EXPLANATION_PUBLICATION_STATUS.PUBLISHED) {
    return isPositiveSafeInteger(row.answerCommentId)
      ? ({ status, version, commentId: row.answerCommentId } as const)
      : null;
  }
  if (
    (status === EXPLANATION_PUBLICATION_STATUS.CREATE_STARTED ||
      status === EXPLANATION_PUBLICATION_STATUS.PATCH_STARTED) &&
    typeof row.answerPublicationFence === 'string' &&
    row.answerPublicationFence.length > 0
  ) {
    return isPositiveSafeInteger(row.answerCommentId)
      ? ({
          status,
          version,
          publicationFence: row.answerPublicationFence,
          commentId: row.answerCommentId,
        } as const)
      : ({ status, version, publicationFence: row.answerPublicationFence } as const);
  }
  return null;
}

/**
 * Builds a server-local answer publication projection. Construction is inert;
 * every callback reloads credentials, repository policy, and trusted identity.
 */
export function createPersistedExplanationPublisher(
  overridesOrChannel: PersistedExplanationPublisherDependencies | 'answer' | 'progress' = {},
  channel = 'answer' as const,
): PersistedExplanationPublisher {
  const overrides = typeof overridesOrChannel === 'string' ? {} : overridesOrChannel;
  const publicationChannel = typeof overridesOrChannel === 'string' ? overridesOrChannel : channel;
  const createDatabase = overrides.createDatabase ?? createDatabaseFromEnv;
  const lookupInvocation = overrides.lookupInvocation ?? lookupExplanationInvocation;
  const getRepository = overrides.getRepository ?? getRepositoryById;
  const getInstallation = overrides.getInstallation ?? getInstallationById;
  const getEffectiveSettings = overrides.getEffectiveSettings ?? getEffectiveRepoSettings;
  const markStale = overrides.markStale ?? markExplanationPublicationStale;
  const mintInstallationToken = overrides.mintInstallationToken ?? getInstallationToken;
  const resolveBotAuthorId = overrides.resolveBotAuthorId ?? resolveGitHubAppBotAuthorId;
  const authorizeActor = overrides.authorizeActor ?? getCurrentExplanationActorAuthorization;
  const createAdapter = overrides.createAdapter ?? makeGitHubAdapter;
  const credentials = overrides.credentials ?? (() => process.env);

  return async function publishConfirmedExplanation(
    confirmed: ConfirmedPersistedExplanationOutcome,
  ): Promise<PersistedExplanationPublicationResult | undefined> {
    const body =
      publicationChannel === 'progress'
        ? `Explanation completed with outcome ${confirmed.outcome.kind}.`
        : rawAnswerBody(confirmed.outcome);
    if (body === null || !sameIdentity(confirmed.identity, confirmed.request.identity))
      return undefined;

    const db = createDatabase();
    let adapter: GitHubAdapter | undefined;
    const guard = async (): Promise<ExplanationPublicationGuard> => {
      const observed = await lookupInvocation(db, {
        ...confirmed.request.identity,
        question: confirmed.request.question,
      });
      if (
        observed.status !== 'found' ||
        !hasExactConfirmedInvocation(
          observed.invocation as unknown as Record<string, unknown>,
          confirmed.request,
          confirmed.outcome,
        )
      ) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }

      const repository = await getRepository(db, confirmed.repositoryDbId);
      const repositoryId = Number(confirmed.request.identity.repositoryId);
      if (
        !repository?.isActive ||
        !isPositiveSafeInteger(repositoryId) ||
        repository.githubRepoId !== repositoryId
      ) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      const installation = await getInstallation(db, repository.installationId);
      const installationId = Number(confirmed.request.identity.installationId);
      if (
        !installation?.isActive ||
        !isPositiveSafeInteger(installationId) ||
        installation.githubInstallationId !== installationId
      ) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      const repoName = parseRepositoryName(repository.fullName);
      if (!repoName) return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };

      const effective = await getEffectiveSettings(db, repository);
      if (!effective.settings.explanationsEnabled) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.DISABLED };
      }
      const currentCredentials = credentials();
      if (!currentCredentials.appId || !currentCredentials.privateKey) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }

      const token = await mintInstallationToken(
        installation.githubInstallationId,
        currentCredentials.appId,
        currentCredentials.privateKey,
        { repositoryIds: [repository.githubRepoId] },
      );
      const bot = await resolveBotAuthorId(
        currentCredentials.appId,
        currentCredentials.privateKey,
        token,
      );
      if (bot.kind !== 'RESOLVED' || !isPositiveSafeInteger(bot.id)) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      const authorization = await authorizeActor(
        repoName.owner,
        repoName.repo,
        confirmed.actorLogin,
        confirmed.request.identity.actorId,
        token,
      );
      if (authorization.kind === 'UNCERTAIN') {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      if (authorization.kind !== 'AUTHORIZED') {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAUTHORIZED };
      }

      adapter = createAdapter({
        owner: repoName.owner,
        repo: repoName.repo,
        token,
        explanationBinding: {
          forgeInstance: confirmed.request.identity.forgeInstance,
          installationId: confirmed.request.identity.installationId,
          repositoryId: confirmed.request.identity.repositoryId,
        },
      });
      const current = await adapter.fetchChangeRequest({
        repo: {
          kind: 'github',
          nativeId: confirmed.request.identity.repositoryId,
          path: repository.fullName,
        },
        iid: confirmed.request.identity.pullRequestNumber,
      });
      if (current.headSha !== confirmed.request.identity.requestedHeadSha) {
        const stale = await markStale(db, {
          ...confirmed.request.identity,
          question: confirmed.request.question,
          channel: publicationChannel,
        });
        return stale.status === 'stale'
          ? { kind: EXPLANATION_PUBLICATION_GUARD.STALE }
          : { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      const publication = currentAnswerPublication(
        observed.invocation as unknown as Record<string, unknown>,
      );
      const invocationId = deriveExplanationInvocationKey(confirmed.request.identity);
      if (publication === null || invocationId === null) {
        return { kind: EXPLANATION_PUBLICATION_GUARD.UNAVAILABLE };
      }
      const reference: ExplanationCommentRef = {
        forgeInstance: confirmed.request.identity.forgeInstance,
        installationId: confirmed.request.identity.installationId,
        repositoryId: confirmed.request.identity.repositoryId,
        changeRequest: {
          repo: {
            kind: 'github',
            nativeId: confirmed.request.identity.repositoryId,
            path: repository.fullName,
          },
          iid: confirmed.request.identity.pullRequestNumber,
        },
        ownerId: String(bot.id),
        channel: 'answer',
        invocationId,
      };
      return {
        kind: EXPLANATION_PUBLICATION_GUARD.AUTHORIZED,
        currentHeadSha: current.headSha,
        expectedBotAuthorId: bot.id,
        currentPublication: publication,
        reference,
      };
    };

    const lookup = async (reference: ExplanationCommentRef): Promise<ExplanationCommentLookup> => {
      if (!adapter?.lookupExplanationComment) {
        return { kind: 'INCOMPLETE', reason: 'Explanation publication capability is unavailable.' };
      }
      return adapter.lookupExplanationComment(reference);
    };
    const create = async (
      reference: ExplanationCommentRef,
      rawBody: string,
    ): Promise<CommentId> => {
      if (!adapter?.createExplanationComment) {
        throw new TypeError('Explanation publication capability is unavailable.');
      }
      return adapter.createExplanationComment(reference, rawBody);
    };
    const update = async (
      reference: ExplanationCommentRef,
      commentId: CommentId,
      rawBody: string,
    ): Promise<void> => {
      if (!adapter?.updateExplanationComment) {
        throw new TypeError('Explanation publication capability is unavailable.');
      }
      return adapter.updateExplanationComment(reference, commentId, rawBody);
    };
    let initialGuard: ExplanationPublicationGuard;
    try {
      initialGuard = await guard();
    } catch {
      return undefined;
    }
    if (initialGuard.kind === EXPLANATION_PUBLICATION_GUARD.STALE) {
      return { kind: EXPLANATION_PUBLICATION_RESULT.STALE, channel: publicationChannel };
    }
    let initialGuardAvailable = true;
    const dependencies: ExplanationPublicationDependencies = {
      db,
      guard: async () => {
        if (initialGuardAvailable) {
          initialGuardAvailable = false;
          return initialGuard;
        }
        return guard();
      },
      lookup,
      create,
      update,
      reserveCreate: overrides.reserveCreate ?? reserveExplanationPublicationCreate,
      reservePatch: overrides.reservePatch ?? reserveExplanationPublicationPatch,
      settleCreate: overrides.settleCreate ?? settleExplanationPublicationCreate,
      settlePatch: overrides.settlePatch ?? settleExplanationPublicationPatch,
    };
    return publishExplanationOutcome(
      {
        request: confirmed.request,
        outcome: confirmed.outcome,
        channel: publicationChannel,
        body,
      },
      dependencies,
    );
  };
}
