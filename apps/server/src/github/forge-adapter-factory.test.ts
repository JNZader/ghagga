import { afterEach, describe, expect, it, vi } from 'vitest';

const binding = {
  forgeInstance: 'github.com',
  installationId: 'installation-42',
  repositoryId: 'repository-99',
} as const;

const identity = {
  ...binding,
  actorId: 'actor-7',
  pullRequestNumber: 42,
  requestedHeadSha: 'head-abc',
  sourceCommentId: 'comment-123',
  questionHash: 'question-hash',
} as const;

const changeRequest = {
  repo: { kind: 'github' as const, nativeId: binding.repositoryId, path: 'octo/example' },
  iid: 42,
  globalId: 'PR_kwDOExample',
} as const;

async function loadFactory(client: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('./client.js', () => client);
  return import('./forge-adapter-factory.js');
}

afterEach(() => {
  vi.doUnmock('./client.js');
  vi.resetModules();
});

describe('makeGitHubAdapter explanation snapshot wiring', () => {
  it('binds the real adapter to a lazy revision-pinned snapshot reader without publication', async () => {
    const fetchRevisionPinnedSnapshot = vi.fn().mockResolvedValue({
      repositoryId: binding.repositoryId,
      baseSha: 'base-abc',
      headSha: identity.requestedHeadSha,
      diff: 'diff --git a/a.ts b/a.ts',
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    });
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });

    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-a',
      explanationBinding: binding,
    });

    expect('fetchExplanationSnapshot' in adapter).toBe(true);
    expect('lookupExplanationComment' in adapter).toBe(false);
    expect('createExplanationComment' in adapter).toBe(false);
    expect('updateExplanationComment' in adapter).toBe(false);
    await expect(adapter.fetchExplanationSnapshot?.(identity, changeRequest)).resolves.toEqual({
      kind: 'SNAPSHOT',
      snapshot: {
        repositoryId: binding.repositoryId,
        baseSha: 'base-abc',
        headSha: identity.requestedHeadSha,
        diff: 'diff --git a/a.ts b/a.ts',
        files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
      },
    });
    expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledWith(
      'octo',
      'example',
      42,
      identity.requestedHeadSha,
      'installation-token-a',
    );
  });

  it('keeps a legacy adapter operational when the partial client mock omits snapshot exports', async () => {
    const fetchPRDetails = vi.fn().mockResolvedValue({
      headSha: 'legacy-head',
      baseBranch: 'main',
      prAuthor: 'octocat',
    });
    const { makeGitHubAdapter } = await loadFactory({ fetchPRDetails });

    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'legacy-installation-token',
    });

    expect('fetchExplanationSnapshot' in adapter).toBe(false);
    await expect(adapter.fetchChangeRequest(changeRequest)).resolves.toMatchObject({
      headSha: 'legacy-head',
      baseBranch: 'main',
      author: { login: 'octocat' },
    });
    expect(fetchPRDetails).toHaveBeenCalledWith('octo', 'example', 42, 'legacy-installation-token');
  });

  it('does not advertise snapshot capability when a bound mock explicitly lacks it', async () => {
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot: undefined });

    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-b',
      explanationBinding: binding,
    });

    expect('fetchExplanationSnapshot' in adapter).toBe(false);
  });

  it('returns invalid before client I/O for a mismatched repository binding', async () => {
    const fetchRevisionPinnedSnapshot = vi.fn();
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });
    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-a',
      explanationBinding: binding,
    });

    await expect(
      adapter.fetchExplanationSnapshot?.(
        { ...identity, repositoryId: 'different-repository' },
        changeRequest,
      ),
    ).resolves.toEqual({
      kind: 'INVALID',
      reason: 'Explanation identity is not bound to this change request',
    });
    expect(fetchRevisionPinnedSnapshot).not.toHaveBeenCalled();
  });

  it('preserves stale and operational snapshot outcomes without a live fallback', async () => {
    const fetchRevisionPinnedSnapshot = vi.fn();
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });
    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-a',
      explanationBinding: binding,
    });
    fetchRevisionPinnedSnapshot.mockResolvedValueOnce({
      repositoryId: binding.repositoryId,
      baseSha: 'base-abc',
      headSha: 'superseded-head',
      diff: 'diff --git a/a.ts b/a.ts',
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    });

    await expect(adapter.fetchExplanationSnapshot?.(identity, changeRequest)).resolves.toEqual({
      kind: 'STALE',
      reason: 'Requested head SHA is superseded',
    });
    fetchRevisionPinnedSnapshot.mockRejectedValueOnce(new Error('snapshot transport failure'));
    await expect(adapter.fetchExplanationSnapshot?.(identity, changeRequest)).rejects.toThrow(
      'snapshot transport failure',
    );
    expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID for a missing pinned snapshot without attempting a live fallback', async () => {
    const fetchRevisionPinnedSnapshot = vi.fn().mockResolvedValue(null);
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });
    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-null-snapshot',
      explanationBinding: binding,
    });

    await expect(adapter.fetchExplanationSnapshot?.(identity, changeRequest)).resolves.toEqual({
      kind: 'INVALID',
      reason: 'Revision-pinned snapshot is missing',
    });
    expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledWith(
      'octo',
      'example',
      42,
      identity.requestedHeadSha,
      'installation-token-null-snapshot',
    );
    expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    'maps revision-pinned snapshot HTTP %i failures to ForgeAuthError with the bound token',
    async (status) => {
      const fetchRevisionPinnedSnapshot = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error(`GitHub rejected request (${status})`), { status }),
        );
      const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });
      const adapter = makeGitHubAdapter({
        owner: 'octo',
        repo: 'example',
        token: 'installation-token-auth-failure',
        explanationBinding: binding,
      });

      await expect(
        adapter.fetchExplanationSnapshot?.(identity, changeRequest),
      ).rejects.toMatchObject({
        name: 'ForgeAuthError',
        status,
      });
      expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledWith(
        'octo',
        'example',
        42,
        identity.requestedHeadSha,
        'installation-token-auth-failure',
      );
      expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps bindings and installation tokens isolated per adapter instance', async () => {
    const fetchRevisionPinnedSnapshot = vi.fn().mockResolvedValue({
      repositoryId: 'repository-second',
      baseSha: 'base-second',
      headSha: 'head-second',
      diff: 'diff --git a/b.ts b/b.ts',
      files: [{ path: 'src/b.ts', content: 'export const b = 2;\n' }],
    });
    const { makeGitHubAdapter } = await loadFactory({ fetchRevisionPinnedSnapshot });
    const secondBinding = {
      forgeInstance: 'github.com',
      installationId: 'installation-43',
      repositoryId: 'repository-second',
    } as const;
    const secondIdentity = {
      ...secondBinding,
      actorId: 'actor-8',
      pullRequestNumber: 43,
      requestedHeadSha: 'head-second',
      sourceCommentId: 'comment-124',
      questionHash: 'question-hash-2',
    } as const;
    const secondChangeRequest = {
      repo: { kind: 'github' as const, nativeId: secondBinding.repositoryId, path: 'octo/second' },
      iid: 43,
    } as const;
    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'second',
      token: 'installation-token-second',
      explanationBinding: secondBinding,
    });

    await expect(
      adapter.fetchExplanationSnapshot?.(secondIdentity, secondChangeRequest),
    ).resolves.toMatchObject({
      kind: 'SNAPSHOT',
      snapshot: {
        repositoryId: secondBinding.repositoryId,
        headSha: secondIdentity.requestedHeadSha,
      },
    });
    expect(fetchRevisionPinnedSnapshot).toHaveBeenCalledWith(
      'octo',
      'second',
      43,
      'head-second',
      'installation-token-second',
    );
  });

  it('wires all explanation publication delegates lazily when the client exposes the complete seam', async () => {
    const findExplanationComment = vi.fn().mockResolvedValue({ kind: 'ABSENT' });
    const createExplanationComment = vi.fn().mockResolvedValue({ id: 501 });
    const updateExplanationComment = vi.fn().mockResolvedValue(undefined);
    const { makeGitHubAdapter } = await loadFactory({
      fetchRevisionPinnedSnapshot: undefined,
      findExplanationComment,
      createExplanationComment,
      updateExplanationComment,
    });
    const adapter = makeGitHubAdapter({
      owner: 'octo',
      repo: 'example',
      token: 'installation-token-publication',
      explanationBinding: binding,
    });
    const reference = {
      ...binding,
      changeRequest,
      ownerId: '42',
      channel: 'answer' as const,
      invocationId: 'invocation-1',
    };

    expect('lookupExplanationComment' in adapter).toBe(true);
    expect('createExplanationComment' in adapter).toBe(true);
    expect('updateExplanationComment' in adapter).toBe(true);
    await expect(adapter.lookupExplanationComment?.(reference)).resolves.toEqual({
      kind: 'ABSENT',
    });
    await expect(adapter.createExplanationComment?.(reference, 'answer')).resolves.toEqual({
      kind: 'github:issue-comment',
      raw: 501,
    });
    await expect(
      adapter.updateExplanationComment?.(
        reference,
        { kind: 'github:issue-comment', raw: 501 },
        'answer',
      ),
    ).resolves.toBeUndefined();
    expect(findExplanationComment).toHaveBeenCalledWith(
      'octo',
      'example',
      42,
      reference,
      'installation-token-publication',
    );
    expect(createExplanationComment).toHaveBeenCalledWith(
      'octo',
      'example',
      42,
      reference,
      'answer',
      'installation-token-publication',
    );
    expect(updateExplanationComment).toHaveBeenCalledWith(
      'octo',
      'example',
      501,
      reference,
      'answer',
      'installation-token-publication',
    );
  });
});
