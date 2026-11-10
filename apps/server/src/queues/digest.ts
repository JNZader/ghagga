/**
 * Nightly health digest queue + worker + scheduler reconciler
 * (nightly-health-digest S3).
 *
 * BullMQ JOB SCHEDULERS (the modern repeatable API — the single-box
 * "no BullMQ repeatable" decision is reversed ONLY for this workload, per the
 * server spec): one scheduler per opted-in repo, `digest:{repositoryId}`, cron
 * `0 3 * * *` UTC, feeding a dedicated `digest` queue. The worker is
 * IN-PROCESS in the API server (explanation precedent) — nightly-light, no new
 * entrypoint. NO env gate (D8): the server already requires Redis
 * unconditionally; the feature gate is the `digestsEnabled` setting.
 *
 * Job data carries ONLY `repositoryId` — settings and credentials are
 * re-resolved from the DB at processing time (credentials-never-in-the-payload
 * rule, queues/issue-analysis.ts precedent).
 *
 * Every run appends a `digests` row (append-only history): POSTED / SKIPPED /
 * FAILED. Publication failures are recorded, never silently skipped: the run
 * throws so BullMQ retries (attempts 3, exponential backoff), and the worker's
 * failed handler records the FAILED row once attempts are exhausted — the
 * scheduler registration is untouched, so the next nightly run still fires.
 */

import { Queue, Worker } from 'bullmq';
import {
  aggregateHealth,
  computeHealthScore,
  computeTrend,
  formatDigestIssue,
  rankFileRisk,
} from 'ghagga-core';
import {
  createDatabaseFromEnv,
  type Database,
  getActiveRepositoriesForScheduling,
  getEffectiveRepoSettings,
  getInstallationById,
  getOpenDigest,
  getReposByInstallationId,
  getRepositoryById,
  getReviewsSinceWatermark,
  insertDigestRun,
  rotateOpenDigest,
} from 'ghagga-db';
import { getErrorStatus } from 'ghagga-forge';
import { getInstallationToken } from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';
import { logger } from '../lib/logger.js';
import { createRedisClient } from '../lib/redis.js';

// ─── Constants ──────────────────────────────────────────────────

/** Dedicated queue name — digest jobs NEVER ride the review queue (isolation). */
export const DIGEST_QUEUE_NAME = 'digest';

/** Fixed v1 schedule: nightly at 03:00 UTC (D3 — shared cron, per-repo spread is a documented follow-up). */
export const DIGEST_CRON_PATTERN = '0 3 * * *';

/** Digest issue title (D6). */
export const DIGEST_ISSUE_TITLE = 'GHAGGA Health Digest';

/** Job scheduler id for a repository (D7: `digest:{repositoryId}`). */
export function digestSchedulerId(repositoryId: number): string {
  return `digest:${repositoryId}`;
}

// ─── Queue Configuration (mirrors review.ts:330) ───────────────

export interface DigestJobData {
  /** The ONLY payload field — settings/credentials re-resolved at processing time. */
  repositoryId: number;
}

const redisConnection = createRedisClient();

export const digestQueue = new Queue<DigestJobData, unknown, string>(DIGEST_QUEUE_NAME, {
  // biome-ignore lint/suspicious/noExplicitAny: bullmq ConnectionOptions vs our Redis connection shim — accepted cast (review.ts:332 precedent)
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// ─── Scheduler Registration (D7) ───────────────────────────────

/** The queue surface the schedule hooks need — injectable for tests (no live Redis). */
export interface DigestSchedulerQueue {
  upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: { pattern: string },
    jobTemplate: { name: string; data: DigestJobData },
  ): Promise<unknown>;
  removeJobScheduler(jobSchedulerId: string): Promise<boolean>;
  /** bullmq's `JobSchedulerJson.id` is nullable — reconcile filters non-ids out. */
  getJobSchedulers(): Promise<Array<{ id?: string | null }>>;
}

/** Keyed upsert — idempotent on restart (same jobId + cron ⇒ no second schedule). */
export function scheduleDigestForRepo(
  queue: DigestSchedulerQueue,
  repositoryId: number,
): Promise<unknown> {
  return queue.upsertJobScheduler(
    digestSchedulerId(repositoryId),
    { pattern: DIGEST_CRON_PATTERN },
    { name: 'run-digest', data: { repositoryId } },
  );
}

/** Opt-out removal — stored digest rows remain as audit; the scheduler stops firing. */
export function unscheduleDigestForRepo(
  queue: DigestSchedulerQueue,
  repositoryId: number,
): Promise<boolean> {
  return queue.removeJobScheduler(digestSchedulerId(repositoryId));
}

/** Resolve one repo's effective `digestsEnabled`, then register or remove its scheduler. */
async function applyDigestSchedulerForRepo(
  db: Database,
  queue: DigestSchedulerQueue,
  repo: Parameters<typeof getEffectiveRepoSettings>[1] & { id: number },
): Promise<'scheduled' | 'unscheduled'> {
  const effective = await getEffectiveRepoSettings(db, repo);
  if (effective.settings.digestsEnabled) {
    await scheduleDigestForRepo(queue, repo.id);
    return 'scheduled';
  }
  await unscheduleDigestForRepo(queue, repo.id);
  return 'unscheduled';
}

/**
 * Startup reconciler: diff `getJobSchedulers()` against DB opted-in repos
 * (resolved through effective settings) — add missing, remove stale. Idempotent:
 * re-running on every restart upserts the identical scheduler (no duplicates,
 * no extra runs).
 */
export async function reconcileDigestSchedulers(
  db: Database,
  queue: DigestSchedulerQueue,
): Promise<{ scheduled: number[]; removed: number[] }> {
  const repos = await getActiveRepositoriesForScheduling(db);

  const optedIn = new Set<number>();
  for (const repo of repos) {
    const effective = await getEffectiveRepoSettings(db, repo);
    if (effective.settings.digestsEnabled) {
      optedIn.add(repo.id);
    }
  }

  const existing = new Set(
    (await queue.getJobSchedulers())
      .map((s) => s.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('digest:')),
  );

  const scheduled: number[] = [];
  const removed: number[] = [];
  for (const repositoryId of optedIn) {
    if (!existing.has(digestSchedulerId(repositoryId))) {
      await scheduleDigestForRepo(queue, repositoryId);
    }
    scheduled.push(repositoryId);
  }
  for (const id of existing) {
    const repositoryId = Number(id.slice('digest:'.length));
    if (!Number.isFinite(repositoryId) || !optedIn.has(repositoryId)) {
      await queue.removeJobScheduler(id);
      removed.push(repositoryId);
    }
  }

  logger.info(
    { scheduled: scheduled.length, removed: removed.length },
    'digest: scheduler reconciliation complete',
  );
  return { scheduled, removed };
}

/**
 * Settings-change hook for ONE repository (PUT /api/settings): re-resolve that
 * repo's effective settings and schedule/unschedule accordingly.
 */
export async function reconcileDigestSchedulerForRepo(
  db: Database,
  queue: DigestSchedulerQueue,
  repositoryId: number,
): Promise<void> {
  const repo = await getRepositoryById(db, repositoryId);
  if (!repo?.isActive) return;
  await applyDigestSchedulerForRepo(db, queue, repo);
}

/**
 * Settings-change hook for an installation (installations merge route): the
 * global `digestsEnabled` affects every repo using global settings, so
 * re-reconcile each repo in the installation.
 */
export async function reconcileDigestSchedulersForInstallation(
  db: Database,
  queue: DigestSchedulerQueue,
  installationId: number,
): Promise<void> {
  const repos = await getReposByInstallationId(db, installationId);
  for (const repo of repos) {
    if (!repo.isActive) continue;
    await applyDigestSchedulerForRepo(db, queue, repo);
  }
}

// ─── Worker ─────────────────────────────────────────────────────

/** Publication seam — injectable for tests; the default builds a GitHub adapter. */
export interface DigestPublication {
  createDigestIssue(title: string, body: string): Promise<{ number: number }>;
  updateDigestIssue(issueNumber: number, body: string): Promise<void>;
  /** Adopt-before-create idempotency — see DigestPublicationCapable. */
  findOpenDigestIssue(title: string): Promise<{ number: number } | null>;
}

export interface DigestRunDeps {
  db: Database;
  /**
   * Publication seam FACTORY — runDigestForRepository builds the seam ONLY
   * after every skip guard passes (resilience B3). Constructing it eagerly
   * in the worker meant a deleted repo threw DURING seam construction (repo
   * lookup) instead of reaching the graceful SKIPPED guard: 3 rejected
   * BullMQ attempts and an FK-rejected FAILED row. Lazy construction also
   * means disabled/no-findings runs never mint an installation token.
   */
  makeForge: () => Promise<DigestPublication>;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /** Clock seam — fake timers in tests, `() => new Date()` in production. */
  now: () => Date;
}

/**
 * Build the real GitHub publication seam for one repository: installation
 * token mint + `makeGitHubAdapter` public port verbs (createDigestIssue /
 * updateDigestIssue). Never invoked by tests — they inject a `makeForge`
 * factory returning a fake instead.
 */
async function makeGitHubDigestPublication(
  db: Database,
  repositoryId: number,
): Promise<DigestPublication> {
  const repo = await getRepositoryById(db, repositoryId);
  if (!repo) {
    throw new Error(`digest: repository ${repositoryId} not found`);
  }
  const installation = await getInstallationById(db, repo.installationId);
  if (!installation) {
    throw new Error(`digest: installation ${repo.installationId} not found`);
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set');
  }

  const token = await getInstallationToken(installation.githubInstallationId, appId, privateKey);
  const [owner, repoName] = repo.fullName.split('/') as [string, string];
  const adapter = makeGitHubAdapter({ owner, repo: repoName, token });
  const repoRef = {
    kind: 'github' as const,
    nativeId: String(repo.githubRepoId),
    path: repo.fullName,
  };

  return {
    createDigestIssue: (title, body) => adapter.createDigestIssue(repoRef, title, body),
    updateDigestIssue: (issueNumber, body) => adapter.updateDigestIssue(repoRef, issueNumber, body),
    findOpenDigestIssue: (title) => adapter.findOpenDigestIssue(repoRef, title),
  };
}

/**
 * Run one digest for one repository (the worker's entire job body).
 *
 * Flow (design D1–D8):
 *  1. re-resolve effective settings → disabled at fire time → SKIPPED row.
 *  2. load review rows since the watermark (30-day ranking window).
 *  3. core aggregateHealth / rankFileRisk (pure; malformed jsonb tolerated).
 *  4. zero new findings → SKIPPED row, watermark UNCHANGED, zero forge calls.
 *  5. open row → updateDigestIssue on its issueNumber; 404 (issue gone) →
 *     create + rotate; no open row → createDigestIssue.
 *  6. POSTED row via rotateOpenDigest (flip old open + insert successor in ONE
 *     transaction — the one-open invariant never breaks): issueNumber,
 *     issueOpen=true, watermark=max(runAt, latest counted createdAt) (clock-
 *     skew guard — see step 6 body), score snapshot.
 *
 * Publication failures REJECT so BullMQ retries; the FAILED row is recorded by
 * the worker's failed handler once attempts are exhausted (recordFailedDigestRun).
 */
export async function runDigestForRepository(
  repositoryId: number,
  deps: DigestRunDeps,
): Promise<'POSTED' | 'SKIPPED'> {
  const { db, log } = deps;
  const runAt = deps.now();

  const repo = await getRepositoryById(db, repositoryId);
  if (!repo) {
    // Repo deleted after scheduling — nothing to record (FK would reject).
    log.warn({ repositoryId }, 'digest: repository not found — nothing to do');
    return 'SKIPPED';
  }

  const effective = await getEffectiveRepoSettings(db, repo);
  const open = await getOpenDigest(db, repositoryId);
  const previousWatermark = open?.watermark ?? null;

  // 1. Disabled at fire time (opted out since the scheduler was registered).
  if (!effective.settings.digestsEnabled) {
    await insertDigestRun(db, {
      repositoryId,
      runAt,
      status: 'SKIPPED',
      issueNumber: open?.issueNumber ?? null,
      issueOpen: false,
      watermark: previousWatermark,
      findingsCount: 0,
      score: open?.score ?? null,
      error: 'digests disabled at fire time',
    });
    log.info({ repositoryId }, 'digest: skipped — digestsEnabled resolved false at fire time');
    return 'SKIPPED';
  }

  // 2. Window rows: watermark cutoff AND 30-day ranking window.
  const rows = await getReviewsSinceWatermark(
    db,
    repositoryId,
    previousWatermark ?? undefined,
    runAt,
  );

  // 3. Pure core aggregation.
  const inputs = aggregateHealth(rows, previousWatermark ?? undefined);

  // 4. Skip-and-record: no new findings, watermark UNCHANGED, ZERO forge calls.
  if (inputs.findings.length === 0) {
    await insertDigestRun(db, {
      repositoryId,
      runAt,
      status: 'SKIPPED',
      issueNumber: open?.issueNumber ?? null,
      issueOpen: false,
      watermark: previousWatermark,
      findingsCount: 0,
      score: open?.score ?? null,
      error: 'no new findings since watermark',
    });
    log.info({ repositoryId }, 'digest: skipped — no new findings since watermark');
    return 'SKIPPED';
  }

  const fileRisks = rankFileRisk(inputs, runAt);
  const score = computeHealthScore(inputs.findings).score;
  const trend =
    open?.score != null
      ? computeTrend(score, [
          {
            timestamp: open.runAt.toISOString(),
            score: open.score,
            findingCounts: {},
            toolsRun: [],
            projectPath: repo.fullName,
          },
        ])
      : undefined;
  const body = formatDigestIssue(inputs, trend, fileRisks);

  // 5. Publish: update in place, or create (first run / rotated issue).
  // The seam is built HERE — after every skip guard — so guard skips (repo
  // gone, disabled, no new findings) never mint an installation token and
  // never throw seam-construction errors (B3: guards BEFORE the seam).
  const forge = await deps.makeForge();
  // Adopt-before-create (4R RISK-001/RES-001): a prior attempt may have
  // CREATED the issue and died before rotateOpenDigest committed — a blind
  // POST mints an orphan on every retry (BullMQ attempts 3 → up to 3 issues
  // per night, recurring). Look for an open digest issue first and ADOPT it;
  // the marker can't be faked into file paths (sanitize strips HTML
  // comments) and a user who hand-writes the exact title is voluntarily
  // adopting the digest.
  const createOrAdopt = async (): Promise<number> => {
    const existing = await forge.findOpenDigestIssue(DIGEST_ISSUE_TITLE);
    if (existing) {
      await forge.updateDigestIssue(existing.number, body);
      return existing.number;
    }
    const created = await forge.createDigestIssue(DIGEST_ISSUE_TITLE, body);
    return created.number;
  };
  let issueNumber: number;
  if (open?.issueNumber != null) {
    try {
      await forge.updateDigestIssue(open.issueNumber, body);
      issueNumber = open.issueNumber;
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        // Digest issue gone (deleted, or repo transferred): rotate to a
        // fresh one — THROUGH adopt-before-create, so a crashed prior
        // attempt's orphan is adopted instead of duplicated. NOTE: GitHub
        // allows EDITING a closed issue (200), so "closed" alone keeps the
        // same issue; only a vanished issue (404) rotates.
        issueNumber = await createOrAdopt();
      } else {
        // Permission drift / outage — reject so BullMQ retries, then the failed
        // handler records FAILED (attempts exhausted). Never a silent skip.
        throw error;
      }
    }
  } else {
    issueNumber = await createOrAdopt();
  }

  // 6. POSTED: rotate the open pointer to this run's row (flip + insert, ONE
  // transaction). The partial-unique index is the double-schedule blast wall.
  //
  // Clock-skew guard: `runAt` is the WORKER clock while review `createdAt`
  // values come from the DB clock (`defaultNow()`). The aggregation window
  // has no upper bound, so if the DB clock runs ahead, a counted row with
  // `createdAt > runAt` would ALSO satisfy the next run's
  // `createdAt > watermark` filter — double-counted. Pin the stored
  // watermark to the later of runAt and the max counted `createdAt` (rows
  // arrive ORDER BY createdAt ASC, so the last row carries the max).
  const latestCountedAt = rows.length > 0 ? rows[rows.length - 1]?.createdAt : undefined;
  const watermark =
    latestCountedAt && latestCountedAt.getTime() > runAt.getTime() ? latestCountedAt : runAt;

  const successor = await rotateOpenDigest(db, {
    repositoryId,
    successor: {
      runAt,
      issueNumber,
      watermark,
      findingsCount: inputs.findings.length,
      score,
    },
  });

  log.info(
    { repositoryId, issueNumber, findings: inputs.findings.length, score, runId: successor.id },
    'digest: posted',
  );
  return 'POSTED';
}

/**
 * Record a FAILED digest row once BullMQ attempts are exhausted (worker
 * `failed` handler). Carries the previous watermark unchanged; the scheduler
 * registration is untouched, so the next nightly run still fires.
 */
export async function recordFailedDigestRun(
  repositoryId: number,
  error: unknown,
  deps: Pick<DigestRunDeps, 'db' | 'log' | 'now'>,
): Promise<void> {
  const runAt = deps.now();
  const open = await getOpenDigest(deps.db, repositoryId);
  await insertDigestRun(deps.db, {
    repositoryId,
    runAt,
    status: 'FAILED',
    issueNumber: open?.issueNumber ?? null,
    issueOpen: false,
    watermark: open?.watermark ?? null,
    findingsCount: 0,
    score: open?.score ?? null,
    error: error instanceof Error ? error.message : String(error),
  });
  deps.log.error(
    { repositoryId, error: error instanceof Error ? error.message : String(error) },
    'digest: run FAILED (attempts exhausted)',
  );
}

/** Create the in-process digest worker (concurrency 2 — light DB + 1 forge call). */
export function createDigestWorker(concurrency = 2): Worker<DigestJobData, unknown, string> {
  const worker = new Worker<DigestJobData, unknown, string>(
    DIGEST_QUEUE_NAME,
    async (job) => {
      const db = createDatabaseFromEnv();
      return runDigestForRepository(job.data.repositoryId, {
        db,
        // Lazy seam (B3): constructed only after the skip guards pass inside
        // runDigestForRepository — a deleted repo reaches the graceful
        // SKIPPED instead of throwing here over 3 BullMQ attempts.
        makeForge: () => makeGitHubDigestPublication(db, job.data.repositoryId),
        log: logger,
        now: () => new Date(),
      });
    },
    {
      // biome-ignore lint/suspicious/noExplicitAny: bullmq ConnectionOptions vs our Redis connection shim — accepted cast (review.ts:1105 precedent)
      connection: redisConnection as any,
      concurrency,
    },
  );

  worker.on('failed', (job, err) => {
    // Log only the message — serializing the full error can leak job data
    // (workers/issue-analysis.ts:95-102 precedent).
    const final = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
    if (!final || !job) return;
    void (async () => {
      try {
        const db = createDatabaseFromEnv();
        await recordFailedDigestRun(job.data.repositoryId, err, {
          db,
          log: logger,
          now: () => new Date(),
        });
      } catch (recordError) {
        logger.error(
          {
            repositoryId: job.data.repositoryId,
            error: recordError instanceof Error ? recordError.message : String(recordError),
          },
          'digest: failed to record FAILED digest row',
        );
      }
    })();
  });

  return worker;
}

/** Close the digest queue's Redis connection (graceful shutdown). */
export async function closeDigestQueue(): Promise<void> {
  await digestQueue.close();
}
