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

describe('GitLabForgeAdapter — upsertSummaryComment (R-UPSERT fold, FORGE-UPSERT-005)', () => {
  it('no existing note: just creates, returns numeric created + empty deleted', async () => {
    const client = makeClient({ listMrNotes: vi.fn().mockResolvedValue([]) });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(result).toEqual({ created: 1000, deleted: [] });
    expect(client.deleteMrNote).not.toHaveBeenCalled();
    expect(client.updateMrNote).not.toHaveBeenCalled();
    expect(client.createMrNote).toHaveBeenCalledWith(PROJECT_ID, MR_IID, 'body', TOKEN);
  });

  it('find-by-marker → updates the latest IN PLACE, then deletes stale duplicates', async () => {
    const calls: string[] = [];
    const client = makeClient({
      // chronological: marker note 100, foreign 200, marker note 300.
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 100, body: `old ${marker.html}` },
        { id: 200, body: 'someone else' },
        { id: 300, body: `newer ${marker.html}` },
      ]),
      updateMrNote: vi.fn(async (_p, _iid, id: number) => {
        calls.push(`update:${id}`);
      }),
      deleteMrNote: vi.fn(async (_p, _iid, id: number) => {
        calls.push(`delete:${id}`);
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    // latest (last marker note, 300) updated in place; stale (100) deleted after.
    expect(calls).toEqual(['update:300', 'delete:100']);
    expect(client.updateMrNote).toHaveBeenCalledWith(PROJECT_ID, MR_IID, 300, 'body', TOKEN);
    expect(client.createMrNote).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 300, deleted: [100] });
    // foreign note (200) is never touched.
    expect(client.deleteMrNote).not.toHaveBeenCalledWith(PROJECT_ID, MR_IID, 200, TOKEN);
  });

  it('tolerates a stale-delete failure (best-effort) without undoing the update', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 10, body: `a ${marker.html}` },
        { id: 20, body: `b ${marker.html}` },
        { id: 30, body: `c ${marker.html}` },
      ]),
      deleteMrNote: vi.fn(async (_p, _iid, id: number) => {
        if (id === 20) throw new Error('GitLab API error: 500');
      }),
    });
    const adapter = makeAdapter(client);
    const result = await adapter.upsertSummaryComment(ref, 'body', marker);
    // latest (30) updated; stale 10 succeeded, stale 20 failed → not in deleted.
    expect(result).toEqual({ created: 30, deleted: [10] });
    expect(client.updateMrNote).toHaveBeenCalledOnce();
  });

  it('update failure DOES propagate (only the update error is fatal)', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([{ id: 10, body: `x ${marker.html}` }]),
      updateMrNote: vi.fn().mockRejectedValue(new Error('GitLab API error updating note: 500')),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(
      /updating note/,
    );
    expect(client.deleteMrNote).not.toHaveBeenCalled();
  });

  it('throws TypeError when createMrNote returns no id (contract violation, no-existing-note path)', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([]),
      createMrNote: vi.fn().mockResolvedValue({} as { id: number }),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(TypeError);
  });

  // --- FORGE-UPSERT-005 regression: the old note must survive a transient
  // update failure. Delete must never run BEFORE the new body is confirmed
  // published, so a timeout/5xx never leaves the MR with no review.

  it('REGRESSION: update failure propagates WITHOUT deleting any prior note', async () => {
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 10, body: `a ${marker.html}` },
        { id: 20, body: `b ${marker.html}` },
      ]),
      updateMrNote: vi
        .fn()
        .mockRejectedValue(new Error('GitLab API error: 503 Service Unavailable')),
    });
    const adapter = makeAdapter(client);
    await expect(adapter.upsertSummaryComment(ref, 'body', marker)).rejects.toThrow(
      /503 Service Unavailable/,
    );
    expect(client.deleteMrNote).not.toHaveBeenCalled();
    expect(client.createMrNote).not.toHaveBeenCalled();
  });

  it('REGRESSION: delete of stale duplicates never runs before the update resolves', async () => {
    const calls: string[] = [];
    const client = makeClient({
      listMrNotes: vi.fn().mockResolvedValue([
        { id: 10, body: `a ${marker.html}` },
        { id: 20, body: `b ${marker.html}` },
      ]),
      updateMrNote: vi.fn(async () => {
        calls.push('update-start');
        await Promise.resolve();
        calls.push('update-done');
      }),
      deleteMrNote: vi.fn(async (_p, _iid, id: number) => {
        calls.push(`delete:${id}`);
      }),
    });
    const adapter = makeAdapter(client);
    await adapter.upsertSummaryComment(ref, 'body', marker);
    expect(calls).toEqual(['update-start', 'update-done', 'delete:10']);
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

  it('no position → degrades to a plain path:line note (createMrNote)', async () => {
    const client = makeClient({ createMrNote: vi.fn().mockResolvedValue({ id: 42 }) });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, [{ path: 'a.ts', line: 9, body: 'hi' }]);
    expect(report.posted).toEqual([{ kind: 'gitlab', raw: '42' }]);
    // body carries the path:line anchor prefix; discussion API untouched.
    const [, , body] = (client.createMrNote as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain('`a.ts:9`');
    expect(body).toContain('hi');
  });

  it('TAGS a 401 failure with {status:401, authFailure:true} (distinct from transient)', async () => {
    // index 0 = 401 auth failure (status-tagged like the client throws);
    // index 1 = transient 500 (status but NOT auth); index 2 = no-status throw.
    let call = -1;
    const client = makeClient({
      createMrNote: vi.fn(async () => {
        call++;
        if (call === 0) throw Object.assign(new Error('Unauthorized'), { status: 401 });
        if (call === 1) throw Object.assign(new Error('server error'), { status: 500 });
        throw new Error('network down');
      }),
    });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, [
      { path: 'a.ts', line: 1, body: 'c0' },
      { path: 'b.ts', line: 2, body: 'c1' },
      { path: 'c.ts', line: 3, body: 'c2' },
    ]);

    expect(report.posted).toEqual([]);
    expect(report.failed).toEqual([
      { index: 0, error: 'Unauthorized', status: 401, authFailure: true },
      { index: 1, error: 'server error', status: 500 },
      { index: 2, error: 'network down' },
    ]);
    // partial-failure semantics intact: every note attempted independently.
    expect(client.createMrNote).toHaveBeenCalledTimes(3);
  });

  it('TAGS a 403 failure as authFailure too', async () => {
    const client = makeClient({
      createMrNote: vi.fn(async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      }),
    });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, [{ path: 'a.ts', line: 1, body: 'c0' }]);

    expect(report.failed).toEqual([
      { index: 0, error: 'Forbidden', status: 403, authFailure: true },
    ]);
  });
});

describe('GitLabForgeAdapter — publishInline positioned discussion (FIX C)', () => {
  it('position present + client supports discussions → uses createMrDiscussion', async () => {
    const createMrDiscussion = vi.fn().mockResolvedValue({ id: 777 });
    const client = makeClient({ createMrDiscussion });
    const adapter = makeAdapter(client);

    const report = await adapter.publishInline(ref, [
      {
        path: 'src/new.ts',
        line: 12,
        side: 'new',
        body: 'anchored',
        position: { baseSha: 'b', headSha: 'h', startSha: 's', newLine: 12 },
      },
    ]);

    expect(report.posted).toEqual([{ kind: 'gitlab', raw: '777' }]);
    expect(client.createMrNote).not.toHaveBeenCalled();
    expect(createMrDiscussion).toHaveBeenCalledWith(
      PROJECT_ID,
      MR_IID,
      'anchored',
      {
        baseSha: 'b',
        headSha: 'h',
        startSha: 's',
        // both paths default to `path` for a non-renamed file.
        oldPath: 'src/new.ts',
        newPath: 'src/new.ts',
        newLine: 12,
      },
      TOKEN,
    );
  });

  it('renamed file → forwards distinct oldPath/newPath to the discussion', async () => {
    const createMrDiscussion = vi.fn().mockResolvedValue({ id: 888 });
    const client = makeClient({ createMrDiscussion });
    const adapter = makeAdapter(client);

    await adapter.publishInline(ref, [
      {
        path: 'src/renamed.ts',
        oldPath: 'src/old.ts',
        newPath: 'src/renamed.ts',
        line: 3,
        body: 'rename note',
        position: { baseSha: 'b', headSha: 'h', startSha: 's', oldLine: 2, newLine: 3 },
      },
    ]);

    expect(createMrDiscussion).toHaveBeenCalledWith(
      PROJECT_ID,
      MR_IID,
      'rename note',
      {
        baseSha: 'b',
        headSha: 'h',
        startSha: 's',
        oldPath: 'src/old.ts',
        newPath: 'src/renamed.ts',
        oldLine: 2,
        newLine: 3,
      },
      TOKEN,
    );
  });

  it('position present but client LACKS discussion support → degrades to a note', async () => {
    // makeClient() has no createMrDiscussion (optional) → degrade path.
    const client = makeClient({ createMrNote: vi.fn().mockResolvedValue({ id: 5 }) });
    const adapter = makeAdapter(client);
    const report = await adapter.publishInline(ref, [
      {
        path: 'a.ts',
        line: 1,
        body: 'x',
        position: { baseSha: 'b', headSha: 'h', startSha: 's', newLine: 1 },
      },
    ]);
    expect(report.posted).toEqual([{ kind: 'gitlab', raw: '5' }]);
    expect(client.createMrNote).toHaveBeenCalledOnce();
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
