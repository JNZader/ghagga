/**
 * Tests for the nightly digest queue/worker/reconciler
 * (nightly-health-digest T3.3/T3.4).
 *
 * Offline: `ghagga-db` is mocked via vi.mock (issue-draft-reaper.test.ts:12-23
 * precedent), forge verbs are INJECTED, the clock is a fake `now` seam, and the
 * scheduler surface is a fake queue — no live Redis, no network, no real time
 * waits. The module-level `digestQueue` connection is inert here: these tests
 * exercise runDigestForRepository / recordFailedDigestRun / the schedule hooks
 * as functions, never a live worker.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── DB mocks ───────────────────────────────────────────────────
const mockGetRepositoryById = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();
const mockGetOpenDigest = vi.fn();
const mockGetReviewsSinceWatermark = vi.fn();
const mockInsertDigestRun = vi.fn();
const mockRotateOpenDigest = vi.fn();
const mockGetActiveRepositoriesForScheduling = vi.fn();
const mockGetReposByInstallationId = vi.fn();

vi.mock('ghagga-db', () => ({
  createDatabaseFromEnv: vi.fn(),
  getRepositoryById: (...a: unknown[]) => mockGetRepositoryById(...a),
  getEffectiveRepoSettings: (...a: unknown[]) => mockGetEffectiveRepoSettings(...a),
  getOpenDigest: (...a: unknown[]) => mockGetOpenDigest(...a),
  getReviewsSinceWatermark: (...a: unknown[]) => mockGetReviewsSinceWatermark(...a),
  insertDigestRun: (...a: unknown[]) => mockInsertDigestRun(...a),
  rotateOpenDigest: (...a: unknown[]) => mockRotateOpenDigest(...a),
  getActiveRepositoriesForScheduling: (...a: unknown[]) =>
    mockGetActiveRepositoriesForScheduling(...a),
  getReposByInstallationId: (...a: unknown[]) => mockGetReposByInstallationId(...a),
}));

// getInstallationToken (network) is mocked so the adapter factory path never runs.
vi.mock('../github/client.js', () => ({
  getInstallationToken: vi.fn(),
}));

import {
  DIGEST_CRON_PATTERN,
  DIGEST_ISSUE_TITLE,
  DIGEST_QUEUE_NAME,
  type DigestPublication,
  type DigestSchedulerQueue,
  digestSchedulerId,
  reconcileDigestSchedulerForRepo,
  reconcileDigestSchedulers,
  reconcileDigestSchedulersForInstallation,
  recordFailedDigestRun,
  runDigestForRepository,
  scheduleDigestForRepo,
  unscheduleDigestForRepo,
} from './digest.js';

// biome-ignore lint/suspicious/noExplicitAny: mock db handle
const mockDb = {} as any;
const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const NOW = new Date('2026-11-10T03:00:00.000Z');
const now = () => NOW;

/** Repository row as getRepositoryById returns it (settings-bearing). */
function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    installationId: 100,
    githubRepoId: 555001,
    fullName: 'acme/app',
    isActive: true,
    useGlobalSettings: false,
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: {},
    ...overrides,
  };
}

/** Wire the happy-path resolution chain: repo found, digests enabled. */
function wireEnabled(overrides: { repo?: Record<string, unknown>; open?: object | null } = {}) {
  mockGetRepositoryById.mockResolvedValue(makeRepo(overrides.repo));
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: { digestsEnabled: true },
    source: 'repo',
  });
  mockGetOpenDigest.mockResolvedValue(overrides.open ?? null);
}

function makeForge(overrides: Partial<DigestPublication> = {}): DigestPublication {
  return {
    createDigestIssue: vi.fn().mockResolvedValue({ number: 42 }),
    updateDigestIssue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRunDeps(forge: DigestPublication) {
  return { db: mockDb, forge, log: silentLog, now };
}

/** One well-formed review row inside the window (AFTER the stored watermark). */
function reviewRow(overrides: Partial<{ findings: unknown[]; createdAt: Date }> = {}) {
  return {
    findings: [
      { severity: 'high', file: 'src/a.ts', category: 'quality', message: 'm', source: 'semgrep' },
    ],
    metadata: null,
    createdAt: new Date('2026-11-09T12:00:00.000Z'),
    ...overrides,
  };
}

/** A POSTED open digest row. */
function openDigestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    repositoryId: 7,
    runAt: new Date('2026-11-09T03:00:00.000Z'),
    status: 'POSTED',
    issueNumber: 42,
    issueOpen: true,
    watermark: new Date('2026-11-09T03:00:00.000Z'),
    findingsCount: 2,
    score: 72,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Worker flow (T3.3) ─────────────────────────────────────────

describe('runDigestForRepository', () => {
  it('first run creates the digest issue and exactly ONE open row with an advanced watermark', async () => {
    wireEnabled({ open: null });
    mockGetReviewsSinceWatermark.mockResolvedValue([reviewRow()]);
    const forge = makeForge();
    mockRotateOpenDigest.mockResolvedValue(openDigestRow({ id: 11 }));

    const result = await runDigestForRepository(7, makeRunDeps(forge));

    expect(result).toBe('POSTED');
    // Query cutoffs: first run carries NO watermark.
    expect(mockGetReviewsSinceWatermark).toHaveBeenCalledWith(mockDb, 7, undefined, NOW);
    // Issue created with the fixed title and a marker-headed body.
    const title = (forge.createDigestIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const body = (forge.createDigestIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(title).toBe(DIGEST_ISSUE_TITLE);
    expect(body.startsWith('<!-- ghagga-digest -->')).toBe(true);
    expect(forge.updateDigestIssue).not.toHaveBeenCalled();
    // One open row via rotate (flip+insert), watermark advanced to runAt.
    expect(mockRotateOpenDigest).toHaveBeenCalledWith(mockDb, {
      repositoryId: 7,
      successor: {
        runAt: NOW,
        issueNumber: 42,
        watermark: NOW,
        findingsCount: 1,
        score: expect.any(Number),
      },
    });
    expect(mockInsertDigestRun).not.toHaveBeenCalled();
  });

  it('create-then-update marker flow: issue #42 updated in place, create NOT called again, no second open row', async () => {
    wireEnabled({ open: openDigestRow() });
    mockGetReviewsSinceWatermark.mockResolvedValue([reviewRow()]);
    const forge = makeForge();
    mockRotateOpenDigest.mockResolvedValue(openDigestRow({ id: 12 }));

    const result = await runDigestForRepository(7, makeRunDeps(forge));

    expect(result).toBe('POSTED');
    // Window is cut at the stored watermark.
    expect(mockGetReviewsSinceWatermark).toHaveBeenCalledWith(
      mockDb,
      7,
      openDigestRow().watermark,
      NOW,
    );
    // SAME issue number updated in place with the SAME marker-headed body.
    const update = forge.updateDigestIssue as ReturnType<typeof vi.fn>;
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe(42);
    expect((update.mock.calls[0]?.[1] as string).startsWith('<!-- ghagga-digest -->')).toBe(true);
    expect(forge.createDigestIssue).not.toHaveBeenCalled();
    // The successor row is inserted via rotate — never a second open row.
    expect(mockRotateOpenDigest).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        successor: expect.objectContaining({ issueNumber: 42, watermark: NOW }),
      }),
    );
  });

  it('watermark skip: zero new findings → SKIPPED row, watermark unchanged, ZERO forge calls', async () => {
    wireEnabled({ open: openDigestRow() });
    mockGetReviewsSinceWatermark.mockResolvedValue([]);

    const result = await runDigestForRepository(7, makeRunDeps(makeForge()));

    expect(result).toBe('SKIPPED');
    expect(mockInsertDigestRun).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        status: 'SKIPPED',
        issueOpen: false,
        watermark: openDigestRow().watermark,
        error: 'no new findings since watermark',
      }),
    );
    expect(mockRotateOpenDigest).not.toHaveBeenCalled();
  });

  it('all-malformed findings rows also skip (findingsCount excludes malformed)', async () => {
    wireEnabled({ open: openDigestRow() });
    mockGetReviewsSinceWatermark.mockResolvedValue([
      { findings: null, metadata: null, createdAt: new Date('2026-11-09T00:00:00Z') },
      { findings: {}, metadata: null, createdAt: new Date('2026-11-09T01:00:00Z') },
    ]);

    const result = await runDigestForRepository(7, makeRunDeps(makeForge()));

    expect(result).toBe('SKIPPED');
    expect(mockInsertDigestRun).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: 'SKIPPED' }),
    );
  });

  it('disabled at fire time → SKIPPED row with reason (settings re-resolved at processing time)', async () => {
    mockGetRepositoryById.mockResolvedValue(makeRepo());
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: false },
      source: 'repo',
    });
    mockGetOpenDigest.mockResolvedValue(openDigestRow());

    const result = await runDigestForRepository(7, makeRunDeps(makeForge()));

    expect(result).toBe('SKIPPED');
    expect(mockGetEffectiveRepoSettings).toHaveBeenCalledTimes(1);
    expect(mockInsertDigestRun).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        status: 'SKIPPED',
        error: 'digests disabled at fire time',
        watermark: openDigestRow().watermark,
      }),
    );
    // Zero forge calls, zero window reads (disabled short-circuits first).
    expect(mockGetReviewsSinceWatermark).not.toHaveBeenCalled();
  });

  it('update 404 (issue gone) → creates a fresh issue and rotates to it', async () => {
    wireEnabled({ open: openDigestRow() });
    mockGetReviewsSinceWatermark.mockResolvedValue([reviewRow()]);
    const gone = Object.assign(new Error('GitHub API error updating issue: 404 Not Found'), {
      name: 'GitHubApiError',
      status: 404,
    });
    const forge = makeForge({
      updateDigestIssue: vi.fn().mockRejectedValue(gone),
      createDigestIssue: vi.fn().mockResolvedValue({ number: 99 }),
    });
    mockRotateOpenDigest.mockResolvedValue(openDigestRow({ id: 13, issueNumber: 99 }));

    const result = await runDigestForRepository(7, makeRunDeps(forge));

    expect(result).toBe('POSTED');
    expect(forge.createDigestIssue).toHaveBeenCalledTimes(1);
    expect(mockRotateOpenDigest).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ successor: expect.objectContaining({ issueNumber: 99 }) }),
    );
  });

  it('permission failure REJECTS (BullMQ retries) and recordFailedDigestRun writes the FAILED row', async () => {
    wireEnabled({ open: openDigestRow() });
    mockGetReviewsSinceWatermark.mockResolvedValue([reviewRow()]);
    const forbidden = Object.assign(new Error('GitHub API error updating issue: 403 Forbidden'), {
      name: 'GitHubApiError',
      status: 403,
    });
    const forge = makeForge({ updateDigestIssue: vi.fn().mockRejectedValue(forbidden) });

    await expect(runDigestForRepository(7, makeRunDeps(forge))).rejects.toThrow(/403/);

    // The failed-handler path records FAILED with the error text and the
    // previous watermark; scheduler registration is untouched (nothing to
    // assert on a live queue — the hook functions below cover that surface).
    mockGetOpenDigest.mockResolvedValue(openDigestRow());
    mockInsertDigestRun.mockResolvedValue({ id: 14 });
    await recordFailedDigestRun(7, forbidden, { db: mockDb, log: silentLog, now });
    expect(mockInsertDigestRun).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        status: 'FAILED',
        issueOpen: false,
        watermark: openDigestRow().watermark,
        error: expect.stringContaining('403'),
      }),
    );
    expect(silentLog.error).toHaveBeenCalled();
  });

  it('missing repository resolves to a quiet skip (deleted repo, nothing recorded)', async () => {
    mockGetRepositoryById.mockResolvedValue(null);

    const result = await runDigestForRepository(404, makeRunDeps(makeForge()));
    expect(result).toBe('SKIPPED');
    expect(mockInsertDigestRun).not.toHaveBeenCalled();
  });

  it('trend on update renders the previous score delta; first digest omits the trend line', async () => {
    // Update path: open row score 72; two high findings → score 80 → trend +8 improving.
    wireEnabled({ open: openDigestRow({ score: 72 }) });
    mockGetReviewsSinceWatermark.mockResolvedValue([
      reviewRow(),
      reviewRow({ createdAt: new Date('2026-11-08T00:00:00Z') }),
    ]);
    mockRotateOpenDigest.mockResolvedValue(openDigestRow({ id: 21 }));
    const forge = makeForge();
    await runDigestForRepository(7, makeRunDeps(forge));
    const updateBody = (forge.updateDigestIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(updateBody).toContain('Trend');

    // First digest: no open row → no trend line, no throw.
    wireEnabled({ open: null });
    mockGetReviewsSinceWatermark.mockResolvedValue([reviewRow()]);
    const createForge = makeForge();
    mockRotateOpenDigest.mockResolvedValue(openDigestRow({ id: 22 }));
    await runDigestForRepository(7, makeRunDeps(createForge));
    const createBody = (createForge.createDigestIssue as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(createBody).not.toContain('Trend');
  });
});

// ─── Scheduler registration (T3.4) ──────────────────────────────

/** Fake scheduler queue recording upserts/removals — no Redis. */
function makeFakeQueue(existing: string[] = []) {
  const schedulers = new Map<string, { pattern: string }>();
  for (const id of existing) schedulers.set(id, { pattern: DIGEST_CRON_PATTERN });
  const upserts: Array<{ id: string; pattern: string; data: unknown }> = [];
  const removals: string[] = [];
  const queue: DigestSchedulerQueue = {
    upsertJobScheduler: vi.fn(async (id, repeatOpts, jobTemplate) => {
      schedulers.set(id, { pattern: repeatOpts.pattern });
      upserts.push({ id, pattern: repeatOpts.pattern, data: jobTemplate.data });
      return { id };
    }),
    removeJobScheduler: vi.fn(async (id) => {
      removals.push(id);
      return schedulers.delete(id);
    }),
    getJobSchedulers: vi.fn(async () => [...schedulers.entries()].map(([id]) => ({ id }))),
  };
  return { queue, schedulers, upserts, removals };
}

describe('schedule hooks', () => {
  it('registers the repeatable with jobId digest:{id}, cron 0 3 * * *, data carrying ONLY repositoryId', async () => {
    const { queue, upserts } = makeFakeQueue();
    await scheduleDigestForRepo(queue, 7);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.id).toBe('digest:7');
    expect(upserts[0]?.pattern).toBe('0 3 * * *');
    expect(upserts[0]?.data).toEqual({ repositoryId: 7 });
  });

  it('DOUBLE-SCHEDULE INVARIANT: upserting twice with the same jobId+pattern registers ONE repeatable', async () => {
    const { queue, schedulers } = makeFakeQueue();
    await scheduleDigestForRepo(queue, 7);
    await scheduleDigestForRepo(queue, 7); // restart idempotency
    expect(schedulers.size).toBe(1);
    expect([...schedulers.keys()]).toEqual(['digest:7']);
  });

  it('cron-pattern constant is the fixed v1 default (03:00 UTC nightly)', () => {
    expect(DIGEST_CRON_PATTERN).toBe('0 3 * * *');
    expect(DIGEST_QUEUE_NAME).toBe('digest');
    expect(digestSchedulerId(7)).toBe('digest:7');
  });

  it('opt-out removal: unscheduleDigestForRepo removes digest:{id}; stored digest row untouched by design', async () => {
    const { queue, removals } = makeFakeQueue(['digest:7']);
    await unscheduleDigestForRepo(queue, 7);
    expect(removals).toEqual(['digest:7']);
  });
});

describe('reconcileDigestSchedulers', () => {
  it('adds missing opted-in repos and removes stale schedulers (restart diff)', async () => {
    mockGetActiveRepositoriesForScheduling.mockResolvedValue([
      makeRepo({ id: 7 }), // opted in
      makeRepo({ id: 8, fullName: 'acme/other' }), // opted out below
    ]);
    mockGetEffectiveRepoSettings.mockImplementation(async (_db, repo: { id: number }) => ({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: repo.id === 7 },
      source: 'repo',
    }));
    const { queue, removals } = makeFakeQueue(['digest:9']); // stale: repo 9 not opted in

    const result = await reconcileDigestSchedulers(mockDb, queue);

    expect(result.scheduled).toEqual([7]);
    expect(result.removed).toEqual([9]);
    expect(removals).toEqual(['digest:9']);
    const upsert = (queue.upsertJobScheduler as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'digest:7',
    );
    expect(upsert).toBeDefined();
  });

  it('idempotent restart: everything registered → no adds, no removes', async () => {
    mockGetActiveRepositoriesForScheduling.mockResolvedValue([makeRepo({ id: 7 })]);
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: true },
      source: 'repo',
    });
    const { queue, removals } = makeFakeQueue(['digest:7']);

    const result = await reconcileDigestSchedulers(mockDb, queue);

    expect(result.scheduled).toEqual([7]);
    expect(result.removed).toEqual([]);
    expect(removals).toEqual([]);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('effective digestsEnabled flips false → removeJobScheduler(digest:{id}) called; review processing untouched', async () => {
    mockGetActiveRepositoriesForScheduling.mockResolvedValue([makeRepo({ id: 7 })]);
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: false },
      source: 'repo',
    });
    const { queue, removals } = makeFakeQueue(['digest:7']);

    const result = await reconcileDigestSchedulers(mockDb, queue);

    expect(result.scheduled).toEqual([]);
    expect(removals).toEqual(['digest:7']);
  });
});

describe('per-repo and per-installation settings hooks', () => {
  it('toggle true→false invokes unschedule; false→true invokes schedule', async () => {
    mockGetRepositoryById.mockResolvedValue(makeRepo());
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: false },
      source: 'repo',
    });
    const { queue, removals } = makeFakeQueue(['digest:7']);
    await reconcileDigestSchedulerForRepo(mockDb, queue, 7);
    expect(removals).toEqual(['digest:7']);

    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: true },
      source: 'repo',
    });
    const { queue: queue2, upserts } = makeFakeQueue();
    await reconcileDigestSchedulerForRepo(mockDb, queue2, 7);
    expect(upserts.map((u) => u.id)).toEqual(['digest:7']);
  });

  it('missing/inactive repo resolves to a no-op hook', async () => {
    mockGetRepositoryById.mockResolvedValue(null);
    const { queue } = makeFakeQueue();
    await reconcileDigestSchedulerForRepo(mockDb, queue, 7);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('installation hook re-reconciles every active repo in the installation', async () => {
    mockGetReposByInstallationId.mockResolvedValue([
      makeRepo({ id: 7, installationId: 100 }),
      makeRepo({ id: 8, installationId: 100, fullName: 'acme/other', isActive: false }),
    ]);
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: true },
      source: 'global',
    });
    const { queue, upserts } = makeFakeQueue();

    await reconcileDigestSchedulersForInstallation(mockDb, queue, 100);

    // Only the ACTIVE repo is scheduled.
    expect(upserts.map((u) => u.id)).toEqual(['digest:7']);
  });
});
