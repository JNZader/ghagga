import { describe, expect, it, vi } from 'vitest';
import { type ForgeAuthError, isForgeAuthError } from '../../errors.js';
import type {
  FileReadCapable,
  ForgeAdapter,
  GraphReadCapable,
  ReactionCapable,
  SearchCapable,
} from '../../ports/forge-adapter.js';
import { REACTION_KIND } from '../../ports/forge-adapter.js';
import type { ChangeRequestRef, CommentId, CommentMarker, RepoRef } from '../../types.js';
import { ACTOR_KIND, FORGE_KIND } from '../../types.js';
import type { GitHubClientPort } from './github-client-port.js';
import { GitHubForgeAdapter } from './github-forge-adapter.js';

const OWNER = 'octo';
const REPO = 'demo';
const TOKEN = 'tok-123';
const PR = 42;

const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: 'node-1', path: `${OWNER}/${REPO}` };
const ref: ChangeRequestRef = { repo, iid: PR };
const marker: CommentMarker = { html: '<!-- ghagga-review -->' };

/** A fully-stubbed GitHubClientPort; tests override individual fns. */
function makeClient(overrides: Partial<GitHubClientPort> = {}): GitHubClientPort {
  return {
    fetchPRDiff: vi.fn().mockResolvedValue('diff --git a b'),
    fetchPRDetails: vi
      .fn()
      .mockResolvedValue({ headSha: 'sha-head', baseBranch: 'main', prAuthor: 'alice' }),
    getPRFileList: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts']),
    getPRCommitMessages: vi.fn().mockResolvedValue(['feat: x', 'fix: y']),
    postComment: vi.fn().mockResolvedValue({ id: 1000 }),
    findExistingComment: vi.fn().mockResolvedValue(null),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    updateComment: vi.fn().mockResolvedValue(undefined),
    addCommentReaction: vi.fn().mockResolvedValue(undefined),
    fetchGraphFromBranch: vi.fn().mockResolvedValue(null),
    fetchGraphMetadata: vi.fn().mockResolvedValue(null),
    fetchFileContents: vi.fn().mockResolvedValue('export const x = 1;\n'),
    searchCode: vi.fn().mockResolvedValue(['src/a.ts']),
    ...overrides,
  };
}

function makeAdapter(client: GitHubClientPort): GitHubForgeAdapter {
  return new GitHubForgeAdapter({ client, token: TOKEN, owner: OWNER, repo: REPO });
}

describe('GitHubForgeAdapter — read mappings (task 1.2)', () => {
  it('fetchDiff returns canonical UnifiedDiff from fetchPRDiff', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const diff = await adapter.fetchDiff(ref);
    expect(diff).toEqual({ text: 'diff --git a b' });
    expect(client.fetchPRDiff).toHaveBeenCalledWith(OWNER, REPO, PR, TOKEN);
  });

  it('fetchChangeRequest maps fetchPRDetails to canonical ChangeRequest', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const cr = await adapter.fetchChangeRequest(ref);
    expect(cr).toEqual({
      ref,
      headSha: 'sha-head',
      baseBranch: 'main',
      author: { login: 'alice', kind: ACTOR_KIND.USER },
    });
    expect(client.fetchPRDetails).toHaveBeenCalledWith(OWNER, REPO, PR, TOKEN);
  });

  it('fetchFileList maps bare paths to canonical ChangedFile[] (omits unpopulatable fields)', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const files = await adapter.fetchFileList(ref);
    // HONEST ABSENCE: the GitHub file-list endpoint wrapper exposes only paths,
    // so changeKind/additions/deletions are OMITTED (undefined), not faked as 0.
    expect(files).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
    expect(files[0]?.changeKind).toBeUndefined();
    expect(files[0]?.additions).toBeUndefined();
    expect(files[0]?.deletions).toBeUndefined();
    expect(client.getPRFileList).toHaveBeenCalledWith(OWNER, REPO, PR, TOKEN);
  });

  it('fetchCommits maps messages to canonical Commit[] (omits unpopulatable fields)', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const commits = await adapter.fetchCommits(ref);
    expect(commits.map((c) => c.message)).toEqual(['feat: x', 'fix: y']);
    // HONEST ABSENCE: the commit-list endpoint wrapper returns only messages, so
    // sha/author are OMITTED (undefined), not faked as '' / empty Actor.
    expect(commits[0]?.sha).toBeUndefined();
    expect(commits[0]?.author).toBeUndefined();
    expect(client.getPRCommitMessages).toHaveBeenCalledWith(OWNER, REPO, PR, TOKEN);
  });
});

describe('GitHubForgeAdapter — addReaction (R-5, task 1.2)', () => {
  it('calls addCommentReaction with the unboxed native id + reaction', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const commentId: CommentId = { kind: 'github:issue-comment', raw: 777 };
    await adapter.addReaction(commentId, REACTION_KIND.ROCKET);
    expect(client.addCommentReaction).toHaveBeenCalledWith(OWNER, REPO, 777, 'rocket', TOKEN);
  });

  it('coerces a string raw id to number for the client', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    await adapter.addReaction({ kind: 'github:issue-comment', raw: '888' }, REACTION_KIND.EYES);
    expect(client.addCommentReaction).toHaveBeenCalledWith(OWNER, REPO, 888, 'eyes', TOKEN);
  });

  it('throws TypeError for a malformed (non-numeric) raw id instead of producing NaN', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    await expect(
      adapter.addReaction(
        { kind: 'github:issue-comment', raw: 'not-a-number' },
        REACTION_KIND.EYES,
      ),
    ).rejects.toThrow(TypeError);
    expect(client.addCommentReaction).not.toHaveBeenCalled();
  });
});

describe('GitHubForgeAdapter — upsertSummaryComment (task 1.1b / 1.10, FORGE-UPSERT-005)', () => {
  it('no existing comment: just posts, returns numeric created + empty deleted', async () => {
    const client = makeClient({ findExistingComment: vi.fn().mockResolvedValue(null) });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(result).toEqual({ created: 1000, deleted: [] });
    expect(client.deleteComment).not.toHaveBeenCalled();
    expect(client.updateComment).not.toHaveBeenCalled();
    expect(client.postComment).toHaveBeenCalledWith(OWNER, REPO, PR, 'body', TOKEN);
  });

  it('existing comment: updates latest IN PLACE, then deletes stale, in that order', async () => {
    const calls: string[] = [];
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue({ latestId: 10, staleIds: [20, 30] }),
      updateComment: vi.fn(async (_o, _r, id: number) => {
        calls.push(`update:${id}`);
      }),
      deleteComment: vi.fn(async (_o, _r, id: number) => {
        calls.push(`delete:${id}`);
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(calls).toEqual(['update:10', 'delete:20', 'delete:30']);
    expect(client.updateComment).toHaveBeenCalledWith(OWNER, REPO, 10, 'body', TOKEN);
    expect(client.postComment).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 10, deleted: [20, 30] });
  });

  it('tolerates a 404-style stale-delete failure (best-effort) without undoing the update', async () => {
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue({ latestId: 10, staleIds: [20, 30] }),
      deleteComment: vi.fn(async (_o, _r, id: number) => {
        if (id === 20) throw new Error('GitHub API error: 404 Not Found');
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    // 20 failed (not in deleted), 30 succeeded; the update already happened.
    expect(result).toEqual({ created: 10, deleted: [30] });
    expect(client.updateComment).toHaveBeenCalledOnce();
  });

  it('tolerates a NON-404 stale-delete failure (best-effort) without undoing the update', async () => {
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue({ latestId: 10, staleIds: [20] }),
      deleteComment: vi.fn(async () => {
        throw new Error('GitHub API error: 500 Internal Server Error');
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(result).toEqual({ created: 10, deleted: [] });
    expect(client.updateComment).toHaveBeenCalledOnce();
  });

  it('POST failure (no prior comment) DOES propagate', async () => {
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue(null),
      postComment: vi.fn().mockRejectedValue(new Error('GitHub API error posting comment: 500')),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(
      /posting comment/,
    );
    expect(client.deleteComment).not.toHaveBeenCalled();
  });

  // --- FORGE-UPSERT-005 regression: the old comment must survive a transient
  // update/create failure. Delete must never run BEFORE the new body is
  // confirmed published, so a timeout/5xx never leaves the PR with no review.

  it('REGRESSION: update failure propagates WITHOUT deleting the previous comment', async () => {
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue({ latestId: 10, staleIds: [20] }),
      updateComment: vi
        .fn()
        .mockRejectedValue(new Error('GitHub API error: 503 Service Unavailable')),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(
      /503 Service Unavailable/,
    );
    // The previous review comment (10) and its stale duplicate (20) are both
    // left untouched — no delete call happened at all.
    expect(client.deleteComment).not.toHaveBeenCalled();
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it('REGRESSION: delete of stale duplicates never runs before the update resolves', async () => {
    const calls: string[] = [];
    const client = makeClient({
      findExistingComment: vi.fn().mockResolvedValue({ latestId: 10, staleIds: [20] }),
      updateComment: vi.fn(async () => {
        calls.push('update-start');
        await Promise.resolve();
        calls.push('update-done');
      }),
      deleteComment: vi.fn(async (_o, _r, id: number) => {
        calls.push(`delete:${id}`);
      }),
    });
    const adapter = makeAdapter(client);
    await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(calls).toEqual(['update-start', 'update-done', 'delete:20']);
  });
});

describe('GitHubForgeAdapter — graph read (task 1.2 / 1.12)', () => {
  it('fetchGraph delegates to fetchGraphFromBranch (orphan-ref handled in client)', async () => {
    const graph = { version: 1, rootDir: '.', nodes: {} };
    const client = makeClient({
      fetchGraphFromBranch: vi.fn().mockResolvedValue(graph),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchGraph(repo)).resolves.toBe(graph);
    expect(client.fetchGraphFromBranch).toHaveBeenCalledWith(OWNER, REPO, TOKEN);
  });

  it('fetchGraph returns null when client returns null (404 / malformed handled in client)', async () => {
    const client = makeClient({ fetchGraphFromBranch: vi.fn().mockResolvedValue(null) });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchGraph(repo)).resolves.toBeNull();
  });

  it('fetchGraphMetadata delegates + returns null on absence', async () => {
    const meta = {
      lastIndexedCommit: 'abc',
      lastIndexedAt: '2026-01-01',
      schemaVersion: 1,
      fileCount: 3,
      languages: ['ts'],
      indexDurationMs: 5,
    };
    const client = makeClient({
      fetchGraphMetadata: vi.fn().mockResolvedValueOnce(meta).mockResolvedValueOnce(null),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchGraphMetadata(repo)).resolves.toBe(meta);
    await expect(adapter.fetchGraphMetadata(repo)).resolves.toBeNull();
    expect(client.fetchGraphMetadata).toHaveBeenCalledWith(OWNER, REPO, TOKEN);
  });
});

describe('GitHubForgeAdapter — file read (task ERE-transfer / FileReadCapable)', () => {
  it('fetchFileContents delegates to client with the adapter owner/repo/token (path+ref passed through)', async () => {
    const client = makeClient({
      fetchFileContents: vi.fn().mockResolvedValue('export const x = 1;\n'),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchFileContents(repo, 'src/retry.ts', 'abc123')).resolves.toBe(
      'export const x = 1;\n',
    );
    // The adapter is repo-scoped: owner/repo/token are fixed, path + ref pass through.
    expect(client.fetchFileContents).toHaveBeenCalledWith(
      OWNER,
      REPO,
      'src/retry.ts',
      'abc123',
      TOKEN,
    );
  });

  it('fetchFileContents returns null when the client reports no file (404/dir handled in client)', async () => {
    const client = makeClient({ fetchFileContents: vi.fn().mockResolvedValue(null) });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchFileContents(repo, 'missing.ts', 'main')).resolves.toBeNull();
  });

  it('bridges an OMITTED ref to the client empty-string sentinel (default branch)', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    await adapter.fetchFileContents(repo, 'src/a.ts'); // no ref → default branch
    expect(client.fetchFileContents).toHaveBeenCalledWith(OWNER, REPO, 'src/a.ts', '', TOKEN);
  });

  it('reclassifies a 401/403 to ForgeAuthError (P2 recovery), never swallows it as null', async () => {
    const client = makeClient({
      fetchFileContents: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom 401'), { status: 401 })),
    });
    const adapter = makeAdapter(client);
    // Wrapped in #mapAuth like the base reads, so the in-job token re-mint seam fires.
    const err = await adapter.fetchFileContents(repo, 'src/a.ts', 'main').catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(401);
  });

  it('propagates a non-auth fault unchanged (does NOT swallow it as null)', async () => {
    const client = makeClient({
      fetchFileContents: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom 500'), { status: 500 })),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.fetchFileContents(repo, 'src/a.ts', 'main')).rejects.toThrow('boom 500');
  });
});

describe('GitHubForgeAdapter — code search (task ERE-transfer / SearchCapable)', () => {
  it('searchCode delegates to client with the adapter owner/repo/token (term+limit passed through)', async () => {
    const client = makeClient({
      searchCode: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts']),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.searchCode(repo, 'fetchGraph', 5)).resolves.toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    // The adapter is repo-scoped: owner/repo/token are fixed, term + limit pass through.
    expect(client.searchCode).toHaveBeenCalledWith(OWNER, REPO, 'fetchGraph', 5, TOKEN);
  });

  it('reclassifies a genuine 401/403 to ForgeAuthError (P2 recovery)', async () => {
    const client = makeClient({
      searchCode: vi.fn().mockRejectedValue(Object.assign(new Error('boom 401'), { status: 401 })),
    });
    const adapter = makeAdapter(client);
    const err = await adapter.searchCode(repo, 'fetchGraph', 5).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(401);
  });
});

describe('GitHubForgeAdapter — capability shape', () => {
  it('satisfies ForgeAdapter (base) and is assignable to ReactionCapable + GraphReadCapable + FileReadCapable + SearchCapable', () => {
    const adapter = makeAdapter(makeClient());
    // Compile-time + runtime: it IS a ForgeAdapter.
    const asForge: ForgeAdapter = adapter;
    const asReaction: ReactionCapable = adapter;
    const asGraph: GraphReadCapable = adapter;
    const asFileRead: FileReadCapable = adapter;
    const asSearch: SearchCapable = adapter;
    expect(typeof asReaction.addReaction).toBe('function');
    // BOTH graph methods co-present.
    expect(typeof asGraph.fetchGraph).toBe('function');
    expect(typeof asGraph.fetchGraphMetadata).toBe('function');
    // FileReadCapable present (narrowed by method-presence, not a capabilities flag).
    expect(typeof asFileRead.fetchFileContents).toBe('function');
    expect('fetchFileContents' in adapter).toBe(true);
    // SearchCapable present (narrowed by method-presence, not a capabilities flag).
    expect(typeof asSearch.searchCode).toBe('function');
    expect('searchCode' in adapter).toBe(true);
    // capabilities hint reflects the implemented surface.
    expect(asForge.capabilities).toEqual({
      reactions: true,
      inlineComments: false,
      graphRead: true,
    });
  });

  it('does NOT implement publishInline (inline deferred)', () => {
    const adapter = makeAdapter(makeClient());
    expect('publishInline' in adapter).toBe(false);
  });
});

// ─── 401/403 → ForgeAuthError reclassification (P2 401-recovery FIX 2) ──
describe('GitHubForgeAdapter — auth-error surfacing (P2 401-recovery)', () => {
  /** A GitHub-client-shaped error carrying an HTTP status (like GitHubApiError). */
  function statusError(status: number, message = `boom ${status}`): Error {
    return Object.assign(new Error(message), { status });
  }

  it('reclassifies a 401 from postComment as a ForgeAuthError (status preserved)', async () => {
    const client = makeClient({
      postComment: vi.fn().mockRejectedValue(statusError(401, 'GitHub API error posting comment')),
    });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(401);
    // The original error is preserved as the cause for logging.
    expect((err as ForgeAuthError).cause).toBeInstanceOf(Error);
  });

  it('reclassifies a 403 from findExistingComment as a ForgeAuthError', async () => {
    const client = makeClient({
      findExistingComment: vi.fn().mockRejectedValue(statusError(403)),
    });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(403);
  });

  it('reclassifies a 401 from a read (fetchDiff) as a ForgeAuthError', async () => {
    const client = makeClient({
      fetchPRDiff: vi.fn().mockRejectedValue(statusError(401)),
    });
    const adapter = makeAdapter(client);
    const err = await adapter.fetchDiff(ref).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
  });

  it('does NOT reclassify a non-auth (500) error — passes through unchanged', async () => {
    const original = statusError(500, 'server exploded');
    const client = makeClient({ postComment: vi.fn().mockRejectedValue(original) });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(false);
    expect(err).toBe(original); // same instance, untouched
  });

  it('does NOT reclassify a status-less error — passes through unchanged', async () => {
    const original = new Error('network down (no status)');
    const client = makeClient({ postComment: vi.fn().mockRejectedValue(original) });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(false);
    expect(err).toBe(original);
  });
});
