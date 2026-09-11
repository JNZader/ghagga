import { createHash } from 'node:crypto';
import type { ConnectionOptions, Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import {
  EXPLANATION_OUTCOME,
  type ExplanationOutcome,
  type ExplanationRequest,
  type ExplanationSnapshot,
  generateExplanation,
  resolveExplanationGenerateFn,
} from 'ghagga-core';
import type { ExplanationPublicationChannel } from 'ghagga-db';
import {
  createDatabaseFromEnv,
  decrypt,
  getEffectiveRepoSettings,
  getInstallationById,
  getRepositoryById,
  lookupExplanationInvocation,
  recoverExpiredExplanationInvocationDispatch,
  reserveExplanationInvocationDispatch,
  settleExplanationInvocation,
} from 'ghagga-db';
import { getCurrentExplanationActorAuthorization, getInstallationToken } from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';
import { createRedisClient } from '../lib/redis.js';
import type { ExplanationPublicationResult } from './explanation-publication.js';

export const EXPLANATION_INGRESS_OUTCOME = {
  ACCEPTED: 'ACCEPTED',
  INVALID: 'INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type ExplanationIngressOutcome =
  (typeof EXPLANATION_INGRESS_OUTCOME)[keyof typeof EXPLANATION_INGRESS_OUTCOME];

export interface AcceptedExplanationIngress {
  readonly kind: typeof EXPLANATION_INGRESS_OUTCOME.ACCEPTED;
  readonly request: ExplanationRequest;
  readonly reason?: never;
}

export interface RejectedExplanationIngress {
  readonly kind: Exclude<ExplanationIngressOutcome, typeof EXPLANATION_INGRESS_OUTCOME.ACCEPTED>;
  readonly reason: string;
  readonly request?: never;
}

export type ExplanationIngress = AcceptedExplanationIngress | RejectedExplanationIngress;

export interface ExplanationProcessorDependencies {
  readonly lookup: (
    request: ExplanationRequest,
  ) => Promise<'PENDING' | 'RESERVED' | 'TERMINAL' | 'MISSING' | 'MISMATCH'>;
  readonly enabled: () => Promise<boolean>;
  readonly authorize: () => Promise<'AUTHORIZED' | 'UNAUTHORIZED' | 'UNCERTAIN'>;
  readonly currentHead: () => Promise<string | null>;
  readonly reserve: () => Promise<boolean>;
  readonly settle: (outcome: ExplanationOutcome) => Promise<void>;
  readonly generate: Parameters<typeof generateExplanation>[2];
}

/**
 * Processes only an already-acquired immutable explanation. Queue wiring and
 * publication are deliberately separate so retries cannot regenerate output.
 */
export async function processExplanation(
  request: ExplanationRequest,
  snapshot: ExplanationSnapshot,
  dependencies: ExplanationProcessorDependencies,
): Promise<ExplanationOutcome | null> {
  const observed = await dependencies.lookup(request);
  if (observed !== 'PENDING') return null;
  if (!(await dependencies.enabled())) {
    const outcome: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.DISABLED,
      reason: 'Explanations are disabled.',
    };
    await dependencies.settle(outcome);
    return outcome;
  }
  const authorization = await dependencies.authorize();
  if (authorization !== 'AUTHORIZED') {
    if (authorization === 'UNCERTAIN') return null;
    const outcome: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.UNAUTHORIZED,
      reason: 'Current actor authorization was denied.',
    };
    await dependencies.settle(outcome);
    return outcome;
  }
  const head = await dependencies.currentHead();
  if (head !== request.identity.requestedHeadSha) {
    const outcome: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.STALE,
      reason: 'The requested pull-request revision is stale.',
    };
    await dependencies.settle(outcome);
    return outcome;
  }
  if (!(await dependencies.reserve())) return null;
  try {
    const outcome = await generateExplanation(request, snapshot, dependencies.generate);
    await dependencies.settle(outcome);
    return outcome;
  } catch {
    const outcome: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.AMBIGUOUS,
      reason: 'Explanation generation completion is unknown.',
    };
    await dependencies.settle(outcome);
    return outcome;
  }
}

const EXPLANATION_DISPATCH_LEASE_MS = 300_000;

export interface PersistedExplanationProcessorInput {
  readonly repositoryDbId: number;
  readonly actorLogin: string;
  readonly request: ExplanationRequest;
  readonly snapshot: ExplanationSnapshot;
}

export interface ConfirmedPersistedExplanationOutcome {
  readonly identity: ExplanationRequest['identity'];
  readonly request: ExplanationRequest;
  readonly repositoryDbId: number;
  readonly actorLogin: string;
  readonly outcome: ExplanationOutcome;
}

export interface PersistedExplanationPublicationResult {
  readonly kind: ExplanationPublicationResult;
  readonly channel: ExplanationPublicationChannel;
}

export type PersistedExplanationPublisher = (
  confirmed: ConfirmedPersistedExplanationOutcome,
) => Promise<PersistedExplanationPublicationResult | undefined>;

export interface PersistedExplanationProcessorOptions {
  /**
   * Process-local extension seam. It is intentionally absent from BullMQ data
   * and worker creation, so publication remains inactive until composition
   * supplies a trusted publisher.
   */
  readonly publisher?: PersistedExplanationPublisher;
  readonly progressPublisher?: PersistedExplanationPublisher;
}

/**
 * Immutable data handed from webhook admission to the explanation worker.
 * Credentials and provider configuration are deliberately reloaded by the
 * persisted processor rather than being retained in Redis.
 */
export interface ExplanationJobData {
  readonly invocationKey: string;
  readonly repositoryDbId: number;
  readonly actorLogin: string;
  readonly request: ExplanationRequest;
  readonly snapshot: ExplanationSnapshot;
}

let explanationQueue:
  | Queue<ExplanationJobData, unknown, string, ExplanationJobData, unknown, string>
  | undefined;

/**
 * BullMQ and the application currently resolve different ioredis patch
 * versions. The runtime client is compatible, but TypeScript rejects the
 * duplicated class declarations because one contains a protected member.
 */
function asBullMQConnection(client: ReturnType<typeof createRedisClient>): ConnectionOptions {
  const value: unknown = client;
  return value as ConnectionOptions;
}

function getExplanationQueue(): Queue<
  ExplanationJobData,
  unknown,
  string,
  ExplanationJobData,
  unknown,
  string
> {
  if (!explanationQueue) {
    explanationQueue = new Queue<
      ExplanationJobData,
      unknown,
      string,
      ExplanationJobData,
      unknown,
      string
    >('explanation', {
      connection: asBullMQConnection(createRedisClient()),
    });
  }
  return explanationQueue;
}

/**
 * Enqueues one immutable explanation invocation without retry policy. The
 * durable invocation key is the BullMQ identity, so duplicate enqueue calls
 * address the same job rather than inventing a second model execution.
 */
export async function enqueueExplanation(
  data: ExplanationJobData,
): Promise<Job<ExplanationJobData, unknown, string>> {
  return getExplanationQueue().add('process-explanation', data, {
    jobId: data.invocationKey,
    attempts: 1,
  });
}

/** Creates, but does not start or register, an explanation queue worker. */
export function createExplanationWorker(
  concurrency = 1,
  options: PersistedExplanationProcessorOptions = {},
): Worker<ExplanationJobData, unknown, string> {
  return new Worker<ExplanationJobData, unknown, string>(
    'explanation',
    (job) => processPersistedExplanation(job.data, options),
    {
      connection: asBullMQConnection(createRedisClient()),
      concurrency,
    },
  );
}

type ExplanationInvocationRequest = Parameters<typeof lookupExplanationInvocation>[1];

function toExplanationInvocationRequest(request: ExplanationRequest): ExplanationInvocationRequest {
  return {
    ...request.identity,
    question: request.question,
  };
}

function nonAnswer(kind: Exclude<ExplanationOutcome['kind'], 'ANSWERED'>, reason: string) {
  return { kind, reason } as const;
}

function replayPersistedOutcome(value: unknown): ExplanationOutcome | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === EXPLANATION_OUTCOME.ANSWERED) {
    const metadata = candidate.metadata;
    if (
      typeof candidate.answer !== 'string' ||
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      return null;
    }
    const parsedMetadata = metadata as Record<string, unknown>;
    if (
      typeof parsedMetadata.provider !== 'string' ||
      typeof parsedMetadata.model !== 'string' ||
      typeof parsedMetadata.tokensUsed !== 'number'
    ) {
      return null;
    }
    return {
      kind: EXPLANATION_OUTCOME.ANSWERED,
      answer: candidate.answer,
      metadata: {
        provider: parsedMetadata.provider,
        model: parsedMetadata.model,
        tokensUsed: parsedMetadata.tokensUsed,
      },
    };
  }
  if (
    [
      EXPLANATION_OUTCOME.INVALID,
      EXPLANATION_OUTCOME.UNAUTHORIZED,
      EXPLANATION_OUTCOME.DISABLED,
      EXPLANATION_OUTCOME.STALE,
      EXPLANATION_OUTCOME.AI_UNAVAILABLE,
      EXPLANATION_OUTCOME.AMBIGUOUS,
    ].includes(candidate.kind as Exclude<ExplanationOutcome['kind'], 'ANSWERED'>) &&
    typeof candidate.reason === 'string'
  ) {
    return nonAnswer(
      candidate.kind as Exclude<ExplanationOutcome['kind'], 'ANSWERED'>,
      candidate.reason,
    );
  }
  return null;
}

function parseRepositoryName(value: string): { owner: string; repo: string } | null {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

async function settlePendingOutcome(
  db: ReturnType<typeof createDatabaseFromEnv>,
  request: ExplanationInvocationRequest,
  outcome: ExplanationOutcome,
): Promise<boolean> {
  const result = await settleExplanationInvocation(db, {
    ...request,
    expectedExecutionStatus: 'PENDING',
    outcome,
  });
  return result.status === 'settled';
}

async function settleReservedOutcome(
  db: ReturnType<typeof createDatabaseFromEnv>,
  request: ExplanationInvocationRequest,
  executionFence: string,
  outcome: ExplanationOutcome,
): Promise<boolean> {
  const result = await settleExplanationInvocation(db, {
    ...request,
    expectedExecutionStatus: 'DISPATCH_RESERVED',
    executionFence,
    outcome,
  });
  return result.status === 'settled';
}

async function notifyConfirmedPublisher(
  publisher: PersistedExplanationProcessorOptions['publisher'],
  input: PersistedExplanationProcessorInput,
  outcome: ExplanationOutcome,
): Promise<void> {
  if (!publisher) return;
  await publisher({
    identity: input.request.identity,
    request: input.request,
    repositoryDbId: input.repositoryDbId,
    actorLogin: input.actorLogin,
    outcome,
  });
}

async function notifyConfirmedPublishers(
  options: PersistedExplanationProcessorOptions,
  input: PersistedExplanationProcessorInput,
  outcome: ExplanationOutcome,
): Promise<void> {
  if (options.progressPublisher) {
    await options.progressPublisher({
      identity: input.request.identity,
      request: input.request,
      repositoryDbId: input.repositoryDbId,
      actorLogin: input.actorLogin,
      outcome,
    });
  }
  await notifyConfirmedPublisher(options.publisher, input, outcome);
}

/**
 * Executes an immutable explanation through the real persistence and GitHub
 * composition boundaries. It never creates a missing invocation, reacquires a
 * snapshot, retries a model request, or falls back to review processing.
 */
export async function processPersistedExplanation(
  input: PersistedExplanationProcessorInput,
  options: PersistedExplanationProcessorOptions = {},
): Promise<ExplanationOutcome | null> {
  const db = createDatabaseFromEnv();
  const invocationRequest = toExplanationInvocationRequest(input.request);
  const observed = await lookupExplanationInvocation(db, invocationRequest);
  if (observed.status !== 'found') return null;

  if (observed.invocation.executionStatus !== 'PENDING') {
    if (observed.invocation.executionStatus !== 'DISPATCH_RESERVED') {
      const outcome = replayPersistedOutcome(observed.invocation.outcomePayload);
      if (outcome) await notifyConfirmedPublishers(options, input, outcome);
      return outcome;
    }
    if (typeof observed.invocation.executionFence !== 'string') return null;
    const recovered = await recoverExpiredExplanationInvocationDispatch(db, {
      ...invocationRequest,
      executionFence: observed.invocation.executionFence,
    });
    return recovered.status === 'recovered'
      ? replayPersistedOutcome(recovered.invocation.outcomePayload)
      : null;
  }

  const repository = await getRepositoryById(db, input.repositoryDbId);
  const repositoryIdentity = Number(input.request.identity.repositoryId);
  if (
    !repository?.isActive ||
    !isPositiveSafeInteger(repositoryIdentity) ||
    repository.githubRepoId !== repositoryIdentity
  ) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.INVALID,
      'The durable repository identity no longer matches this explanation request.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const installation = await getInstallationById(db, repository.installationId);
  const installationIdentity = Number(input.request.identity.installationId);
  if (
    !installation?.isActive ||
    !isPositiveSafeInteger(installationIdentity) ||
    installation.githubInstallationId !== installationIdentity
  ) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.INVALID,
      'The durable installation identity no longer matches this explanation request.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const repoName = parseRepositoryName(repository.fullName);
  if (!repoName) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.INVALID,
      'The durable repository name is invalid.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const effective = await getEffectiveRepoSettings(db, repository);
  if (!effective.settings.explanationsEnabled) {
    const outcome = nonAnswer(EXPLANATION_OUTCOME.DISABLED, 'Explanations are disabled.');
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.AI_UNAVAILABLE,
      'GitHub App credentials are unavailable for explanation validation.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  let token: string;
  try {
    token = await getInstallationToken(installation.githubInstallationId, appId, privateKey, {
      repositoryIds: [repository.githubRepoId],
    });
  } catch {
    return null;
  }

  const authorization = await getCurrentExplanationActorAuthorization(
    repoName.owner,
    repoName.repo,
    input.actorLogin,
    input.request.identity.actorId,
    token,
  );
  if (authorization.kind === 'UNCERTAIN') return null;
  if (authorization.kind !== 'AUTHORIZED') {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.UNAUTHORIZED,
      'Current actor authorization was denied.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  let currentHead: string;
  try {
    const adapter = makeGitHubAdapter({ owner: repoName.owner, repo: repoName.repo, token });
    const changeRequest = await adapter.fetchChangeRequest({
      repo: {
        kind: 'github',
        nativeId: input.request.identity.repositoryId,
        path: repository.fullName,
      },
      iid: input.request.identity.pullRequestNumber,
    });
    currentHead = changeRequest.headSha;
  } catch {
    return null;
  }
  if (currentHead !== input.request.identity.requestedHeadSha) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.STALE,
      'The requested pull-request revision is stale.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const [entry] = effective.providerChain;
  let generate = null;
  if (entry) {
    try {
      generate = resolveExplanationGenerateFn({
        provider: entry.provider,
        model: entry.model,
        apiKey: entry.encryptedApiKey === null ? undefined : decrypt(entry.encryptedApiKey),
        ...(entry.gatewayUrl === undefined ? {} : { gatewayUrl: entry.gatewayUrl }),
        ...(entry.targetProvider === undefined ? {} : { targetProvider: entry.targetProvider }),
      });
    } catch {
      generate = null;
    }
  }
  if (!generate) {
    const outcome = nonAnswer(
      EXPLANATION_OUTCOME.AI_UNAVAILABLE,
      'No fixed explanation provider is available.',
    );
    return (await settlePendingOutcome(db, invocationRequest, outcome)) ? outcome : null;
  }

  const reservation = await reserveExplanationInvocationDispatch(db, {
    ...invocationRequest,
    leaseDurationMs: EXPLANATION_DISPATCH_LEASE_MS,
  });
  if (reservation.status !== 'reserved') return null;

  let outcome: ExplanationOutcome;
  try {
    outcome = await generateExplanation(input.request, input.snapshot, generate);
  } catch {
    outcome = nonAnswer(
      EXPLANATION_OUTCOME.AMBIGUOUS,
      'Explanation generation completion is unknown.',
    );
  }

  let settled: boolean;
  try {
    settled = await settleReservedOutcome(
      db,
      invocationRequest,
      reservation.executionFence,
      outcome,
    );
  } catch {
    return outcome.kind === EXPLANATION_OUTCOME.AMBIGUOUS
      ? outcome
      : nonAnswer(EXPLANATION_OUTCOME.AMBIGUOUS, 'Explanation outcome persistence is unknown.');
  }
  if (!settled) {
    return outcome.kind === EXPLANATION_OUTCOME.AMBIGUOUS
      ? outcome
      : nonAnswer(EXPLANATION_OUTCOME.AMBIGUOUS, 'Explanation outcome persistence is unknown.');
  }

  await notifyConfirmedPublishers(options, input, outcome);
  return outcome;
}

const EXPLANATION_ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const EXPLANATION_COMMAND = /^[^\S\r\n]*\/ghagga[^\S\r\n]+explain[^\S\r\n]+(.+)$/i;
const FENCE_LINE = /^[^\S\r\n]*```/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseQuestion(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;

  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = EXPLANATION_COMMAND.exec(line);
    if (match?.[1] && match[1].trim().length > 0) return match[1];
  }

  return undefined;
}

function invalidIngress(reason: string): RejectedExplanationIngress {
  return { kind: EXPLANATION_INGRESS_OUTCOME.INVALID, reason };
}

/**
 * Constructs immutable explanation request data without routing, queue setup, or I/O.
 * Every value comes from an untrusted webhook-shaped input and is validated before use.
 */
export function createExplanationIngress(input: unknown): ExplanationIngress {
  if (!isRecord(input))
    return invalidIngress('A complete stable explanation identity is required.');

  const question = parseQuestion(input.body);
  if (!question) {
    return invalidIngress('A leading non-fenced /ghagga explain question is required.');
  }

  if (
    input.actorType !== 'User' ||
    typeof input.association !== 'string' ||
    !EXPLANATION_ALLOWED_ASSOCIATIONS.has(input.association)
  ) {
    return {
      kind: EXPLANATION_INGRESS_OUTCOME.UNAUTHORIZED,
      reason: 'Only eligible human maintainers may request explanations.',
    };
  }

  if (
    !isPositiveSafeInteger(input.sourceCommentId) ||
    !isPositiveSafeInteger(input.actorId) ||
    !isPositiveSafeInteger(input.installationId) ||
    !isPositiveSafeInteger(input.repositoryId) ||
    !isPositiveSafeInteger(input.pullRequestNumber) ||
    !isNonEmptyString(input.requestedHeadSha) ||
    !isNonEmptyString(input.forgeInstance)
  ) {
    return invalidIngress('A complete stable explanation identity is required.');
  }

  return {
    kind: EXPLANATION_INGRESS_OUTCOME.ACCEPTED,
    request: {
      identity: {
        forgeInstance: input.forgeInstance,
        installationId: String(input.installationId),
        actorId: String(input.actorId),
        repositoryId: String(input.repositoryId),
        pullRequestNumber: input.pullRequestNumber,
        requestedHeadSha: input.requestedHeadSha,
        sourceCommentId: String(input.sourceCommentId),
        questionHash: createHash('sha256').update(question).digest('hex'),
      },
      question,
    },
  };
}
