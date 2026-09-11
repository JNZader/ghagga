import { createHash } from 'node:crypto';
import { EXPLANATION_OUTCOME } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const compositionMocks = vi.hoisted(() => ({
  createDatabaseFromEnv: vi.fn(),
  getRepositoryById: vi.fn(),
  getInstallationById: vi.fn(),
  getEffectiveRepoSettings: vi.fn(),
  lookupExplanationInvocation: vi.fn(),
  recoverExpiredExplanationInvocationDispatch: vi.fn(),
  reserveExplanationInvocationDispatch: vi.fn(),
  settleExplanationInvocation: vi.fn(),
  decrypt: vi.fn(),
  getInstallationToken: vi.fn(),
  getCurrentExplanationActorAuthorization: vi.fn(),
  makeGitHubAdapter: vi.fn(),
  resolveExplanationGenerateFn: vi.fn(),
}));

const reviewFallbackMocks = vi.hoisted(() => ({
  resolveGenerateTextFns: vi.fn(),
}));

const queueMocks = vi.hoisted(() => {
  const add = vi.fn();
  const Queue = vi.fn(function Queue() {
    return { add };
  });
  const Worker = vi.fn(function Worker(_name, processor) {
    return { processor };
  });
  return { add, Queue, Worker };
});

const redisMocks = vi.hoisted(() => ({
  createRedisClient: vi.fn(() => ({ kind: 'mocked-redis-connection' })),
}));

vi.mock('ghagga-db', () => compositionMocks);
vi.mock('bullmq', () => ({ Queue: queueMocks.Queue, Worker: queueMocks.Worker }));
vi.mock('../lib/redis.js', () => redisMocks);
vi.mock('../github/client.js', () => ({
  getInstallationToken: compositionMocks.getInstallationToken,
  getCurrentExplanationActorAuthorization: compositionMocks.getCurrentExplanationActorAuthorization,
}));
vi.mock('../github/forge-adapter-factory.js', () => ({
  makeGitHubAdapter: compositionMocks.makeGitHubAdapter,
}));
vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    resolveExplanationGenerateFn: compositionMocks.resolveExplanationGenerateFn,
    resolveGenerateTextFns: reviewFallbackMocks.resolveGenerateTextFns,
  };
});

import {
  createExplanationIngress,
  createExplanationWorker,
  EXPLANATION_INGRESS_OUTCOME,
  enqueueExplanation,
  processExplanation,
  processPersistedExplanation,
} from './explanation.js';

const validInput = {
  body: '/ghagga explain Why was this function changed?',
  sourceCommentId: 41,
  actorId: 42,
  installationId: 43,
  repositoryId: 44,
  actorType: 'User',
  association: 'MEMBER',
  pullRequestNumber: 45,
  requestedHeadSha: 'opaque-requested-head',
  forgeInstance: 'github.com',
};

describe('createExplanationIngress', () => {
  it('accepts a leading non-fenced explanation command with its stable identity', () => {
    const result = createExplanationIngress(validInput);

    expect(result).toEqual({
      kind: EXPLANATION_INGRESS_OUTCOME.ACCEPTED,
      request: {
        identity: {
          forgeInstance: 'github.com',
          installationId: '43',
          actorId: '42',
          repositoryId: '44',
          pullRequestNumber: 45,
          requestedHeadSha: 'opaque-requested-head',
          sourceCommentId: '41',
          questionHash: createHash('sha256').update('Why was this function changed?').digest('hex'),
        },
        question: 'Why was this function changed?',
      },
    });
  });

  it('keeps option-like and composed text as question data', () => {
    const question = '--head other-sha; PREFIX=value /ghagga review';
    const result = createExplanationIngress({
      ...validInput,
      body: `/ghagga explain ${question}`,
    });

    expect(result).toEqual({
      kind: EXPLANATION_INGRESS_OUTCOME.ACCEPTED,
      request: {
        identity: expect.objectContaining({
          questionHash: createHash('sha256').update(question).digest('hex'),
        }),
        question,
      },
    });
  });

  it.each(['/ghagga explain', 'Please /ghagga explain inline', '```\n/ghagga explain fenced\n```'])(
    'rejects a missing, inline, or fenced command as invalid',
    (body) => {
      expect(createExplanationIngress({ ...validInput, body })).toEqual({
        kind: EXPLANATION_INGRESS_OUTCOME.INVALID,
        reason: 'A leading non-fenced /ghagga explain question is required.',
      });
    },
  );

  it.each([
    { actorType: 'Bot', association: 'OWNER' },
    { actorType: 'User', association: 'CONTRIBUTOR' },
  ])('rejects non-human or ineligible actors without throwing', (authorization) => {
    expect(createExplanationIngress({ ...validInput, ...authorization })).toEqual({
      kind: EXPLANATION_INGRESS_OUTCOME.UNAUTHORIZED,
      reason: 'Only eligible human maintainers may request explanations.',
    });
  });

  it.each([
    { sourceCommentId: 0 },
    { actorId: Number.NaN },
    { repositoryId: undefined },
    { pullRequestNumber: 1.5 },
    { requestedHeadSha: '   ' },
  ])('rejects malformed identity fields without throwing', (identity) => {
    expect(createExplanationIngress({ ...validInput, ...identity })).toEqual({
      kind: EXPLANATION_INGRESS_OUTCOME.INVALID,
      reason: 'A complete stable explanation identity is required.',
    });
  });
});

describe('processExplanation', () => {
  const request = createExplanationIngress(validInput).request!;
  const snapshot = {
    repositoryId: '44',
    baseSha: 'base',
    headSha: 'opaque-requested-head',
    diff: 'diff',
    files: [{ path: 'a.ts', content: 'x' }],
  };

  it('reserves before one generation and settles its finding-free answer', async () => {
    const order: string[] = [];
    const dependencies = {
      lookup: async () => 'PENDING' as const,
      enabled: async () => true,
      authorize: async () => 'AUTHORIZED' as const,
      currentHead: async () => 'opaque-requested-head',
      reserve: async () => {
        order.push('reserve');
        return true;
      },
      settle: async () => {
        order.push('settle');
      },
      generate: async () => {
        order.push('generate');
        return { text: 'answer', provider: 'gateway', model: 'fixed', tokensUsed: 1 };
      },
    };
    await expect(processExplanation(request, snapshot, dependencies)).resolves.toMatchObject({
      kind: 'ANSWERED',
      answer: 'answer',
    });
    expect(order).toEqual(['reserve', 'generate', 'settle']);
  });

  it('does not dispatch observed, disabled, unauthorized, stale, or uncertain requests', async () => {
    const generate = vi.fn();
    const settle = vi.fn();
    for (const overrides of [
      { lookup: async () => 'TERMINAL' as const },
      { enabled: async () => false },
      { authorize: async () => 'UNAUTHORIZED' as const },
      { authorize: async () => 'UNCERTAIN' as const },
      { currentHead: async () => 'new-head' },
    ]) {
      await processExplanation(request, snapshot, {
        lookup: async () => 'PENDING' as const,
        enabled: async () => true,
        authorize: async () => 'AUTHORIZED' as const,
        currentHead: async () => 'opaque-requested-head',
        reserve: async () => true,
        settle,
        generate,
        ...overrides,
      });
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('processPersistedExplanation', () => {
  const request = createExplanationIngress(validInput).request!;
  const snapshot = {
    repositoryId: '44',
    baseSha: 'base',
    headSha: 'opaque-requested-head',
    diff: 'diff',
    files: [{ path: 'a.ts', content: 'x' }],
  };
  const database = {};
  const repository = {
    id: 101,
    githubRepoId: 44,
    installationId: 201,
    fullName: 'acme/widget',
    isActive: true,
    useGlobalSettings: false,
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: {},
  };
  const installation = { id: 201, githubInstallationId: 43, isActive: true };
  const pendingInvocation = { executionStatus: 'PENDING', outcomePayload: null };

  beforeEach(() => {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
    for (const mock of Object.values(compositionMocks)) mock.mockReset();
    reviewFallbackMocks.resolveGenerateTextFns.mockReset();
    compositionMocks.createDatabaseFromEnv.mockReturnValue(database);
    compositionMocks.lookupExplanationInvocation.mockResolvedValue({
      status: 'found',
      invocation: pendingInvocation,
    });
    compositionMocks.getRepositoryById.mockResolvedValue(repository);
    compositionMocks.getInstallationById.mockResolvedValue(installation);
    compositionMocks.getEffectiveRepoSettings.mockResolvedValue({
      settings: { explanationsEnabled: true },
      providerChain: [
        {
          provider: 'gateway',
          model: 'fixed-model',
          encryptedApiKey: 'encrypted-key',
          gatewayUrl: 'https://gateway.test',
          targetProvider: 'fixed-target',
        },
      ],
    });
    compositionMocks.decrypt.mockReturnValue('decrypted-key');
    compositionMocks.getInstallationToken.mockResolvedValue('installation-token');
    compositionMocks.getCurrentExplanationActorAuthorization.mockResolvedValue({
      kind: 'AUTHORIZED',
    });
    compositionMocks.makeGitHubAdapter.mockReturnValue({
      fetchChangeRequest: vi.fn().mockResolvedValue({ headSha: 'opaque-requested-head' }),
    });
    compositionMocks.reserveExplanationInvocationDispatch.mockResolvedValue({
      status: 'reserved',
      executionFence: 'fence-1',
    });
    compositionMocks.settleExplanationInvocation.mockResolvedValue({ status: 'settled' });
  });

  it('composes real persistence, auth, forge, and one fixed generator before dispatch', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: 'answer',
      provider: 'gateway',
      model: 'fixed-model',
      tokensUsed: 3,
    });
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toMatchObject({ kind: 'ANSWERED', answer: 'answer' });

    expect(compositionMocks.lookupExplanationInvocation).toHaveBeenCalledWith(database, {
      ...request.identity,
      question: request.question,
    });
    expect(compositionMocks.getRepositoryById).toHaveBeenCalledWith(database, 101);
    expect(compositionMocks.getInstallationById).toHaveBeenCalledWith(database, 201);
    expect(compositionMocks.decrypt).toHaveBeenCalledWith('encrypted-key');
    expect(compositionMocks.resolveExplanationGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gateway',
        model: 'fixed-model',
        apiKey: 'decrypted-key',
      }),
    );
    expect(compositionMocks.reserveExplanationInvocationDispatch).toHaveBeenCalledBefore(generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(compositionMocks.settleExplanationInvocation).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        expectedExecutionStatus: 'DISPATCH_RESERVED',
        executionFence: 'fence-1',
        outcome: expect.objectContaining({ kind: 'ANSWERED' }),
      }),
    );
  });

  it('notifies the optional local publisher only after a reserved outcome settles', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: 'answer',
      provider: 'gateway',
      model: 'fixed-model',
      tokensUsed: 3,
    });
    const publisher = vi.fn().mockRejectedValueOnce(new Error('publication unavailable'));
    const progressPublisher = vi.fn().mockResolvedValue(undefined);
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);

    await expect(
      processPersistedExplanation(
        {
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        },
        { publisher, progressPublisher },
      ),
    ).rejects.toThrow('publication unavailable');

    expect(publisher).toHaveBeenCalledWith({
      identity: request.identity,
      request,
      repositoryDbId: 101,
      actorLogin: 'maintainer',
      outcome: expect.objectContaining({ kind: 'ANSWERED', answer: 'answer' }),
    });
    expect(progressPublisher).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({ kind: 'ANSWERED', answer: 'answer' }),
      }),
    );
    expect(progressPublisher).toHaveBeenCalledBefore(publisher);

    for (const settlement of [
      { status: 'observed' },
      { status: 'invalid' },
      { status: 'unavailable' },
    ]) {
      publisher.mockClear();
      generate.mockClear();
      compositionMocks.resolveExplanationGenerateFn.mockClear();
      compositionMocks.settleExplanationInvocation.mockClear();
      compositionMocks.settleExplanationInvocation.mockResolvedValueOnce(settlement);
      await expect(
        processPersistedExplanation(
          {
            repositoryDbId: 101,
            actorLogin: 'maintainer',
            request,
            snapshot,
          },
          { publisher },
        ),
      ).resolves.toMatchObject({ kind: 'AMBIGUOUS' });
      expect(publisher).not.toHaveBeenCalled();
      expect(compositionMocks.resolveExplanationGenerateFn).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(compositionMocks.settleExplanationInvocation).toHaveBeenCalledTimes(1);
    }

    publisher.mockClear();
    generate.mockClear();
    compositionMocks.resolveExplanationGenerateFn.mockClear();
    compositionMocks.settleExplanationInvocation.mockClear();
    compositionMocks.settleExplanationInvocation.mockRejectedValueOnce(
      new Error('settlement unavailable'),
    );
    await expect(
      processPersistedExplanation(
        {
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        },
        { publisher },
      ),
    ).resolves.toMatchObject({ kind: 'AMBIGUOUS' });
    expect(publisher).not.toHaveBeenCalled();
    expect(compositionMocks.resolveExplanationGenerateFn).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(compositionMocks.settleExplanationInvocation).toHaveBeenCalledTimes(1);
  });

  it('notifies the publisher only after one confirmed settlement of a generation ambiguity', async () => {
    const events: string[] = [];
    const generate = vi.fn(async () => {
      events.push('generate');
      throw new Error('generation unavailable');
    });
    const publisher = vi.fn(async () => {
      events.push('publisher');
      return undefined;
    });
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);
    compositionMocks.settleExplanationInvocation.mockImplementation(async () => {
      events.push('settle');
      return { status: 'settled' };
    });

    await expect(
      processPersistedExplanation(
        {
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        },
        { publisher },
      ),
    ).resolves.toMatchObject({
      kind: EXPLANATION_OUTCOME.AMBIGUOUS,
      reason: 'Explanation generation completion is unknown.',
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(compositionMocks.settleExplanationInvocation).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith({
      identity: request.identity,
      request,
      repositoryDbId: 101,
      actorLogin: 'maintainer',
      outcome: expect.objectContaining({ kind: EXPLANATION_OUTCOME.AMBIGUOUS }),
    });
    expect(events).toEqual(['generate', 'settle', 'publisher']);
  });

  it('never invokes the real review-provider fallback resolver for explanation work', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: 'answer',
      provider: 'gateway',
      model: 'fixed-model',
      tokensUsed: 3,
    });
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toMatchObject({ kind: EXPLANATION_OUTCOME.ANSWERED });
    expect(compositionMocks.resolveExplanationGenerateFn).toHaveBeenCalledTimes(1);
    expect(compositionMocks.resolveExplanationGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gateway', model: 'fixed-model' }),
    );
    expect(reviewFallbackMocks.resolveGenerateTextFns).not.toHaveBeenCalled();

    compositionMocks.getCurrentExplanationActorAuthorization.mockResolvedValueOnce({
      kind: 'UNAUTHORIZED',
    });
    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toMatchObject({ kind: EXPLANATION_OUTCOME.UNAUTHORIZED });
    expect(reviewFallbackMocks.resolveGenerateTextFns).not.toHaveBeenCalled();

    compositionMocks.settleExplanationInvocation.mockRejectedValueOnce(
      new Error('settlement unavailable'),
    );
    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toMatchObject({ kind: EXPLANATION_OUTCOME.AMBIGUOUS });
    expect(reviewFallbackMocks.resolveGenerateTextFns).not.toHaveBeenCalled();
  });

  it.each([
    ['missing claim', { status: 'not_found' }],
    ['identity mismatch', { status: 'mismatch' }],
    ['CAS loser', { status: 'observed', invocation: pendingInvocation }],
  ])('does not create or dispatch when %s', async (_name, lookup) => {
    compositionMocks.lookupExplanationInvocation.mockResolvedValue(lookup);
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(vi.fn());

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toBeNull();

    expect(compositionMocks.reserveExplanationInvocationDispatch).not.toHaveBeenCalled();
    expect(compositionMocks.resolveExplanationGenerateFn).not.toHaveBeenCalled();
  });

  it.each(['observed', 'invalid', 'unavailable'] as const)(
    'does not invoke the generator or redispatch after a %s reservation result',
    async (status) => {
      const generate = vi.fn();
      compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);
      compositionMocks.reserveExplanationInvocationDispatch.mockResolvedValue({ status });

      await expect(
        processPersistedExplanation({
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        }),
      ).resolves.toBeNull();

      expect(compositionMocks.reserveExplanationInvocationDispatch).toHaveBeenCalledOnce();
      expect(generate).not.toHaveBeenCalled();
      expect(compositionMocks.settleExplanationInvocation).not.toHaveBeenCalled();
    },
  );

  it('does not answer, reserve, or invoke the model when current authorization is uncertain', async () => {
    const generate = vi.fn();
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);
    compositionMocks.getCurrentExplanationActorAuthorization.mockResolvedValue({
      kind: 'UNCERTAIN',
    });

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toBeNull();

    expect(compositionMocks.resolveExplanationGenerateFn).not.toHaveBeenCalled();
    expect(compositionMocks.reserveExplanationInvocationDispatch).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(compositionMocks.settleExplanationInvocation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'installation-token acquisition is uncertain',
      () =>
        compositionMocks.getInstallationToken.mockRejectedValueOnce(new Error('token unavailable')),
    ],
    [
      'current-head acquisition is uncertain',
      () =>
        compositionMocks.makeGitHubAdapter.mockReturnValueOnce({
          fetchChangeRequest: vi.fn().mockRejectedValueOnce(new Error('head unavailable')),
        }),
    ],
  ])('does not dispatch when %s', async (_name, arrange) => {
    const generate = vi.fn();
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);
    arrange();

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toBeNull();

    expect(compositionMocks.resolveExplanationGenerateFn).not.toHaveBeenCalled();
    expect(compositionMocks.reserveExplanationInvocationDispatch).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(compositionMocks.settleExplanationInvocation).not.toHaveBeenCalled();
  });

  it('does not invoke the model again or write late after replaying a settled ambiguity', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('generation unavailable'));
    compositionMocks.resolveExplanationGenerateFn.mockReturnValue(generate);
    compositionMocks.lookupExplanationInvocation
      .mockResolvedValueOnce({ status: 'found', invocation: pendingInvocation })
      .mockResolvedValueOnce({
        status: 'found',
        invocation: {
          executionStatus: 'TERMINAL',
          outcomePayload: {
            kind: EXPLANATION_OUTCOME.AMBIGUOUS,
            reason: 'Explanation generation completion is unknown.',
          },
        },
      });

    const input = {
      repositoryDbId: 101,
      actorLogin: 'maintainer',
      request,
      snapshot,
    };
    await expect(processPersistedExplanation(input)).resolves.toMatchObject({
      kind: EXPLANATION_OUTCOME.AMBIGUOUS,
    });
    await expect(processPersistedExplanation(input)).resolves.toMatchObject({
      kind: EXPLANATION_OUTCOME.AMBIGUOUS,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(compositionMocks.reserveExplanationInvocationDispatch).toHaveBeenCalledOnce();
    expect(compositionMocks.settleExplanationInvocation).toHaveBeenCalledTimes(1);
  });

  it('retries publication when a terminal duplicate replays its stored outcome', async () => {
    const publisher = vi.fn();
    compositionMocks.lookupExplanationInvocation.mockResolvedValue({
      status: 'found',
      invocation: {
        executionStatus: 'TERMINAL',
        outcomePayload: {
          kind: 'ANSWERED',
          answer: 'stored',
          metadata: { provider: 'gateway', model: 'fixed', tokensUsed: 1 },
        },
      },
    });

    await expect(
      processPersistedExplanation(
        {
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        },
        { publisher },
      ),
    ).resolves.toMatchObject({ kind: 'ANSWERED', answer: 'stored' });

    expect(publisher).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'repository identity mismatch',
      EXPLANATION_OUTCOME.INVALID,
      () => {
        compositionMocks.getRepositoryById.mockResolvedValue({ ...repository, githubRepoId: 45 });
      },
    ],
    [
      'disabled inherited setting',
      EXPLANATION_OUTCOME.DISABLED,
      () => {
        compositionMocks.getEffectiveRepoSettings.mockResolvedValue({
          settings: { explanationsEnabled: false },
          providerChain: [],
        });
      },
    ],
    [
      'current actor denial',
      EXPLANATION_OUTCOME.UNAUTHORIZED,
      () => {
        compositionMocks.getCurrentExplanationActorAuthorization.mockResolvedValue({
          kind: 'UNAUTHORIZED',
        });
      },
    ],
    [
      'stale current head',
      EXPLANATION_OUTCOME.STALE,
      () => {
        compositionMocks.makeGitHubAdapter.mockReturnValue({
          fetchChangeRequest: vi.fn().mockResolvedValue({ headSha: 'new-head' }),
        });
      },
    ],
  ])(
    'settles an explicit non-answer without model dispatch for %s',
    async (_name, kind, arrange) => {
      arrange();
      compositionMocks.resolveExplanationGenerateFn.mockReturnValue(vi.fn());

      await expect(
        processPersistedExplanation({
          repositoryDbId: 101,
          actorLogin: 'maintainer',
          request,
          snapshot,
        }),
      ).resolves.toMatchObject({ kind });

      expect(compositionMocks.resolveExplanationGenerateFn).not.toHaveBeenCalled();
      expect(compositionMocks.reserveExplanationInvocationDispatch).not.toHaveBeenCalled();
    },
  );

  it('settles AI_UNAVAILABLE when no fixed explanation provider is configured', async () => {
    compositionMocks.getEffectiveRepoSettings.mockResolvedValue({
      settings: { explanationsEnabled: true },
      providerChain: [],
    });

    await expect(
      processPersistedExplanation({
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        request,
        snapshot,
      }),
    ).resolves.toMatchObject({ kind: EXPLANATION_OUTCOME.AI_UNAVAILABLE });

    expect(compositionMocks.resolveExplanationGenerateFn).not.toHaveBeenCalled();
    expect(compositionMocks.reserveExplanationInvocationDispatch).not.toHaveBeenCalled();
  });
});

describe('explanation queue transport', () => {
  const request = createExplanationIngress(validInput).request!;
  const snapshot = {
    repositoryId: '44',
    baseSha: 'base',
    headSha: 'opaque-requested-head',
    diff: 'diff',
    files: [{ path: 'a.ts', content: 'x' }],
  };
  const data = {
    invocationKey: 'a'.repeat(64),
    repositoryDbId: 101,
    actorLogin: 'maintainer',
    request,
    snapshot,
  };

  beforeEach(() => {
    queueMocks.add.mockReset();
    queueMocks.Queue.mockClear();
    queueMocks.Worker.mockClear();
    redisMocks.createRedisClient.mockClear();
  });

  it('enqueues only immutable explanation data under the durable invocation key', async () => {
    queueMocks.add.mockResolvedValue({ id: data.invocationKey });

    await expect(enqueueExplanation(data)).resolves.toEqual({ id: data.invocationKey });

    expect(queueMocks.add).toHaveBeenCalledWith('process-explanation', data, {
      jobId: data.invocationKey,
      attempts: 1,
    });
  });

  it('propagates queue failures instead of reporting a fake enqueue success', async () => {
    queueMocks.add.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(enqueueExplanation(data)).rejects.toThrow('queue unavailable');
  });

  it('constructs a worker that delegates its job data to the persisted processor', async () => {
    const database = {};
    compositionMocks.createDatabaseFromEnv.mockReturnValue(database);
    compositionMocks.lookupExplanationInvocation.mockResolvedValue({
      status: 'found',
      invocation: { executionStatus: 'TERMINAL', outcomePayload: null },
    });

    createExplanationWorker(2);

    expect(queueMocks.Worker).toHaveBeenCalledWith(
      'explanation',
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
    const processor = queueMocks.Worker.mock.calls[0]?.[1] as (job: {
      data: typeof data;
    }) => Promise<unknown>;
    await expect(processor({ data })).resolves.toBeNull();
    expect(compositionMocks.lookupExplanationInvocation).toHaveBeenCalledWith(database, {
      ...request.identity,
      question: request.question,
    });
  });
});
