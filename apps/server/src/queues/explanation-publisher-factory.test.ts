import { EXPLANATION_OUTCOME, type ExplanationRequest } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  createDatabaseFromEnv: vi.fn(),
  getEffectiveRepoSettings: vi.fn(),
  getInstallationById: vi.fn(),
  getRepositoryById: vi.fn(),
  lookupExplanationInvocation: vi.fn(),
  markExplanationPublicationStale: vi.fn(),
  reserveExplanationPublicationCreate: vi.fn(),
  reserveExplanationPublicationPatch: vi.fn(),
  settleExplanationPublicationCreate: vi.fn(),
  settleExplanationPublicationPatch: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({
  getCurrentExplanationActorAuthorization: vi.fn(),
  getInstallationToken: vi.fn(),
  resolveGitHubAppBotAuthorId: vi.fn(),
}));
const adapterMocks = vi.hoisted(() => ({ makeGitHubAdapter: vi.fn() }));

vi.mock('ghagga-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ghagga-db')>()),
  ...databaseMocks,
}));
vi.mock('../github/client.js', () => clientMocks);
vi.mock('../github/forge-adapter-factory.js', () => adapterMocks);

import { EXPLANATION_PUBLICATION_RESULT } from './explanation-publication.js';
import { createPersistedExplanationPublisher } from './explanation-publisher-factory.js';

const request: ExplanationRequest = {
  identity: {
    forgeInstance: 'github.com',
    installationId: '43',
    actorId: '42',
    repositoryId: '44',
    pullRequestNumber: 45,
    requestedHeadSha: 'requested-head',
    sourceCommentId: '41',
    questionHash: 'a'.repeat(64),
  },
  question: 'Why was this changed?',
};

describe('createPersistedExplanationPublisher', () => {
  beforeEach(() => {
    for (const mock of Object.values(databaseMocks)) mock.mockReset();
    for (const mock of Object.values(clientMocks)) mock.mockReset();
    adapterMocks.makeGitHubAdapter.mockReset();
    databaseMocks.createDatabaseFromEnv.mockReturnValue({});
    databaseMocks.getRepositoryById.mockResolvedValue(repository());
    databaseMocks.getInstallationById.mockResolvedValue({
      id: 201,
      githubInstallationId: 43,
      isActive: true,
    });
    databaseMocks.getEffectiveRepoSettings.mockResolvedValue({
      settings: { explanationsEnabled: true },
    });
    clientMocks.getInstallationToken.mockResolvedValue('fresh-installation-token');
    clientMocks.resolveGitHubAppBotAuthorId.mockResolvedValue({ kind: 'RESOLVED', id: 88 });
    clientMocks.getCurrentExplanationActorAuthorization.mockResolvedValue({ kind: 'AUTHORIZED' });
  });

  it('constructs without I/O and keeps forbidden outcomes inactive', async () => {
    const publisher = createPersistedExplanationPublisher();

    await expect(
      publisher({
        identity: request.identity,
        request,
        repositoryDbId: 101,
        actorLogin: 'maintainer',
        outcome: { kind: EXPLANATION_OUTCOME.DISABLED, reason: 'disabled' },
      }),
    ).resolves.toBeUndefined();

    expect(databaseMocks.createDatabaseFromEnv).not.toHaveBeenCalled();
    expect(databaseMocks.lookupExplanationInvocation).not.toHaveBeenCalled();
  });

  it('uses the real coordinator to reserve, recheck, create, and settle one exact answer projection', async () => {
    const initial = invocationRow({
      answerPublicationStatus: 'NOT_STARTED',
      answerPublicationVersion: 0,
    });
    const reserved = invocationRow({
      answerPublicationStatus: 'CREATE_STARTED',
      answerPublicationVersion: 1,
      answerPublicationFence: 'publication-fence',
    });
    const adapter = {
      fetchChangeRequest: vi.fn().mockResolvedValue({ headSha: request.identity.requestedHeadSha }),
      lookupExplanationComment: vi.fn().mockResolvedValue({ kind: 'ABSENT' }),
      createExplanationComment: vi.fn().mockResolvedValue({
        kind: 'github:issue-comment',
        raw: 901,
      }),
      updateExplanationComment: vi.fn(),
    };
    databaseMocks.lookupExplanationInvocation
      .mockResolvedValueOnce({ status: 'found', invocation: initial })
      .mockResolvedValueOnce({ status: 'found', invocation: reserved });
    databaseMocks.reserveExplanationPublicationCreate.mockResolvedValue({
      status: 'reserved',
      invocation: reserved,
      publicationFence: 'publication-fence',
    });
    databaseMocks.settleExplanationPublicationCreate.mockResolvedValue({
      status: 'settled',
      invocation: reserved,
    });
    adapterMocks.makeGitHubAdapter.mockReturnValue(adapter);

    await expect(
      createPersistedExplanationPublisher({
        credentials: () => ({ appId: 'app-id', privateKey: 'private-key' }),
      })(confirmed()),
    ).resolves.toMatchObject({ kind: 'PUBLISHED', channel: 'answer' });

    expect(databaseMocks.reserveExplanationPublicationCreate).toHaveBeenCalledBefore(
      adapter.createExplanationComment,
    );
    expect(databaseMocks.lookupExplanationInvocation).toHaveBeenCalledTimes(2);
    expect(adapter.createExplanationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: '44',
        ownerId: '88',
        channel: 'answer',
        invocationId: expect.any(String),
      }),
      'answer body',
    );
    expect(databaseMocks.settleExplanationPublicationCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'answer',
        expectedPublicationVersion: 1,
        expectedBotAuthorId: 88,
        publicationFence: 'publication-fence',
        commentId: 901,
      }),
    );
  });

  it('durably replays a stale answer publication without external writes or outcome changes', async () => {
    const initial = invocationRow({
      answerPublicationStatus: 'NOT_STARTED',
      answerPublicationVersion: 0,
    });
    const stale = invocationRow({
      answerPublicationStatus: 'STALE',
      answerPublicationVersion: 0,
    });
    const adapter = {
      fetchChangeRequest: vi.fn().mockResolvedValue({ headSha: 'superseding-head' }),
      lookupExplanationComment: vi.fn(),
      createExplanationComment: vi.fn(),
      updateExplanationComment: vi.fn(),
    };
    databaseMocks.lookupExplanationInvocation.mockResolvedValue({
      status: 'found',
      invocation: initial,
    });
    databaseMocks.markExplanationPublicationStale.mockResolvedValue({
      status: 'stale',
      invocation: stale,
    });
    adapterMocks.makeGitHubAdapter.mockReturnValue(adapter);

    await expect(
      createPersistedExplanationPublisher({
        credentials: () => ({ appId: 'app-id', privateKey: 'private-key' }),
      })(confirmed()),
    ).resolves.toEqual({
      kind: EXPLANATION_PUBLICATION_RESULT.STALE,
      channel: 'answer',
    });

    expect(databaseMocks.markExplanationPublicationStale).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'answer',
        requestedHeadSha: request.identity.requestedHeadSha,
        question: request.question,
      }),
    );
    expect(adapter.createExplanationComment).not.toHaveBeenCalled();
    expect(adapter.updateExplanationComment).not.toHaveBeenCalled();
    expect(databaseMocks.reserveExplanationPublicationCreate).not.toHaveBeenCalled();
    expect(databaseMocks.reserveExplanationPublicationPatch).not.toHaveBeenCalled();
    expect(stale).toMatchObject({
      executionStatus: 'ANSWERED',
      outcomeStatus: 'ANSWERED',
      outcomeAnswer: 'answer body',
    });
  });

  it('keeps adapters and principals local across concurrent invocations', async () => {
    const references: Array<{ ownerId: string; repositoryId: string; body: string }> = [];
    const publicationReservations = new Set<string>();
    databaseMocks.lookupExplanationInvocation.mockImplementation(async (_db, input) => {
      const first = input.repositoryId === '44';
      const outcome = first ? confirmed().outcome : secondConfirmed().outcome;
      return {
        status: 'found',
        invocation: invocationRow({
          ...input,
          requestedHeadSha: first ? 'head-a' : 'head-b',
          outcomeStatus: outcome.kind,
          outcomeAnswer: outcome.answer,
          outcomePayload: outcome,
          answerPublicationStatus: publicationReservations.has(input.repositoryId)
            ? 'CREATE_STARTED'
            : 'NOT_STARTED',
          answerPublicationVersion: publicationReservations.has(input.repositoryId) ? 1 : 0,
          answerPublicationFence: publicationReservations.has(input.repositoryId)
            ? `fence-${input.repositoryId}`
            : null,
        }),
      };
    });
    databaseMocks.getRepositoryById.mockImplementation(async (_db, id) =>
      repository(id === 101 ? 44 : 55),
    );
    clientMocks.getInstallationToken.mockImplementation(async (_id, _app, _key, options) =>
      options?.repositoryIds?.[0] === 44 ? 'token-a' : 'token-b',
    );
    clientMocks.resolveGitHubAppBotAuthorId.mockImplementation(async (_app, _key, token) => ({
      kind: 'RESOLVED',
      id: token === 'token-a' ? 88 : 99,
    }));
    adapterMocks.makeGitHubAdapter.mockImplementation(({ token }) => ({
      fetchChangeRequest: vi
        .fn()
        .mockResolvedValue({ headSha: token === 'token-a' ? 'head-a' : 'head-b' }),
      lookupExplanationComment: vi.fn().mockResolvedValue({ kind: 'ABSENT' }),
      createExplanationComment: vi.fn(async (reference, body) => {
        references.push({ ownerId: reference.ownerId, repositoryId: reference.repositoryId, body });
        return { kind: 'github:issue-comment', raw: token === 'token-a' ? 11 : 12 };
      }),
      updateExplanationComment: vi.fn(),
    }));
    databaseMocks.reserveExplanationPublicationCreate.mockImplementation(async (_db, input) => {
      publicationReservations.add(input.repositoryId);
      return {
        status: 'reserved',
        invocation: invocationRow({
          ...input,
          requestedHeadSha: input.repositoryId === '44' ? 'head-a' : 'head-b',
          outcomePayload:
            input.repositoryId === '44' ? confirmed().outcome : secondConfirmed().outcome,
          outcomeAnswer: input.repositoryId === '44' ? 'answer body' : 'other answer',
          answerPublicationStatus: 'CREATE_STARTED',
          answerPublicationVersion: 1,
          answerPublicationFence: `fence-${input.repositoryId}`,
        }),
        publicationFence: `fence-${input.repositoryId}`,
      };
    });
    databaseMocks.settleExplanationPublicationCreate.mockResolvedValue({ status: 'settled' });
    const firstRequest: ExplanationRequest = {
      ...request,
      identity: { ...request.identity, requestedHeadSha: 'head-a' },
    };

    await expect(
      Promise.all([
        createPersistedExplanationPublisher({
          credentials: () => ({ appId: 'app-id', privateKey: 'private-key' }),
        })({
          ...confirmed(),
          identity: firstRequest.identity,
          request: firstRequest,
        }),
        createPersistedExplanationPublisher({
          credentials: () => ({ appId: 'app-id', privateKey: 'private-key' }),
        })(secondConfirmed()),
      ]),
    ).resolves.toHaveLength(2);

    expect(references).toEqual(
      expect.arrayContaining([
        { ownerId: '88', repositoryId: '44', body: 'answer body' },
        { ownerId: '99', repositoryId: '55', body: 'other answer' },
      ]),
    );
  });
});

function confirmed() {
  return {
    identity: request.identity,
    request,
    repositoryDbId: 101,
    actorLogin: 'maintainer',
    outcome: {
      kind: EXPLANATION_OUTCOME.ANSWERED,
      answer: 'answer body',
      metadata: { provider: 'gateway', model: 'fixed', tokensUsed: 1 },
    },
  } as const;
}

function secondConfirmed() {
  const secondRequest: ExplanationRequest = {
    ...request,
    identity: {
      ...request.identity,
      repositoryId: '55',
      sourceCommentId: '52',
      requestedHeadSha: 'head-b',
      questionHash: 'b'.repeat(64),
    },
    question: 'What changed next?',
  };
  return {
    identity: secondRequest.identity,
    request: secondRequest,
    repositoryDbId: 102,
    actorLogin: 'other-maintainer',
    outcome: {
      kind: EXPLANATION_OUTCOME.ANSWERED,
      answer: 'other answer',
      metadata: { provider: 'p', model: 'm', tokensUsed: 1 },
    },
  } as const;
}

function repository(githubRepoId = 44) {
  return {
    id: githubRepoId === 44 ? 101 : 102,
    githubRepoId,
    installationId: 201,
    fullName: githubRepoId === 44 ? 'acme/widget' : 'acme/other',
    isActive: true,
  };
}

function invocationRow(overrides: Record<string, unknown> = {}) {
  return {
    ...request.identity,
    question: request.question,
    executionStatus: 'ANSWERED',
    outcomeStatus: 'ANSWERED',
    outcomeAnswer: 'answer body',
    outcomePayload: confirmed().outcome,
    outcomeCompletedAt: new Date(),
    answerPublicationStatus: 'NOT_STARTED',
    answerPublicationVersion: 0,
    answerCommentId: null,
    answerPublicationFence: null,
    ...overrides,
  };
}
