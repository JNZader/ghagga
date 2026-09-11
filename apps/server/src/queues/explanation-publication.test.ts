import { createHash } from 'node:crypto';
import { EXPLANATION_OUTCOME } from 'ghagga-core';
import {
  deriveExplanationInvocationKey,
  EXPLANATION_PUBLICATION_CHANNELS,
  EXPLANATION_PUBLICATION_CREATE_OUTCOMES,
} from 'ghagga-db';
import { describe, expect, it, vi } from 'vitest';
import {
  EXPLANATION_PUBLICATION_GUARD,
  EXPLANATION_PUBLICATION_RESULT,
  publishExplanationOutcome,
} from './explanation-publication.js';

const request = {
  identity: {
    forgeInstance: 'github.com',
    installationId: '43',
    actorId: '42',
    repositoryId: '44',
    pullRequestNumber: 45,
    requestedHeadSha: 'opaque-requested-head',
    sourceCommentId: '41',
    questionHash: createHash('sha256').update('Why?').digest('hex'),
  },
  question: 'Why?',
};

const answered = {
  kind: EXPLANATION_OUTCOME.ANSWERED,
  answer: 'A finding-free explanation.',
  metadata: { provider: 'gateway', model: 'fixed', tokensUsed: 1 },
};

function makeTrust(
  channel: 'progress' | 'answer',
  state: 'NOT_STARTED' | 'PUBLISHED' = 'NOT_STARTED',
) {
  return {
    kind: 'AUTHORIZED' as const,
    currentHeadSha: request.identity.requestedHeadSha,
    expectedBotAuthorId: 721,
    currentPublication: {
      status: state,
      version: 4,
      ...(state === 'PUBLISHED' ? { commentId: 991 } : {}),
    },
    reference: {
      forgeInstance: request.identity.forgeInstance,
      installationId: request.identity.installationId,
      repositoryId: request.identity.repositoryId,
      changeRequest: {
        repo: {
          kind: 'github' as const,
          nativeId: request.identity.repositoryId,
          path: 'acme/widget',
        },
        iid: request.identity.pullRequestNumber,
      },
      ownerId: '721',
      channel,
      invocationId: deriveExplanationInvocationKey(request.identity)!,
    },
  };
}

function makeDependencies(channel: 'progress' | 'answer', trust = makeTrust(channel)) {
  const events: string[] = [];
  let currentPublication = trust.currentPublication;
  const guard = vi.fn(async () => {
    events.push('guard');
    return { ...trust, currentPublication };
  });
  const lookup = vi.fn(async () => {
    events.push('lookup');
    return { kind: 'ABSENT' as const };
  });
  const create = vi.fn(async () => {
    events.push('create');
    return { kind: 'github:issue-comment', raw: 992 };
  });
  const update = vi.fn(async () => {
    events.push('update');
  });
  const reserveCreate = vi.fn(async () => {
    events.push('reserve-create');
    currentPublication = {
      status: 'CREATE_STARTED',
      version: 5,
      publicationFence: 'create-fence',
    };
    return {
      status: 'reserved' as const,
      invocation: { progressPublicationVersion: 5, answerPublicationVersion: 5 },
      publicationFence: 'create-fence',
    };
  });
  const reservePatch = vi.fn(async () => {
    events.push('reserve-patch');
    currentPublication = {
      status: 'PATCH_STARTED',
      version: 5,
      publicationFence: 'patch-fence',
      ...(trust.currentPublication.status === 'PUBLISHED'
        ? { commentId: trust.currentPublication.commentId }
        : {}),
    };
    return {
      status: 'reserved' as const,
      invocation: { progressPublicationVersion: 5, answerPublicationVersion: 5 },
      publicationFence: 'patch-fence',
    };
  });
  const settleCreate = vi.fn(async () => {
    events.push('settle-create');
    currentPublication = { status: 'PUBLISHED', version: 6, commentId: 992 };
    return { status: 'settled' as const, invocation: {} };
  });
  const settlePatch = vi.fn(async () => {
    events.push('settle-patch');
    currentPublication = {
      status: 'PUBLISHED',
      version: 6,
      commentId:
        trust.currentPublication.status === 'PUBLISHED' ? trust.currentPublication.commentId : 991,
    };
    return { status: 'settled' as const, invocation: {} };
  });
  return {
    events,
    setCurrentPublication(next: typeof currentPublication) {
      currentPublication = next;
    },
    dependencies: {
      db: {},
      guard,
      lookup,
      create,
      update,
      reserveCreate,
      reservePatch,
      settleCreate,
      settlePatch,
    },
  };
}

function publicationInput(channel: 'progress' | 'answer') {
  return {
    request,
    outcome: answered,
    channel,
    body: 'Caller-bound publication body.',
  };
}

const operationCases = [
  { name: 'progress CREATE', channel: 'progress', state: 'NOT_STARTED', operation: 'CREATE' },
  { name: 'answer CREATE', channel: 'answer', state: 'NOT_STARTED', operation: 'CREATE' },
  { name: 'progress PATCH', channel: 'progress', state: 'PUBLISHED', operation: 'PATCH' },
  { name: 'answer PATCH', channel: 'answer', state: 'PUBLISHED', operation: 'PATCH' },
] as const;

const initialGuardDenials = [
  EXPLANATION_PUBLICATION_GUARD.DISABLED,
  EXPLANATION_PUBLICATION_GUARD.UNAUTHORIZED,
  EXPLANATION_PUBLICATION_GUARD.STALE,
] as const;

function makeOperationDependencies(operation: (typeof operationCases)[number]) {
  const trust = makeTrust(operation.channel, operation.state);
  const fixture = makeDependencies(operation.channel, trust);
  if (operation.operation === 'PATCH') {
    fixture.dependencies.lookup.mockResolvedValue({
      kind: 'FOUND',
      commentId: { kind: 'github:issue-comment', raw: 991 },
      reference: trust.reference,
    });
  }
  return { trust, ...fixture };
}

function activeMocks(
  operation: (typeof operationCases)[number],
  dependencies: ReturnType<typeof makeDependencies>['dependencies'],
) {
  return operation.operation === 'CREATE'
    ? {
        reserve: dependencies.reserveCreate,
        settle: dependencies.settleCreate,
        write: dependencies.create,
      }
    : {
        reserve: dependencies.reservePatch,
        settle: dependencies.settlePatch,
        write: dependencies.update,
      };
}

describe('publishExplanationOutcome', () => {
  it('commits a guarded progress CREATE before one post and acknowledged settlement', async () => {
    const { dependencies, events } = makeDependencies('progress');

    await expect(
      publishExplanationOutcome(publicationInput('progress'), dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.PUBLISHED, channel: 'progress' });

    expect(dependencies.guard).toHaveBeenCalledTimes(2);
    expect(dependencies.reserveCreate).toHaveBeenCalledBefore(dependencies.create);
    expect(dependencies.create).toHaveBeenCalledTimes(1);
    expect(dependencies.settleCreate).toHaveBeenCalledWith(
      dependencies.db,
      expect.objectContaining({
        channel: EXPLANATION_PUBLICATION_CHANNELS.PROGRESS,
        expectedBotAuthorId: 721,
        expectedPublicationVersion: 5,
        publicationFence: 'create-fence',
        outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES.ACKNOWLEDGED,
        commentId: 992,
      }),
    );
    expect(events).toEqual([
      'guard',
      'lookup',
      'reserve-create',
      'guard',
      'create',
      'settle-create',
    ]);
  });

  it('updates only an exact trusted PUBLISHED answer reference', async () => {
    const trust = makeTrust('answer', 'PUBLISHED');
    const { dependencies } = makeDependencies('answer', trust);
    dependencies.lookup.mockResolvedValue({
      kind: 'FOUND',
      commentId: { kind: 'github:issue-comment', raw: 991 },
      reference: trust.reference,
    });

    await expect(
      publishExplanationOutcome(publicationInput('answer'), dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.PUBLISHED, channel: 'answer' });

    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.reservePatch).toHaveBeenCalledBefore(dependencies.update);
    expect(dependencies.update).toHaveBeenCalledWith(
      trust.reference,
      { kind: 'github:issue-comment', raw: 991 },
      'Caller-bound publication body.',
    );
    expect(dependencies.settlePatch).toHaveBeenCalledWith(
      dependencies.db,
      expect.objectContaining({
        channel: EXPLANATION_PUBLICATION_CHANNELS.ANSWER,
        expectedPublicationVersion: 5,
        publicationFence: 'patch-fence',
        commentId: 991,
      }),
    );
  });

  it.each([
    ['initial disabled guard', { kind: 'DISABLED' as const }],
    ['initial stale guard', { kind: 'STALE' as const }],
    ['missing trusted owner', { ...makeTrust('progress'), expectedBotAuthorId: 0 }],
    [
      'wrong reference owner',
      {
        ...makeTrust('progress'),
        reference: { ...makeTrust('progress').reference, ownerId: '722' },
      },
    ],
  ])('fails closed before reservation or external I/O for %s', async (_name, trust) => {
    const { dependencies } = makeDependencies('progress', trust);

    await expect(
      publishExplanationOutcome(publicationInput('progress'), dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED, channel: 'progress' });

    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it('consumes a won reservation as uncertain when the immediately-before-write guard changes', async () => {
    const first = makeTrust('progress');
    const { dependencies } = makeDependencies('progress', first);
    dependencies.guard.mockResolvedValueOnce(first).mockResolvedValueOnce({ kind: 'STALE' });

    await expect(
      publishExplanationOutcome(publicationInput('progress'), dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED, channel: 'progress' });

    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.settleCreate).toHaveBeenCalledWith(
      dependencies.db,
      expect.objectContaining({
        outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES.UNCERTAIN,
        expectedPublicationVersion: 5,
      }),
    );
  });

  it.each(['observed', 'unavailable', 'invalid'] as const)(
    'does not grant CREATE I/O from a %s reservation result',
    async (status) => {
      const { dependencies } = makeDependencies('progress');
      dependencies.reserveCreate.mockResolvedValue({ status });

      await publishExplanationOutcome(publicationInput('progress'), dependencies);

      expect(dependencies.create).not.toHaveBeenCalled();
      expect(dependencies.settleCreate).not.toHaveBeenCalled();
    },
  );

  it('contains unknown post or settlement outcomes without retrying a create', async () => {
    const { dependencies } = makeDependencies('progress');
    dependencies.create.mockRejectedValueOnce(new Error('unknown post outcome'));

    await expect(
      publishExplanationOutcome(publicationInput('progress'), dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS, channel: 'progress' });

    expect(dependencies.create).toHaveBeenCalledTimes(1);
    expect(dependencies.settleCreate).toHaveBeenCalledWith(
      dependencies.db,
      expect.objectContaining({ outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES.UNCERTAIN }),
    );

    const second = makeDependencies('progress');
    second.dependencies.settleCreate.mockRejectedValueOnce(new Error('settlement unavailable'));
    await expect(
      publishExplanationOutcome(publicationInput('progress'), second.dependencies),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS, channel: 'progress' });
    expect(second.dependencies.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    EXPLANATION_OUTCOME.DISABLED,
    EXPLANATION_OUTCOME.UNAUTHORIZED,
    EXPLANATION_OUTCOME.STALE,
  ])('never reserves or writes forbidden persisted outcome %s', async (kind) => {
    const { dependencies } = makeDependencies('progress');

    await expect(
      publishExplanationOutcome(
        {
          ...publicationInput('progress'),
          outcome: { kind, reason: 'Persisted generation outcome forbids publication.' },
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED, channel: 'progress' });

    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it.each([
    ['CREATE', 'progress', 'NOT_STARTED'],
    ['PATCH', 'answer', 'PUBLISHED'],
  ] as const)(
    'requires the real reserved %s state from the final guard before %s I/O',
    async (operation, channel, startingStatus) => {
      const row = {
        status: startingStatus,
        version: 4,
        publicationFence: null as string | null,
        commentId: startingStatus === 'PUBLISHED' ? 991 : (null as number | null),
      };
      const initial = makeTrust(channel, startingStatus);
      const events: string[] = [];
      const guard = vi.fn(async () => {
        events.push(`guard:${row.status}:${row.version}:${row.publicationFence ?? 'none'}`);
        return {
          ...initial,
          currentPublication:
            row.status === 'PUBLISHED'
              ? { status: 'PUBLISHED' as const, version: row.version, commentId: row.commentId! }
              : row.status === 'NOT_STARTED'
                ? { status: 'NOT_STARTED' as const, version: row.version }
                : {
                    status: row.status,
                    version: row.version,
                    publicationFence: row.publicationFence!,
                    ...(row.commentId === null ? {} : { commentId: row.commentId }),
                  },
        };
      });
      const lookup = vi.fn(async () =>
        row.status === 'NOT_STARTED'
          ? { kind: 'ABSENT' as const }
          : {
              kind: 'FOUND' as const,
              commentId: { kind: 'github:issue-comment', raw: 991 },
              reference: initial.reference,
            },
      );
      const create = vi.fn(async () => ({ kind: 'github:issue-comment', raw: 992 }));
      const update = vi.fn(async () => undefined);
      const reserveCreate = vi.fn(async () => {
        row.status = 'CREATE_STARTED';
        row.version = 5;
        row.publicationFence = 'create-fence';
        return {
          status: 'reserved' as const,
          invocation: { progressPublicationVersion: 5, answerPublicationVersion: 5 },
          publicationFence: 'create-fence',
        };
      });
      const reservePatch = vi.fn(async () => {
        row.status = 'PATCH_STARTED';
        row.version = 5;
        row.publicationFence = 'patch-fence';
        return {
          status: 'reserved' as const,
          invocation: { progressPublicationVersion: 5, answerPublicationVersion: 5 },
          publicationFence: 'patch-fence',
        };
      });
      const settleCreate = vi.fn(async () => {
        row.status = 'PUBLISHED';
        row.version = 6;
        row.publicationFence = null;
        row.commentId = 992;
        return { status: 'settled' as const, invocation: {} };
      });
      const settlePatch = vi.fn(async () => {
        row.status = 'PUBLISHED';
        row.version = 6;
        row.publicationFence = null;
        return { status: 'settled' as const, invocation: {} };
      });
      const dependencies = {
        db: {},
        guard,
        lookup,
        create,
        update,
        reserveCreate,
        reservePatch,
        settleCreate,
        settlePatch,
      };

      await expect(
        publishExplanationOutcome(publicationInput(channel), dependencies),
      ).resolves.toEqual({ kind: EXPLANATION_PUBLICATION_RESULT.PUBLISHED, channel });

      expect(events).toContain(
        `guard:${operation === 'CREATE' ? 'CREATE_STARTED' : 'PATCH_STARTED'}:5:${operation === 'CREATE' ? 'create-fence' : 'patch-fence'}`,
      );
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(operation === 'CREATE' ? create : update).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({ status: 'PUBLISHED', version: 6, publicationFence: null });
    },
  );

  it.each(
    operationCases.flatMap((operation) => [
      [
        'forge mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: { ...trust.reference, forgeInstance: 'gitlab.com' },
        }),
      ],
      [
        'installation mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: { ...trust.reference, installationId: '99' },
        }),
      ],
      [
        'repository mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: {
            ...trust.reference,
            repositoryId: '99',
            changeRequest: {
              ...trust.reference.changeRequest,
              repo: { ...trust.reference.changeRequest.repo, nativeId: '99' },
            },
          },
        }),
      ],
      [
        'PR mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: {
            ...trust.reference,
            changeRequest: { ...trust.reference.changeRequest, iid: 99 },
          },
        }),
      ],
      [
        'invocation mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: { ...trust.reference, invocationId: 'not-the-invocation-key' },
        }),
      ],
      [
        'channel mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: {
            ...trust.reference,
            channel: trust.reference.channel === 'progress' ? 'answer' : 'progress',
          },
        }),
      ],
      [
        'head mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          currentHeadSha: 'new-head',
        }),
      ],
      [
        'owner mismatch',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: { ...trust.reference, ownerId: '722' },
        }),
      ],
      [
        'missing owner',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({ ...trust, expectedBotAuthorId: 0 }),
      ],
    ]),
  )('fails closed before reservation or I/O for %s on %s', async (_name, operation, mutate) => {
    const initial = makeTrust(operation.channel, operation.state);
    const { dependencies } = makeDependencies(operation.channel, mutate(initial));
    if (operation.operation === 'PATCH') {
      dependencies.lookup.mockResolvedValue({
        kind: 'FOUND',
        commentId: { kind: 'github:issue-comment', raw: 991 },
        reference: initial.reference,
      });
    }

    await expect(
      publishExplanationOutcome(publicationInput(operation.channel), dependencies),
    ).resolves.toEqual({
      kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
      channel: operation.channel,
    });

    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.reservePatch).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
    expect(dependencies.settleCreate).not.toHaveBeenCalled();
    expect(dependencies.settlePatch).not.toHaveBeenCalled();
  });

  it.each(
    operationCases.flatMap((operation) =>
      initialGuardDenials.map((denial) => [denial, operation.name, operation] as const),
    ),
  )('denies %s at the initial guard for %s', async (denial, _operationName, operation) => {
    const { dependencies } = makeOperationDependencies(operation);
    dependencies.guard.mockResolvedValueOnce({ kind: denial });

    await expect(
      publishExplanationOutcome(publicationInput(operation.channel), dependencies),
    ).resolves.toEqual({
      kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
      channel: operation.channel,
    });

    expect(dependencies.guard).toHaveBeenCalledTimes(1);
    expect(dependencies.lookup).not.toHaveBeenCalled();
    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.reservePatch).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
    expect(dependencies.settleCreate).not.toHaveBeenCalled();
    expect(dependencies.settlePatch).not.toHaveBeenCalled();
  });

  it.each(operationCases.filter((operation) => operation.operation === 'PATCH'))(
    'fails closed for mismatched lookup references and invalid boxed PATCH ids on $name',
    async (operation) => {
      for (const lookup of [
        {
          kind: 'FOUND' as const,
          commentId: { kind: 'github:issue-comment', raw: 991 },
          reference: { ...makeTrust(operation.channel, operation.state).reference, ownerId: '722' },
        },
        {
          kind: 'FOUND' as const,
          commentId: { kind: 'github:issue-comment', raw: '991' },
          reference: makeTrust(operation.channel, operation.state).reference,
        },
        {
          kind: 'FOUND' as const,
          commentId: { kind: 'github:issue-comment', raw: 992 },
          reference: makeTrust(operation.channel, operation.state).reference,
        },
      ]) {
        const { dependencies } = makeOperationDependencies(operation);
        dependencies.lookup.mockResolvedValue(lookup);

        await expect(
          publishExplanationOutcome(publicationInput(operation.channel), dependencies),
        ).resolves.toEqual({
          kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
          channel: operation.channel,
        });
        expect(dependencies.reserveCreate).not.toHaveBeenCalled();
        expect(dependencies.reservePatch).not.toHaveBeenCalled();
        expect(dependencies.create).not.toHaveBeenCalled();
        expect(dependencies.update).not.toHaveBeenCalled();
      }
    },
  );

  it.each(
    operationCases.flatMap((operation) => [
      ['disabled', operation, () => ({ kind: 'DISABLED' as const })],
      ['unauthorized', operation, () => ({ kind: 'UNAUTHORIZED' as const })],
      ['stale', operation, () => ({ kind: 'STALE' as const })],
      [
        'head changed',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({ ...trust, currentHeadSha: 'new-head' }),
      ],
      [
        'owner changed',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          expectedBotAuthorId: 722,
          reference: { ...trust.reference, ownerId: '722' },
        }),
      ],
      [
        'reference changed',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          reference: { ...trust.reference, invocationId: 'stolen-reference' },
        }),
      ],
      [
        'fence stolen',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          currentPublication: {
            status:
              operation.operation === 'CREATE'
                ? ('CREATE_STARTED' as const)
                : ('PATCH_STARTED' as const),
            version: 5,
            publicationFence: 'stolen-fence',
            ...(operation.operation === 'PATCH' ? { commentId: 991 } : {}),
          },
        }),
      ],
      [
        'version changed',
        operation,
        (trust: ReturnType<typeof makeTrust>) => ({
          ...trust,
          currentPublication: {
            status:
              operation.operation === 'CREATE'
                ? ('CREATE_STARTED' as const)
                : ('PATCH_STARTED' as const),
            version: 6,
            publicationFence: operation.operation === 'CREATE' ? 'create-fence' : 'patch-fence',
            ...(operation.operation === 'PATCH' ? { commentId: 991 } : {}),
          },
        }),
      ],
    ]),
  )(
    'settles fenced UNCERTAIN without I/O after reservation when %s on %s',
    async (_name, operation, finalGuard) => {
      const { dependencies, trust } = makeOperationDependencies(operation);
      const active = activeMocks(operation, dependencies);
      const reserve = active.reserve.getMockImplementation();
      active.reserve.mockImplementation(async (...args) => {
        const reservation = await reserve!(...args);
        const next = typeof finalGuard === 'function' ? finalGuard(trust) : finalGuard;
        dependencies.guard.mockResolvedValueOnce(next);
        return reservation;
      });

      await expect(
        publishExplanationOutcome(publicationInput(operation.channel), dependencies),
      ).resolves.toEqual({
        kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
        channel: operation.channel,
      });

      expect(active.write).not.toHaveBeenCalled();
      expect(dependencies.create).not.toHaveBeenCalled();
      expect(dependencies.update).not.toHaveBeenCalled();
      expect(active.settle).toHaveBeenCalledWith(
        dependencies.db,
        expect.objectContaining({
          expectedPublicationVersion: 5,
          publicationFence: operation.operation === 'CREATE' ? 'create-fence' : 'patch-fence',
          outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES.UNCERTAIN,
        }),
      );
    },
  );

  it.each(operationCases)(
    'settles UNCERTAIN without I/O when the post-reservation state changes on $name',
    async (operation) => {
      const { dependencies, trust } = makeOperationDependencies(operation);
      const active = activeMocks(operation, dependencies);
      const reserve = active.reserve.getMockImplementation();
      active.reserve.mockImplementation(async (...args) => {
        const reservation = await reserve!(...args);
        dependencies.guard.mockResolvedValueOnce({
          ...trust,
          currentPublication:
            operation.operation === 'CREATE'
              ? { status: 'NOT_STARTED', version: 5 }
              : { status: 'PUBLISHED', version: 5, commentId: 991 },
        });
        return reservation;
      });

      await expect(
        publishExplanationOutcome(publicationInput(operation.channel), dependencies),
      ).resolves.toEqual({
        kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
        channel: operation.channel,
      });

      expect(active.reserve).toHaveBeenCalledTimes(1);
      expect(active.write).not.toHaveBeenCalled();
      expect(dependencies.create).not.toHaveBeenCalled();
      expect(dependencies.update).not.toHaveBeenCalled();
      expect(active.settle).toHaveBeenCalledTimes(1);
      expect(active.settle).toHaveBeenCalledWith(
        dependencies.db,
        expect.objectContaining({
          expectedPublicationVersion: 5,
          publicationFence: operation.operation === 'CREATE' ? 'create-fence' : 'patch-fence',
          outcome: EXPLANATION_PUBLICATION_CREATE_OUTCOMES.UNCERTAIN,
        }),
      );
    },
  );

  it.each(operationCases)(
    'contains every non-reserved or thrown reservation for $name',
    async (operation) => {
      for (const status of ['observed', 'invalid', 'unavailable'] as const) {
        const { dependencies } = makeOperationDependencies(operation);
        const active = activeMocks(operation, dependencies);
        active.reserve.mockResolvedValue({ status });

        await expect(
          publishExplanationOutcome(publicationInput(operation.channel), dependencies),
        ).resolves.toEqual({
          kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
          channel: operation.channel,
        });
        expect(dependencies.reserveCreate).toHaveBeenCalledTimes(
          operation.operation === 'CREATE' ? 1 : 0,
        );
        expect(dependencies.reservePatch).toHaveBeenCalledTimes(
          operation.operation === 'PATCH' ? 1 : 0,
        );
        expect(dependencies.create).not.toHaveBeenCalled();
        expect(dependencies.update).not.toHaveBeenCalled();
        expect(dependencies.settleCreate).not.toHaveBeenCalled();
        expect(dependencies.settlePatch).not.toHaveBeenCalled();
      }

      const { dependencies } = makeOperationDependencies(operation);
      const active = activeMocks(operation, dependencies);
      active.reserve.mockRejectedValueOnce(new Error('reservation unavailable'));
      await expect(
        publishExplanationOutcome(publicationInput(operation.channel), dependencies),
      ).resolves.toEqual({
        kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
        channel: operation.channel,
      });
      expect(active.reserve).toHaveBeenCalledTimes(1);
      expect(dependencies.create).not.toHaveBeenCalled();
      expect(dependencies.update).not.toHaveBeenCalled();
      expect(dependencies.settleCreate).not.toHaveBeenCalled();
      expect(dependencies.settlePatch).not.toHaveBeenCalled();
    },
  );

  it.each(operationCases)(
    'does not retry a $operation write or fallback channel after forge or settlement uncertainty on $name',
    async (operation) => {
      const failedWrite = makeOperationDependencies(operation);
      const write = activeMocks(operation, failedWrite.dependencies).write;
      write.mockRejectedValueOnce(new Error('forge unavailable'));

      await expect(
        publishExplanationOutcome(publicationInput(operation.channel), failedWrite.dependencies),
      ).resolves.toEqual({
        kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS,
        channel: operation.channel,
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(failedWrite.dependencies.create).toHaveBeenCalledTimes(
        operation.operation === 'CREATE' ? 1 : 0,
      );
      expect(failedWrite.dependencies.update).toHaveBeenCalledTimes(
        operation.operation === 'PATCH' ? 1 : 0,
      );
      expect(failedWrite.dependencies.settleCreate).toHaveBeenCalledTimes(
        operation.operation === 'CREATE' ? 1 : 0,
      );
      expect(failedWrite.dependencies.settlePatch).toHaveBeenCalledTimes(
        operation.operation === 'PATCH' ? 1 : 0,
      );

      for (const status of ['invalid', 'observed', 'unavailable'] as const) {
        const nonsettled = makeOperationDependencies(operation);
        const active = activeMocks(operation, nonsettled.dependencies);
        active.settle.mockResolvedValue({ status });
        await expect(
          publishExplanationOutcome(publicationInput(operation.channel), nonsettled.dependencies),
        ).resolves.toEqual({
          kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS,
          channel: operation.channel,
        });
        expect(active.write).toHaveBeenCalledTimes(1);
        expect(active.settle).toHaveBeenCalledTimes(1);
        expect(nonsettled.dependencies.create).toHaveBeenCalledTimes(
          operation.operation === 'CREATE' ? 1 : 0,
        );
        expect(nonsettled.dependencies.update).toHaveBeenCalledTimes(
          operation.operation === 'PATCH' ? 1 : 0,
        );
      }

      const throwingSettlement = makeOperationDependencies(operation);
      const throwingActive = activeMocks(operation, throwingSettlement.dependencies);
      throwingActive.settle.mockRejectedValueOnce(new Error('settlement unavailable'));
      await expect(
        publishExplanationOutcome(
          publicationInput(operation.channel),
          throwingSettlement.dependencies,
        ),
      ).resolves.toEqual({
        kind: EXPLANATION_PUBLICATION_RESULT.AMBIGUOUS,
        channel: operation.channel,
      });
      expect(throwingActive.write).toHaveBeenCalledTimes(1);
      expect(throwingActive.settle).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    operationCases.flatMap((operation) =>
      [
        EXPLANATION_OUTCOME.DISABLED,
        EXPLANATION_OUTCOME.UNAUTHORIZED,
        EXPLANATION_OUTCOME.STALE,
      ].map((kind) => [operation, kind] as const),
    ),
  )('preserves forbidden $2 outcomes and does no work for $1.name', async (operation, kind) => {
    const { dependencies } = makeOperationDependencies(operation);
    const outcome = Object.freeze({
      kind,
      reason: 'Publication is forbidden for this terminal outcome.',
    });

    await expect(
      publishExplanationOutcome({ ...publicationInput(operation.channel), outcome }, dependencies),
    ).resolves.toEqual({
      kind: EXPLANATION_PUBLICATION_RESULT.NOT_PUBLISHED,
      channel: operation.channel,
    });

    expect(outcome.kind).toBe(kind);
    expect(dependencies.guard).not.toHaveBeenCalled();
    expect(dependencies.reserveCreate).not.toHaveBeenCalled();
    expect(dependencies.reservePatch).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
  });
});
