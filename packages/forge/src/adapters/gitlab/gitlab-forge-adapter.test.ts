import { describe, expect, it, vi } from 'vitest';
import { type ForgeAuthError, isForgeAuthError } from '../../errors.js';
import type { ForgeAdapter, InlineCapable, InlineComment } from '../../ports/forge-adapter.js';
import type { ChangeRequestRef, CommentMarker, RepoRef } from '../../types.js';
import { FORGE_KIND } from '../../types.js';
import type { GitLabClientPort } from './gitlab-client-port.js';
import { GitLabForgeAdapter } from './gitlab-forge-adapter.js';

const PROJECT_ID = '12345'; // GitLab NUMERIC project id (canonical nativeId)
const PROJECT_PATH = 'acme/widgets'; // mutable group/project path (label only)
const TOKEN = 'glpat-xxx';
const MR_IID = 7;

const repo: RepoRef = { kind: FORGE_KIND.GITLAB, nativeId: PROJECT_ID, path: PROJECT_PATH };
const ref: ChangeRequestRef = { repo, iid: MR_IID };
const marker: CommentMarker = { html: '<!-- ghagga-review -->' };

/** A fully-stubbed GitLabClientPort; tests override individual fns. */
function makeClient(overrides: Partial<GitLabClientPort> = {}): GitLabClientPort {
  return {
    listMrNotes: vi.fn().mockResolvedValue([]),
    createMrNote: vi.fn().mockResolvedValue({ id: 1000 }),
    deleteMrNote: vi.fn().mockResolvedValue(undefined),
    updateMrNote: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeAdapter(client: GitLabClientPort): GitLabForgeAdapter {
  return new GitLabForgeAdapter({ client, token: TOKEN, projectId: PROJECT_ID });
}

describe('GitLabForgeAdapter — capability shape (R-GITLAB)', () => {
  it('declares reactions:false, inlineComments:true, graphRead:false', () => {
    const adapter = makeAdapter(makeClient());
    const asForge: ForgeAdapter = adapter;
    expect(asForge.capabilities).toEqual({
      reactions: false,
      inlineComments: true,
      graphRead: false,
    });
  });

  it('does NOT implement addReaction (GitLab reactions absent)', () => {
    const adapter = makeAdapter(makeClient());
    expect('addReaction' in adapter).toBe(false);
  });

  it('does NOT implement fetchGraph / fetchGraphMetadata (graphRead false)', () => {
    const adapter = makeAdapter(makeClient());
    expect('fetchGraph' in adapter).toBe(false);
    expect('fetchGraphMetadata' in adapter).toBe(false);
  });

  it('IS assignable to InlineCapable (publishInline present)', () => {
    const adapter = makeAdapter(makeClient());
    const asInline: InlineCapable = adapter;
    expect(typeof asInline.publishInline).toBe('function');
  });
});

describe('GitLabForgeAdapter — upsertSummaryComment (R-UPSERT fold)', () => {
  it('no existing note: just creates, returns numeric created + empty deleted', async () => {
    const client = makeClient({ listMrNotes: vi.fn().mockResolvedValue([]) });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(result).toEqual({ created: 1000, deleted: [] });
    expect(client.deleteMrNote).not.toHaveBeenCalled();
    expect(client.createMrNote).toHaveBeenCalledWith(PROJECT_ID, MR_IID, 'body', TOKEN);
  });

  it('find-by-marker → delete ALL stale (latest first) → repost fresh', async () => {
    const calls: string[] = [];
    const client = makeClient({
      // chronological: marker note 100, foreign 200, marker note 300.
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 100, body: `old ${marker.html}` },
        { id: 200, body: 'someone else' },
        { id: 300, body: `newer ${marker.html}` },
      ]),
      deleteMrNote: vi.fn(async (_p, _iid, id: number) => {
        calls.push(`delete:${id}`);
      }),
      createMrNote: vi.fn(async () => {
        calls.push('create');
        return { id: 400 };
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    // latest (last marker note) first, then stale; create last.
    expect(calls).toEqual(['delete:300', 'delete:100', 'create']);
    expect(result).toEqual({ created: 400, deleted: [300, 100] });
    // foreign note (200) is never touched.
    expect(client.deleteMrNote).not.toHaveBeenCalledWith(PROJECT_ID, MR_IID, 200, TOKEN);
  });

  it('tolerates a delete failure (best-effort) without blocking the repost', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 10, body: `a ${marker.html}` },
        { id: 20, body: `b ${marker.html}` },
      ]),
      deleteMrNote: vi.fn(async (_p, _iid, id: number) => {
        if (id === 20) throw new Error('GitLab API error: 500');
      }),
      createMrNote: vi.fn().mockResolvedValue({ id: 999 }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    // 20 (latest) failed → not in deleted; 10 succeeded; create still happened.
    expect(result).toEqual({ created: 999, deleted: [10] });
    expect(client.createMrNote).toHaveBeenCalledOnce();
  });

  it('create failure DOES propagate (only the create error is fatal)', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([{ id: 10, body: `x ${marker.html}` }]),
      createMrNote: vi.fn().mockRejectedValue(new Error('GitLab API error creating note: 500')),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(
      /creating note/,
    );
    expect(client.deleteMrNote).toHaveBeenCalledWith(PROJECT_ID, MR_IID, 10, TOKEN);
  });

  it('throws TypeError when createMrNote returns no id (contract violation)', async () => {
    const client = makeClient({
      createMrNote: vi.fn().mockResolvedValue({} as { id: number }),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(TypeError);
  });
});

describe('GitLabForgeAdapter — identity (R-GITLAB numeric project id + MR iid)', () => {
  it('routes every note call through the NUMERIC project id, not the path', async () => {
    const client = makeClient({ listMrNotes: vi.fn().mockResolvedValue([]) });
    const adapter = makeAdapter(client);
    await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(client.createMrNote).toHaveBeenCalledWith(PROJECT_ID, MR_IID, 'body', TOKEN);
    // NOT the mutable path.
    expect(client.createMrNote).not.toHaveBeenCalledWith(PROJECT_PATH, MR_IID, 'body', TOKEN);
  });
});

describe('GitLabForgeAdapter — publishInline partial failure (R-LEAK-PUBLISH / TEST 4.2)', () => {
  const five: InlineComment[] = [
    { path: 'a.ts', line: 1, body: 'c0' },
    { path: 'b.ts', line: 2, body: 'c1' },
    { path: 'c.ts', line: 3, body: 'c2' },
    { path: 'd.ts', line: 4, body: 'c3' },
    { path: 'e.ts', line: 5, body: 'c4' },
  ];

  it('5 inline notes, 3 fail → posted has 2, failed has 3 with {index,error}', async () => {
    // indices 1, 2, 4 fail; 0 and 3 succeed.
    let call = -1;
    const client = makeClient({
      createMrNote: vi.fn(async () => {
        call++;
        if (call === 1 || call === 2 || call === 4) {
          throw new Error(`boom ${call}`);
        }
        return { id: 5000 + call };
      }),
    });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, five);

    expect(report.posted).toEqual([
      { kind: 'gitlab', raw: '5000' },
      { kind: 'gitlab', raw: '5003' },
    ]);
    expect(report.failed).toEqual([
      { index: 1, error: 'boom 1' },
      { index: 2, error: 'boom 2' },
      { index: 4, error: 'boom 4' },
    ]);
    // each note is posted INDEPENDENTLY (one create call per comment).
    expect(client.createMrNote).toHaveBeenCalledTimes(5);
  });

  it('all succeed → posted has 5 boxed gitlab ids, failed empty', async () => {
    let call = -1;
    const client = makeClient({
      createMrNote: vi.fn(async () => {
        call++;
        return { id: 100 + call };
      }),
    });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, five);
    expect(report.posted).toHaveLength(5);
    expect(report.failed).toEqual([]);
    expect(report.posted[0]).toEqual({ kind: 'gitlab', raw: '100' });
  });

  it('empty input → empty report (no calls)', async () => {
    const client = makeClient();
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, []);
    expect(report).toEqual({ posted: [], failed: [] });
    expect(client.createMrNote).not.toHaveBeenCalled();
  });
});

describe('GitLabForgeAdapter — auth-error surfacing (401/403 → ForgeAuthError)', () => {
  function statusError(status: number, message = `boom ${status}`): Error {
    return Object.assign(new Error(message), { status });
  }

  it('reclassifies a 401 from createMrNote as a ForgeAuthError', async () => {
    const client = makeClient({
      createMrNote: vi.fn().mockRejectedValue(statusError(401, 'GitLab note POST')),
    });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(401);
  });

  it('reclassifies a 403 from listMrNotes as a ForgeAuthError', async () => {
    const client = makeClient({ listMrNotes: vi.fn().mockRejectedValue(statusError(403)) });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(true);
    expect((err as ForgeAuthError).status).toBe(403);
  });

  it('does NOT reclassify a non-auth (500) error — passes through unchanged', async () => {
    const original = statusError(500, 'server exploded');
    const client = makeClient({ createMrNote: vi.fn().mockRejectedValue(original) });
    const adapter = makeAdapter(client);
    const err = await adapter.upsertSummaryComment(ref, 'body', marker).catch((e) => e);
    expect(isForgeAuthError(err)).toBe(false);
    expect(err).toBe(original);
  });
});
