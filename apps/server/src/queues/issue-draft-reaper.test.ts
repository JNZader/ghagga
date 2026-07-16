/**
 * Tests for the stuck-APPROVED issue-draft reaper.
 *
 * The pure DB queries are mocked via vi.mock('ghagga-db'); the side-effectful
 * GitHub collaborators (getInstallationToken, listIssueComments) are INJECTED
 * through ReaperDeps so no network is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── DB mocks ───────────────────────────────────────────────────
const mockFindStaleApprovedDrafts = vi.fn();
const mockGetRepositoryById = vi.fn();
const mockGetInstallationById = vi.fn();
const mockMarkIssueDraftPosted = vi.fn();
const mockReleaseIssueDraftClaim = vi.fn();

vi.mock('ghagga-db', () => ({
  findStaleApprovedDrafts: (...a: unknown[]) => mockFindStaleApprovedDrafts(...a),
  getRepositoryById: (...a: unknown[]) => mockGetRepositoryById(...a),
  getInstallationById: (...a: unknown[]) => mockGetInstallationById(...a),
  markIssueDraftPosted: (...a: unknown[]) => mockMarkIssueDraftPosted(...a),
  releaseIssueDraftClaim: (...a: unknown[]) => mockReleaseIssueDraftClaim(...a),
}));

import { appendIssueDraftMarker } from '../github/issue-draft-marker.js';
import {
  type ReaperDeps,
  reapStaleApprovedDrafts,
  startIssueDraftReaper,
} from './issue-draft-reaper.js';

// biome-ignore lint/suspicious/noExplicitAny: mock db handle
const mockDb = {} as any;

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const mockGetInstallationToken = vi.fn();
const mockListIssueComments = vi.fn();

function makeDeps(overrides: Partial<ReaperDeps> = {}): ReaperDeps {
  return {
    getInstallationToken: mockGetInstallationToken as unknown as ReaperDeps['getInstallationToken'],
    listIssueComments: mockListIssueComments as unknown as ReaperDeps['listIssueComments'],
    appId: 'app-id',
    privateKey: 'pk',
    staleMs: 900_000,
    log: silentLog,
    ...overrides,
  };
}

function makeStaleDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    repositoryId: 7,
    issueNumber: 42,
    status: 'APPROVED',
    body: 'analysis body',
    postedCommentId: null,
    claimedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Wire the repo/installation/token resolution chain for a happy path. */
function wireResolution() {
  mockGetRepositoryById.mockResolvedValue({ id: 7, fullName: 'acme/app', installationId: 100 });
  mockGetInstallationById.mockResolvedValue({ id: 100, githubInstallationId: 555000 });
  mockGetInstallationToken.mockResolvedValue('tok');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reapStaleApprovedDrafts', () => {
  it('(a) marker comment present → records POSTED with that comment id, NEVER releases', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 111, author: 'someone', body: 'unrelated' },
      { id: 222, author: 'ghagga[bot]', body: appendIssueDraftMarker('the posted body', 9) },
    ]);
    mockMarkIssueDraftPosted.mockResolvedValue(makeStaleDraft({ status: 'POSTED' }));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    // resolved the token for the GITHUB installation id, not the internal row id
    expect(mockGetInstallationToken).toHaveBeenCalledWith(555000, 'app-id', 'pk');
    // recorded POSTED against the LIVE comment's id (222), not 111
    expect(mockMarkIssueDraftPosted).toHaveBeenCalledWith(mockDb, 9, 222);
    expect(mockReleaseIssueDraftClaim).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 1, released: 0, skipped: 0 });
  });

  it('(b) no marker on the issue → releases the claim (APPROVED→DRAFT), never marks', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 111, author: 'someone', body: 'just a normal human comment' },
      // a DIFFERENT draft's marker must NOT count as this draft's comment
      { id: 333, author: 'ghagga[bot]', body: appendIssueDraftMarker('other', 8) },
    ]);
    mockReleaseIssueDraftClaim.mockResolvedValue(makeStaleDraft({ status: 'DRAFT' }));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockReleaseIssueDraftClaim).toHaveBeenCalledWith(mockDb, 9);
    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 1, skipped: 0 });
  });

  it('(c) listIssueComments throws → SKIP: neither release nor mark', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockRejectedValue(new Error('GitHub 503'));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
    expect(mockReleaseIssueDraftClaim).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 1 });
  });

  it('(c2) token mint throws → SKIP: never even lists comments', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    mockGetRepositoryById.mockResolvedValue({ id: 7, fullName: 'acme/app', installationId: 100 });
    mockGetInstallationById.mockResolvedValue({ id: 100, githubInstallationId: 555000 });
    mockGetInstallationToken.mockRejectedValue(new Error('token mint failed'));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockListIssueComments).not.toHaveBeenCalled();
    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
    expect(mockReleaseIssueDraftClaim).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 1 });
  });

  it('(d) markIssueDraftPosted CAS returns undefined (race) → no error, not counted', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 222, author: 'ghagga[bot]', body: appendIssueDraftMarker('body', 9) },
    ]);
    mockMarkIssueDraftPosted.mockResolvedValue(undefined); // lost the CAS race

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockMarkIssueDraftPosted).toHaveBeenCalledWith(mockDb, 9, 222);
    // race → treated as a no-op, not an error, not counted as markedPosted
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 0 });
  });

  it('(d2) releaseIssueDraftClaim CAS returns undefined (race) → no error, not counted', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([{ id: 111, author: 'x', body: 'no marker here' }]);
    mockReleaseIssueDraftClaim.mockResolvedValue(undefined); // lost the CAS race

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockReleaseIssueDraftClaim).toHaveBeenCalledWith(mockDb, 9);
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 0 });
  });

  it('(e) summary counts are correct across a mixed batch', async () => {
    const dLive = makeStaleDraft({ id: 1 });
    const dPrePost = makeStaleDraft({ id: 2 });
    const dSkip = makeStaleDraft({ id: 3 });
    mockFindStaleApprovedDrafts.mockResolvedValue([dLive, dPrePost, dSkip]);
    wireResolution();

    // Sequential per-draft behavior (drafts processed in order):
    //   draft 1 → live (marker) · draft 2 → no marker · draft 3 → list throws
    mockListIssueComments
      .mockResolvedValueOnce([
        { id: 10, author: 'ghagga[bot]', body: appendIssueDraftMarker('x', 1) },
      ])
      .mockResolvedValueOnce([{ id: 20, author: 'h', body: 'no marker' }])
      .mockRejectedValueOnce(new Error('boom'));
    mockMarkIssueDraftPosted.mockResolvedValue(makeStaleDraft({ id: 1, status: 'POSTED' }));
    mockReleaseIssueDraftClaim.mockResolvedValue(makeStaleDraft({ id: 2, status: 'DRAFT' }));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockMarkIssueDraftPosted).toHaveBeenCalledWith(mockDb, 1, 10);
    expect(mockReleaseIssueDraftClaim).toHaveBeenCalledWith(mockDb, 2);
    expect(summary).toEqual({ scanned: 3, markedPosted: 1, released: 1, skipped: 1 });
  });

  it('(f) marker present but author is NOT the app bot → SKIP (no mark, no release)', async () => {
    // Spoof vector: a human collaborator pastes THIS draft's marker into a comment.
    // The reaper must NOT mark POSTED (would discard the real approved comment) and
    // must NOT release (would risk a double-post) — it leaves the draft APPROVED.
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 111, author: 'attacker-human', body: appendIssueDraftMarker('spoofed', 9) },
    ]);

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
    expect(mockReleaseIssueDraftClaim).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 1 });
  });

  it('(f2) with explicit botLogin: exact match required — wrong bot marker → SKIP', async () => {
    // A DIFFERENT app's bot (`other[bot]`) posted the marker. `endsWith('[bot]')`
    // would accept it, but an exact botLogin closes that residual gap → SKIP.
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 111, author: 'other[bot]', body: appendIssueDraftMarker('body', 9) },
    ]);

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps({ botLogin: 'ghagga[bot]' }));

    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
    expect(mockReleaseIssueDraftClaim).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, markedPosted: 0, released: 0, skipped: 1 });
  });

  it('(f3) with explicit botLogin: exact-match bot marker → records POSTED', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([makeStaleDraft()]);
    wireResolution();
    mockListIssueComments.mockResolvedValue([
      { id: 222, author: 'ghagga[bot]', body: appendIssueDraftMarker('body', 9) },
    ]);
    mockMarkIssueDraftPosted.mockResolvedValue(makeStaleDraft({ status: 'POSTED' }));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps({ botLogin: 'ghagga[bot]' }));

    expect(mockMarkIssueDraftPosted).toHaveBeenCalledWith(mockDb, 9, 222);
    expect(summary).toEqual({ scanned: 1, markedPosted: 1, released: 0, skipped: 0 });
  });

  it('(g) one draft write throws → counted skipped, batch still processes the rest', async () => {
    // FIX 1 (RES-001): a transient write failure on ONE draft must not abort the
    // loop — the next stale draft is still attempted.
    const dBoom = makeStaleDraft({ id: 1 });
    const dOk = makeStaleDraft({ id: 2 });
    mockFindStaleApprovedDrafts.mockResolvedValue([dBoom, dOk]);
    wireResolution();
    mockListIssueComments
      .mockResolvedValueOnce([{ id: 10, author: 'h', body: 'no marker' }])
      .mockResolvedValueOnce([{ id: 20, author: 'h', body: 'no marker' }]);
    // draft 1's release throws (transient DB error); draft 2 releases fine.
    mockReleaseIssueDraftClaim
      .mockRejectedValueOnce(new Error('DB write timeout'))
      .mockResolvedValueOnce(makeStaleDraft({ id: 2, status: 'DRAFT' }));

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    // both drafts attempted despite draft 1's write throw
    expect(mockReleaseIssueDraftClaim).toHaveBeenCalledTimes(2);
    expect(mockReleaseIssueDraftClaim).toHaveBeenNthCalledWith(2, mockDb, 2);
    expect(summary).toEqual({ scanned: 2, markedPosted: 0, released: 1, skipped: 1 });
  });

  it('empty stale set → zeroed summary, no GitHub calls', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([]);

    const summary = await reapStaleApprovedDrafts(mockDb, makeDeps());

    expect(mockGetInstallationToken).not.toHaveBeenCalled();
    expect(mockListIssueComments).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 0, markedPosted: 0, released: 0, skipped: 0 });
  });

  it('computes olderThan from staleMs and passes it to findStaleApprovedDrafts', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([]);
    const before = Date.now();
    await reapStaleApprovedDrafts(mockDb, makeDeps({ staleMs: 900_000 }));
    const after = Date.now();

    const [, olderThanArg] = mockFindStaleApprovedDrafts.mock.calls[0] as [unknown, Date];
    expect(olderThanArg).toBeInstanceOf(Date);
    // olderThan ≈ now - staleMs, within the wall-clock window of this test
    expect(olderThanArg.getTime()).toBeGreaterThanOrEqual(before - 900_000 - 50);
    expect(olderThanArg.getTime()).toBeLessThanOrEqual(after - 900_000 + 50);
  });
});

describe('startIssueDraftReaper (scheduler)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) overlap guard: a tick firing while one is in flight is skipped', async () => {
    // Gate the first tick's very first DB call so it stays "in flight".
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockFindStaleApprovedDrafts.mockReturnValueOnce(gate.then(() => []));
    mockFindStaleApprovedDrafts.mockResolvedValue([]);

    const stop = startIssueDraftReaper({
      db: mockDb,
      deps: makeDeps(),
      intervalMs: 1000,
      log: silentLog,
    });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 fires, hangs on the gate
    await vi.advanceTimersByTimeAsync(1000); // tick 2 fires while tick 1 running → skipped
    expect(mockFindStaleApprovedDrafts).toHaveBeenCalledTimes(1);

    releaseFirst(); // let tick 1 finish → running resets
    await vi.advanceTimersByTimeAsync(1000); // tick 3 now runs normally
    expect(mockFindStaleApprovedDrafts).toHaveBeenCalledTimes(2);

    stop();
  });

  it('(b) a throw inside a tick is caught + running reset → interval survives', async () => {
    mockFindStaleApprovedDrafts.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);

    const stop = startIssueDraftReaper({
      db: mockDb,
      deps: makeDeps(),
      intervalMs: 1000,
      log: silentLog,
    });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 throws → caught + logged
    expect(silentLog.error).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // tick 2 still fires (not wedged)
    expect(mockFindStaleApprovedDrafts).toHaveBeenCalledTimes(2);

    stop();
  });

  it('(c) stop() clears the interval — no further ticks fire', async () => {
    mockFindStaleApprovedDrafts.mockResolvedValue([]);

    const stop = startIssueDraftReaper({
      db: mockDb,
      deps: makeDeps(),
      intervalMs: 1000,
      log: silentLog,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFindStaleApprovedDrafts).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(5000); // 5 more intervals would have fired
    expect(mockFindStaleApprovedDrafts).toHaveBeenCalledTimes(1);
  });
});
