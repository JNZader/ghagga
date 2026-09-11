import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { withPostgresHarness } from '../../test-support/postgres-harness.js';
import {
  lookupExplanationInvocation,
  recoverExpiredExplanationInvocationDispatch,
  registerExplanationInvocation,
  reserveExplanationInvocationDispatch,
  reserveExplanationPublicationCreate,
  reserveExplanationPublicationPatch,
  settleExplanationInvocation,
  settleExplanationPublicationCreate,
  settleExplanationPublicationPatch,
} from '../queries.js';
import * as schema from '../schema.js';

const identity = {
  forgeInstance: 'github.com',
  installationId: 'installation-42',
  actorId: 'actor-99',
  repositoryId: 'repository-7',
  pullRequestNumber: 17,
  requestedHeadSha: 'a'.repeat(40),
  sourceCommentId: 'comment-301',
  question: 'Why was this function changed?',
  questionHash: '70d5cef4a5624f6490a48ccecaf6405959c00e492047fee9b2d928abe48163c4',
};

describe('integration: explanation invocation registration', () => {
  it('commits one duplicate observation and releases a rolled-back contender after observable blocking', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );

      await harness.query(first, 'BEGIN');
      await expect(registerExplanationInvocation(firstDb, identity)).resolves.toMatchObject({
        status: 'registered',
      });
      const committedContender = registerExplanationInvocation(secondDb, identity);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'COMMIT');
      await expect(committedContender).resolves.toMatchObject({ status: 'duplicate' });

      const rollbackIdentity = { ...identity, sourceCommentId: 'comment-302' };
      await harness.query(first, 'BEGIN');
      await expect(registerExplanationInvocation(firstDb, rollbackIdentity)).resolves.toMatchObject(
        {
          status: 'registered',
        },
      );
      const rollbackContender = registerExplanationInvocation(secondDb, rollbackIdentity);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'ROLLBACK');
      await expect(rollbackContender).resolves.toMatchObject({ status: 'registered' });

      await expect(lookupExplanationInvocation(secondDb, identity)).resolves.toMatchObject({
        status: 'found',
        invocation: expect.objectContaining({ executionStatus: 'PENDING', progressVersion: 0 }),
      });
      const rows = await harness.query(
        observer,
        'SELECT source_comment_id, execution_status, outcome_status, progress_version FROM explanation_invocations ORDER BY source_comment_id',
      );
      expect(rows.rows).toEqual([
        {
          source_comment_id: 'comment-301',
          execution_status: 'PENDING',
          outcome_status: null,
          progress_version: 0,
        },
        {
          source_comment_id: 'comment-302',
          execution_status: 'PENDING',
          outcome_status: null,
          progress_version: 0,
        },
      ]);
      expect(rows.rows).toHaveLength(2);
    });

    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation terminal races', () => {
  it('keeps a committed winner and lets a rollback release the competing terminal write', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      for (const [sourceCommentId, resolution] of [
        ['comment-801', 'COMMIT'],
        ['comment-802', 'ROLLBACK'],
      ] as const) {
        const reserved = { ...identity, sourceCommentId };
        await registerExplanationInvocation(firstDb, reserved);
        await harness.query(
          observer,
          "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'race-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '1 minute' WHERE source_comment_id = '" +
            sourceCommentId +
            "'",
        );
        await harness.query(first, 'BEGIN');
        const winner = await settleExplanationInvocation(firstDb, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED',
          executionFence: 'race-fence',
          outcome: {
            kind: 'ANSWERED',
            answer: 'winner',
            metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 1 },
          },
        });
        const contender = settleExplanationInvocation(secondDb, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED',
          executionFence: 'race-fence',
          outcome:
            resolution === 'COMMIT'
              ? { kind: 'AMBIGUOUS', reason: 'uncertain' }
              : { kind: 'AI_UNAVAILABLE', reason: 'unavailable' },
        });
        await harness.waitForBlocked(observer, secondPid, firstPid);
        await harness.query(first, resolution);
        const observed = await contender;
        if (resolution === 'COMMIT') {
          expect(winner).toMatchObject({ status: 'settled' });
          expect(observed).toMatchObject({
            status: 'settled',
            invocation: {
              outcomePayload: expect.objectContaining({ kind: 'ANSWERED', answer: 'winner' }),
            },
          });
        } else {
          expect(observed).toMatchObject({
            status: 'settled',
            invocation: { outcomePayload: { kind: 'AI_UNAVAILABLE', reason: 'unavailable' } },
          });
        }
      }
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation terminal identity isolation', () => {
  it('settles each full identity and exact question independently', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first } = await harness.connectClients();
      const db = drizzle(first, { schema });
      const changedQuestion = 'Why did this branch change?';
      const variants = [
        { forgeInstance: 'github.enterprise' },
        { installationId: 'installation-43' },
        { actorId: 'actor-100' },
        { repositoryId: 'repository-8' },
        { pullRequestNumber: 18 },
        { requestedHeadSha: 'b'.repeat(40) },
        { sourceCommentId: 'comment-809' },
        { question: changedQuestion, questionHash: hashQuestion(changedQuestion) },
      ];
      for (const [index, variant] of variants.entries()) {
        const request = {
          ...identity,
          ...variant,
          sourceCommentId: variant.sourceCommentId ?? `comment-80${index}`,
        };
        await expect(registerExplanationInvocation(db, request)).resolves.toMatchObject({
          status: 'registered',
        });
        await expect(
          settleExplanationInvocation(db, {
            ...request,
            expectedExecutionStatus: 'PENDING' as const,
            outcome: { kind: 'INVALID', reason: 'isolated' },
          }),
        ).resolves.toMatchObject({ status: 'settled' });
      }
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

function hashQuestion(question: string): string {
  return createHash('sha256').update(question).digest('hex');
}

describe('integration: explanation invocation identity matrix', () => {
  it('keeps full identity unique across lifecycle states and leaves review and memory tables unchanged', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const db = drizzle(first, { schema });
      const before = (
        await harness.query<{ reviews: number; sessions: number; observations: number }>(
          observer,
          'SELECT (SELECT count(*)::int FROM reviews) AS reviews, (SELECT count(*)::int FROM memory_sessions) AS sessions, (SELECT count(*)::int FROM memory_observations) AS observations',
        )
      ).rows[0]!;
      const pendingIdentity = { ...identity, sourceCommentId: 'comment-401' };
      const reservedIdentity = { ...identity, sourceCommentId: 'comment-402' };
      const terminalIdentity = { ...identity, sourceCommentId: 'comment-403' };

      for (const request of [pendingIdentity, reservedIdentity, terminalIdentity]) {
        await expect(registerExplanationInvocation(db, request)).resolves.toMatchObject({
          status: 'registered',
        });
      }
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'reserved-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now(), progress_status = 'RESERVED', progress_version = 2, progress_publication_status = 'CREATE_STARTED', progress_publication_create_started_at = now(), progress_comment_id = 701, progress_expected_bot_author_id = 702, progress_publication_fence = 'progress-fence', progress_publication_version = 3 WHERE source_comment_id = 'comment-402'",
      );
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'ANSWERED', outcome_status = 'ANSWERED', outcome_answer = 'answer', outcome_completed_at = now(), progress_status = 'COMPLETED', progress_version = 4, answer_publication_status = 'PUBLISHED', answer_publication_create_started_at = now(), answer_comment_id = 801, answer_expected_bot_author_id = 802, answer_publication_fence = 'answer-fence', answer_publication_version = 5 WHERE source_comment_id = 'comment-403'",
      );

      for (const request of [pendingIdentity, reservedIdentity, terminalIdentity]) {
        const expected = await lookupExplanationInvocation(db, request);
        const duplicate = await registerExplanationInvocation(db, request);
        expect(expected.status).toBe('found');
        expect(duplicate).toEqual({
          status: 'duplicate',
          invocation: expected.status === 'found' ? expected.invocation : undefined,
        });
      }

      const changedQuestion = 'Why did this branch change?';
      const variants = [
        { ...identity, forgeInstance: 'github.enterprise', sourceCommentId: 'comment-411' },
        { ...identity, installationId: 'installation-43', sourceCommentId: 'comment-412' },
        { ...identity, actorId: 'actor-100', sourceCommentId: 'comment-413' },
        { ...identity, repositoryId: 'repository-8', sourceCommentId: 'comment-414' },
        { ...identity, pullRequestNumber: 18, sourceCommentId: 'comment-415' },
        { ...identity, requestedHeadSha: 'b'.repeat(40), sourceCommentId: 'comment-416' },
        { ...identity, sourceCommentId: 'comment-417' },
        {
          ...identity,
          sourceCommentId: 'comment-418',
          question: changedQuestion,
          questionHash: hashQuestion(changedQuestion),
        },
      ];
      for (const request of variants) {
        await expect(registerExplanationInvocation(db, request)).resolves.toMatchObject({
          status: 'registered',
        });
      }

      const rows = await harness.query<{ count: number }>(
        observer,
        'SELECT count(*)::int AS count FROM explanation_invocations',
      );
      expect(rows.rows).toEqual([{ count: 11 }]);
      const after = (
        await harness.query<{ reviews: number; sessions: number; observations: number }>(
          observer,
          'SELECT (SELECT count(*)::int FROM reviews) AS reviews, (SELECT count(*)::int FROM memory_sessions) AS sessions, (SELECT count(*)::int FROM memory_observations) AS observations',
        )
      ).rows[0]!;
      expect(after).toEqual(before);
    });

    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation settlement', () => {
  it('stores one fenced terminal payload without changing publication or progress state', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const db = drizzle(first, { schema });
      const settledIdentity = { ...identity, sourceCommentId: 'comment-501' };
      await expect(registerExplanationInvocation(db, settledIdentity)).resolves.toMatchObject({
        status: 'registered',
      });
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'settlement-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '1 minute', progress_status = 'RESERVED', progress_version = 7, progress_publication_status = 'PUBLISHED', progress_publication_version = 4 WHERE source_comment_id = 'comment-501'",
      );

      const request = {
        ...settledIdentity,
        expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
        executionFence: 'settlement-fence',
        outcome: {
          kind: 'ANSWERED' as const,
          answer: 'The guard validates the request before dispatch.',
          metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 12 },
        },
      };
      const firstSettlement = await settleExplanationInvocation(db, request);
      expect(firstSettlement).toMatchObject({
        status: 'settled',
      });
      if (firstSettlement.status !== 'settled') throw new Error('expected first settlement');
      const originalCompletedAt = firstSettlement.invocation.outcomeCompletedAt;
      await expect(settleExplanationInvocation(db, request)).resolves.toMatchObject({
        status: 'settled',
      });
      await expect(
        settleExplanationInvocation(db, {
          ...request,
          outcome: {
            ...request.outcome,
            metadata: { ...request.outcome.metadata, tokensUsed: 13 },
          },
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: {
          outcomePayload: request.outcome,
          outcomeCompletedAt: originalCompletedAt,
        },
      });
      const row = (
        await harness.query<{
          execution_status: string;
          outcome_status: string;
          outcome_answer: string;
          outcome_payload: unknown;
          progress_version: number;
          progress_publication_status: string;
          progress_publication_version: number;
        }>(
          observer,
          "SELECT execution_status, outcome_status, outcome_answer, outcome_payload, progress_version, progress_publication_status, progress_publication_version FROM explanation_invocations WHERE source_comment_id = 'comment-501'",
        )
      ).rows[0]!;
      expect(row).toEqual({
        execution_status: 'ANSWERED',
        outcome_status: 'ANSWERED',
        outcome_answer: 'The guard validates the request before dispatch.',
        outcome_payload: request.outcome,
        progress_version: 7,
        progress_publication_status: 'PUBLISHED',
        progress_publication_version: 4,
      });
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation settlement fences', () => {
  it('rejects borrowed pending authority and evaluates reserved leases after row-lock waits', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const pending = { ...identity, sourceCommentId: 'comment-601' };
      await expect(registerExplanationInvocation(firstDb, pending)).resolves.toMatchObject({
        status: 'registered',
      });
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_fence = 'borrowed', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '1 minute' WHERE source_comment_id = 'comment-601'",
      );
      await expect(
        settleExplanationInvocation(secondDb, {
          ...pending,
          expectedExecutionStatus: 'PENDING',
          outcome: { kind: 'AI_UNAVAILABLE', reason: 'provider unavailable' },
        }),
      ).resolves.toEqual({ status: 'unavailable' });

      for (const [sourceCommentId, resolution] of [
        ['comment-602', 'COMMIT'],
        ['comment-603', 'ROLLBACK'],
      ] as const) {
        const reserved = { ...identity, sourceCommentId };
        await expect(registerExplanationInvocation(firstDb, reserved)).resolves.toMatchObject({
          status: 'registered',
        });
        await harness.query(
          observer,
          "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'lease-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '100 milliseconds' WHERE source_comment_id = '" +
            sourceCommentId +
            "'",
        );
        await harness.query(first, 'BEGIN');
        await harness.query(
          first,
          "SELECT 1 FROM explanation_invocations WHERE source_comment_id = '" +
            sourceCommentId +
            "' FOR UPDATE",
        );
        const contender = settleExplanationInvocation(secondDb, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED',
          executionFence: 'lease-fence',
          outcome: { kind: 'AI_UNAVAILABLE', reason: 'provider unavailable' },
        });
        await harness.waitForBlocked(observer, secondPid, firstPid);
        await harness.query(first, 'SELECT pg_sleep(0.2)');
        await harness.query(first, resolution);
        await expect(contender).resolves.toEqual({ status: 'unavailable' });
      }
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation settlement post-lock leases', () => {
  it('rejects a lease that expires while a row lock is held through commit and rollback', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );

      for (const [sourceCommentId, resolution] of [
        ['comment-604', 'COMMIT'],
        ['comment-605', 'ROLLBACK'],
      ] as const) {
        const reserved = { ...identity, sourceCommentId };
        await expect(registerExplanationInvocation(firstDb, reserved)).resolves.toMatchObject({
          status: 'registered',
        });
        await harness.query(
          observer,
          "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'post-lock-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '100 milliseconds' WHERE source_comment_id = '" +
            sourceCommentId +
            "'",
        );
        await harness.query(first, 'BEGIN');
        await harness.query(
          first,
          "SELECT 1 FROM explanation_invocations WHERE source_comment_id = '" +
            sourceCommentId +
            "' FOR UPDATE",
        );
        const contender = settleExplanationInvocation(secondDb, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED',
          executionFence: 'post-lock-fence',
          outcome: { kind: 'AI_UNAVAILABLE', reason: 'provider unavailable' },
        });
        await harness.waitForBlocked(observer, secondPid, firstPid);
        await harness.query(first, 'SELECT pg_sleep(0.2)');
        await harness.query(first, resolution);
        await expect(contender).resolves.toEqual({ status: 'unavailable' });
      }
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation settlement matrix', () => {
  it('preserves allowed terminal boundaries, fences, identity, and legacy opacity', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const db = drizzle(first, { schema });
      const reloadedDb = drizzle(observer, { schema });
      const pendingOutcomes = [
        { kind: 'INVALID' as const, reason: 'invalid request' },
        { kind: 'UNAUTHORIZED' as const, reason: 'not authorized' },
        { kind: 'DISABLED' as const, reason: 'disabled' },
        { kind: 'STALE' as const, reason: 'stale' },
        { kind: 'AI_UNAVAILABLE' as const, reason: 'unavailable' },
      ];
      for (const [index, outcome] of pendingOutcomes.entries()) {
        const pending = { ...identity, sourceCommentId: `comment-70${index}` };
        await expect(registerExplanationInvocation(db, pending)).resolves.toMatchObject({
          status: 'registered',
        });
        await expect(
          settleExplanationInvocation(db, {
            ...pending,
            expectedExecutionStatus: 'PENDING' as const,
            outcome,
          }),
        ).resolves.toMatchObject({ status: 'settled', invocation: { outcomePayload: outcome } });
      }

      const reserved = { ...identity, sourceCommentId: 'comment-710' };
      await registerExplanationInvocation(db, reserved);
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'matrix-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() + interval '1 minute' WHERE source_comment_id = 'comment-710'",
      );
      const answered = {
        kind: 'ANSWERED' as const,
        answer: 'The answer is immutable.',
        metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 9 },
      };
      await expect(
        settleExplanationInvocation(db, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
          executionFence: 'wrong-fence',
          outcome: answered,
        }),
      ).resolves.toEqual({ status: 'unavailable' });
      const completed = await settleExplanationInvocation(db, {
        ...reserved,
        expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
        executionFence: 'matrix-fence',
        outcome: answered,
      });
      expect(completed).toMatchObject({
        status: 'settled',
        invocation: { outcomePayload: answered },
      });
      if (completed.status !== 'settled') throw new Error('expected completed settlement');
      await expect(
        settleExplanationInvocation(reloadedDb, {
          ...reserved,
          expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
          executionFence: 'matrix-fence',
          outcome: { kind: 'AI_UNAVAILABLE', reason: 'conflicting retry' },
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: {
          outcomePayload: answered,
          outcomeCompletedAt: completed.invocation.outcomeCompletedAt,
        },
      });

      const ambiguous = { ...identity, sourceCommentId: 'comment-711' };
      await registerExplanationInvocation(db, ambiguous);
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'DISPATCH_RESERVED', execution_fence = 'ambiguity-fence', dispatch_reserved_at = now(), dispatch_lease_expires_at = now() - interval '1 minute' WHERE source_comment_id = 'comment-711'",
      );
      await expect(
        settleExplanationInvocation(db, {
          ...ambiguous,
          expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
          executionFence: 'ambiguity-fence',
          outcome: { kind: 'AMBIGUOUS', reason: 'uncertain' },
        }),
      ).resolves.toMatchObject({ status: 'settled' });

      const legacy = { ...identity, sourceCommentId: 'comment-712' };
      await registerExplanationInvocation(db, legacy);
      await harness.query(
        observer,
        "UPDATE explanation_invocations SET execution_status = 'ANSWERED', outcome_status = 'ANSWERED', outcome_completed_at = now() WHERE source_comment_id = 'comment-712'",
      );
      await expect(
        settleExplanationInvocation(db, {
          ...legacy,
          expectedExecutionStatus: 'PENDING' as const,
          outcome: { kind: 'INVALID', reason: 'invalid' },
        }),
      ).resolves.toEqual({ status: 'unavailable' });
      await expect(
        settleExplanationInvocation(db, {
          ...legacy,
          actorId: 'other-actor',
          expectedExecutionStatus: 'PENDING' as const,
          outcome: { kind: 'INVALID', reason: 'invalid' },
        }),
      ).resolves.toEqual({ status: 'unavailable' });
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation invocation dispatch reservation and recovery', () => {
  it('commits exactly one reservation, releases a rollback contender, and never refreshes an observation', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const observerDb = drizzle(observer, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const request = { ...identity, sourceCommentId: 'comment-901', leaseDurationMs: 1_000 };

      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      await harness.query(first, 'BEGIN');
      const committedWinner = await reserveExplanationInvocationDispatch(firstDb, request);
      expect(committedWinner.status).toBe('reserved');
      const committedContender = reserveExplanationInvocationDispatch(secondDb, request);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await expect(lookupExplanationInvocation(observerDb, request)).resolves.toMatchObject({
        status: 'found',
        invocation: { executionStatus: 'PENDING' },
      });
      await harness.query(first, 'COMMIT');
      await expect(committedContender).resolves.toMatchObject({ status: 'observed' });

      if (committedWinner.status !== 'reserved') throw new Error('expected reservation winner');
      const activeObservation = await reserveExplanationInvocationDispatch(observerDb, request);
      expect(activeObservation).toMatchObject({
        status: 'observed',
        invocation: {
          executionStatus: 'DISPATCH_RESERVED',
          executionFence: committedWinner.executionFence,
          dispatchReservedAt: committedWinner.invocation.dispatchReservedAt,
          dispatchLeaseExpiresAt: committedWinner.invocation.dispatchLeaseExpiresAt,
        },
      });

      const rollbackRequest = {
        ...identity,
        sourceCommentId: 'comment-902',
        leaseDurationMs: 1_000,
      };
      await registerExplanationInvocation(firstDb, rollbackRequest);
      await harness.query(first, 'BEGIN');
      await expect(
        reserveExplanationInvocationDispatch(firstDb, rollbackRequest),
      ).resolves.toMatchObject({ status: 'reserved' });
      const rollbackContender = reserveExplanationInvocationDispatch(secondDb, rollbackRequest);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'ROLLBACK');
      const rollbackWinner = await rollbackContender;
      expect(rollbackWinner).toMatchObject({
        status: 'reserved',
        invocation: { executionStatus: 'DISPATCH_RESERVED' },
      });
      expect(rollbackWinner.status === 'reserved' && rollbackWinner.executionFence).toMatch(
        /^[0-9a-f-]{36}$/,
      );

      const durable = await harness.query<{
        source_comment_id: string;
        execution_status: string;
        execution_fence: string;
      }>(
        observer,
        "SELECT source_comment_id, execution_status, execution_fence FROM explanation_invocations WHERE source_comment_id IN ('comment-901', 'comment-902') ORDER BY source_comment_id",
      );
      expect(durable.rows).toHaveLength(2);
      expect(durable.rows.map((row) => row.execution_status)).toEqual([
        'DISPATCH_RESERVED',
        'DISPATCH_RESERVED',
      ]);
      expect(durable.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.execution_fence))).toBe(true);
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('recovers only an actually expired original fence after a lock and never redispatches it', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const request = { ...identity, sourceCommentId: 'comment-903', leaseDurationMs: 1_000 };
      await registerExplanationInvocation(firstDb, request);
      const reserved = await reserveExplanationInvocationDispatch(firstDb, request);
      if (reserved.status !== 'reserved') throw new Error('expected a reservation');

      await expect(
        recoverExpiredExplanationInvocationDispatch(secondDb, {
          ...identity,
          sourceCommentId: 'comment-903',
          executionFence: 'wrong-fence',
        }),
      ).resolves.toEqual({ status: 'unavailable' });
      await expect(
        recoverExpiredExplanationInvocationDispatch(secondDb, {
          ...identity,
          sourceCommentId: 'comment-903',
          executionFence: reserved.executionFence,
        }),
      ).resolves.toEqual({ status: 'unavailable' });

      await harness.query(
        observer,
        "UPDATE explanation_invocations SET dispatch_lease_expires_at = clock_timestamp() + interval '10 minutes' WHERE source_comment_id = 'comment-903'",
      );
      const initialLease = await harness.query<{ live: boolean }>(
        observer,
        "SELECT dispatch_lease_expires_at > clock_timestamp() AS live FROM explanation_invocations WHERE source_comment_id = 'comment-903'",
      );
      expect(initialLease.rows).toEqual([{ live: true }]);
      await harness.query(first, 'BEGIN');
      await harness.query(
        first,
        "SELECT 1 FROM explanation_invocations WHERE source_comment_id = 'comment-903' FOR UPDATE",
      );
      await harness.query(
        first,
        "UPDATE explanation_invocations SET dispatch_lease_expires_at = clock_timestamp() - interval '1 microsecond' WHERE source_comment_id = 'comment-903'",
      );
      const recovery = recoverExpiredExplanationInvocationDispatch(secondDb, {
        ...identity,
        sourceCommentId: 'comment-903',
        executionFence: reserved.executionFence,
      });
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'COMMIT');
      await expect(recovery).resolves.toMatchObject({
        status: 'recovered',
        invocation: {
          executionStatus: 'AMBIGUOUS',
          outcomeStatus: 'AMBIGUOUS',
          executionFence: reserved.executionFence,
        },
      });
      await expect(reserveExplanationInvocationDispatch(secondDb, request)).resolves.toMatchObject({
        status: 'observed',
        invocation: { executionStatus: 'AMBIGUOUS', executionFence: reserved.executionFence },
      });
      await expect(
        recoverExpiredExplanationInvocationDispatch(secondDb, {
          ...identity,
          sourceCommentId: 'comment-903',
          executionFence: reserved.executionFence,
        }),
      ).resolves.toEqual({ status: 'unavailable' });
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('keeps recovery fenced against committed terminal work, releases it after rollback, and rejects every changed identity', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );

      for (const [sourceCommentId, resolution] of [
        ['comment-904', 'COMMIT'],
        ['comment-905', 'ROLLBACK'],
      ] as const) {
        const request = { ...identity, sourceCommentId, leaseDurationMs: 1_000 };
        await registerExplanationInvocation(firstDb, request);
        const reserved = await reserveExplanationInvocationDispatch(firstDb, request);
        if (reserved.status !== 'reserved') throw new Error('expected a reservation');
        await harness.query(
          observer,
          `UPDATE explanation_invocations SET dispatch_lease_expires_at = clock_timestamp() - interval '1 microsecond' WHERE source_comment_id = '${sourceCommentId}'`,
        );
        await harness.query(first, 'BEGIN');
        await expect(
          settleExplanationInvocation(firstDb, {
            ...identity,
            sourceCommentId,
            expectedExecutionStatus: 'DISPATCH_RESERVED',
            executionFence: reserved.executionFence,
            outcome: { kind: 'AMBIGUOUS', reason: 'uncertain terminal writer' },
          }),
        ).resolves.toMatchObject({ status: 'settled' });
        const recovery = recoverExpiredExplanationInvocationDispatch(secondDb, {
          ...identity,
          sourceCommentId,
          executionFence: reserved.executionFence,
        });
        await harness.waitForBlocked(observer, secondPid, firstPid);
        await harness.query(first, resolution);
        if (resolution === 'COMMIT') {
          await expect(recovery).resolves.toEqual({ status: 'unavailable' });
        } else {
          await expect(recovery).resolves.toMatchObject({
            status: 'recovered',
            invocation: { executionStatus: 'AMBIGUOUS', executionFence: reserved.executionFence },
          });
        }
      }

      const isolated = { ...identity, sourceCommentId: 'comment-906', leaseDurationMs: 1_000 };
      await registerExplanationInvocation(firstDb, isolated);
      const changedQuestion = 'Why was a different function changed?';
      const changedQuestionHash = createHash('sha256').update(changedQuestion).digest('hex');
      const mismatches = [
        { forgeInstance: 'ghe.example.test' },
        { installationId: 'installation-43' },
        { actorId: 'actor-100' },
        { repositoryId: 'repository-8' },
        { pullRequestNumber: 18 },
        { requestedHeadSha: 'b'.repeat(40) },
        { sourceCommentId: 'comment-907' },
        { question: changedQuestion, questionHash: changedQuestionHash },
      ];
      for (const mismatch of mismatches) {
        await expect(
          reserveExplanationInvocationDispatch(secondDb, { ...isolated, ...mismatch }),
        ).resolves.toEqual({ status: 'unavailable' });
      }
      await expect(lookupExplanationInvocation(secondDb, isolated)).resolves.toMatchObject({
        status: 'found',
        invocation: { executionStatus: 'PENDING', executionFence: null },
      });
      const terminalReservation = await reserveExplanationInvocationDispatch(secondDb, isolated);
      if (terminalReservation.status !== 'reserved')
        throw new Error('expected an isolated reservation');
      const terminalOutcome = { kind: 'AMBIGUOUS' as const, reason: 'terminal duplicate replay' };
      await expect(
        settleExplanationInvocation(secondDb, {
          ...identity,
          sourceCommentId: 'comment-906',
          expectedExecutionStatus: 'DISPATCH_RESERVED',
          executionFence: terminalReservation.executionFence,
          outcome: terminalOutcome,
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: { outcomePayload: terminalOutcome },
      });
      await expect(reserveExplanationInvocationDispatch(secondDb, isolated)).resolves.toMatchObject(
        {
          status: 'observed',
          invocation: { executionStatus: 'AMBIGUOUS', outcomePayload: terminalOutcome },
        },
      );
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation publication CREATE persistence', () => {
  it('commits one fenced create per channel, settles once, and suppresses ambiguous recreation', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const sqlLog: { query: string; params: unknown[] }[] = [];
      const logger = {
        logQuery(query: string, params: unknown[]) {
          sqlLog.push({ query, params });
        },
      };
      const firstDb = drizzle(first, { schema, logger });
      const secondDb = drizzle(second, { schema, logger });
      const request = { ...identity, sourceCommentId: 'comment-1001' };
      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      const publicationSqlStart = sqlLog.length;

      const progressRequest = {
        ...request,
        channel: 'progress' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 701,
      };
      const [firstProgress, secondProgress] = await Promise.all([
        reserveExplanationPublicationCreate(firstDb, progressRequest),
        reserveExplanationPublicationCreate(secondDb, progressRequest),
      ]);
      const reservations = [firstProgress, secondProgress];
      expect(reservations.filter((result) => result.status === 'reserved')).toHaveLength(1);
      expect(reservations.filter((result) => result.status === 'observed')).toHaveLength(1);
      const progress = reservations.find((result) => result.status === 'reserved');
      if (progress?.status !== 'reserved') throw new Error('expected progress winner');

      const answer = await reserveExplanationPublicationCreate(firstDb, {
        ...request,
        channel: 'answer',
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 702,
      });
      if (answer.status !== 'reserved') throw new Error('expected answer reservation');

      await expect(
        settleExplanationPublicationCreate(secondDb, {
          ...progressRequest,
          expectedPublicationVersion: 1,
          publicationFence: progress.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 801,
        }),
      ).resolves.toMatchObject({ status: 'settled' });
      await expect(
        settleExplanationPublicationCreate(secondDb, {
          ...request,
          channel: 'answer',
          expectedPublicationVersion: 1,
          expectedBotAuthorId: 702,
          publicationFence: answer.publicationFence,
          outcome: 'UNCERTAIN',
        }),
      ).resolves.toMatchObject({ status: 'settled' });
      await expect(
        reserveExplanationPublicationCreate(secondDb, progressRequest),
      ).resolves.toMatchObject({
        status: 'observed',
        invocation: { progressPublicationStatus: 'PUBLISHED', progressCommentId: 801 },
      });
      await expect(
        reserveExplanationPublicationCreate(secondDb, {
          ...request,
          channel: 'answer',
          expectedPublicationVersion: 1,
          expectedBotAuthorId: 702,
        }),
      ).resolves.toMatchObject({
        status: 'observed',
        invocation: { answerPublicationStatus: 'AMBIGUOUS' },
      });

      const row = (
        await harness.query<{
          execution_status: string;
          progress_publication_status: string;
          progress_publication_version: number;
          answer_publication_status: string;
          answer_publication_version: number;
        }>(
          observer,
          "SELECT execution_status, progress_publication_status, progress_publication_version, answer_publication_status, answer_publication_version FROM explanation_invocations WHERE source_comment_id = 'comment-1001'",
        )
      ).rows[0]!;
      expect(row).toEqual({
        execution_status: 'PENDING',
        progress_publication_status: 'PUBLISHED',
        progress_publication_version: 2,
        answer_publication_status: 'AMBIGUOUS',
        answer_publication_version: 2,
      });
      const publicationSql = sqlLog.slice(publicationSqlStart);
      const publicationUpdates = publicationSql.filter(({ query }) =>
        query.toLowerCase().startsWith('update "explanation_invocations"'),
      );
      expect(publicationUpdates).toHaveLength(7);
      expect(reservations.filter((result) => result.status === 'reserved')).toHaveLength(1);
      expect(reservations.filter((result) => result.status === 'observed')).toHaveLength(1);
      for (const predicate of [
        'forge_instance',
        'installation_id',
        'actor_id',
        'repository_id',
        'pull_request_number',
        'requested_head_sha',
        'source_comment_id',
        'question_hash',
        'question',
      ]) {
        expect(
          publicationUpdates.every(({ query }) =>
            query.slice(query.indexOf(' where ')).includes(predicate),
          ),
        ).toBe(true);
      }
      for (const predicate of [
        'publication_status',
        'publication_version',
        'expected_bot_author_id',
        'publication_fence',
      ]) {
        expect(
          publicationUpdates.every(({ query }) =>
            query.slice(query.indexOf(' where ')).includes(predicate),
          ),
        ).toBe(true);
      }
      expect(publicationUpdates.every(({ params }) => params.length > 0)).toBe(true);
      expect(publicationSql.some(({ query }) => /insert|on conflict/i.test(query))).toBe(false);
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('commits a winner before caller I/O, releases rollback contention, and fences every late settlement', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const observerDb = drizzle(observer, { schema });
      const firstPid = Number(
        (await harness.query(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const secondPid = Number(
        (await harness.query(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const committed = { ...identity, sourceCommentId: 'comment-1002' };
      const request = {
        ...committed,
        channel: 'progress' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 711,
      };
      const reviewCountBefore = (
        await harness.query<{ count: number }>(
          observer,
          'SELECT count(*)::int AS count FROM reviews',
        )
      ).rows[0]!.count;
      await expect(registerExplanationInvocation(firstDb, committed)).resolves.toMatchObject({
        status: 'registered',
      });

      await harness.query(first, 'BEGIN');
      const winner = await reserveExplanationPublicationCreate(firstDb, request);
      if (winner.status !== 'reserved') throw new Error('expected committed reservation');
      const contender = reserveExplanationPublicationCreate(secondDb, request);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await expect(lookupExplanationInvocation(observerDb, committed)).resolves.toMatchObject({
        status: 'found',
        invocation: { progressPublicationStatus: 'NOT_STARTED', progressPublicationVersion: 0 },
      });
      await harness.query(first, 'COMMIT');
      await expect(contender).resolves.toMatchObject({ status: 'observed' });
      const committedRow = (
        await harness.query<{
          execution_status: string;
          progress_publication_status: string;
          progress_publication_version: number;
          progress_expected_bot_author_id: string;
          progress_publication_fence: string;
        }>(
          observer,
          "SELECT execution_status, progress_publication_status, progress_publication_version, progress_expected_bot_author_id, progress_publication_fence FROM explanation_invocations WHERE source_comment_id = 'comment-1002'",
        )
      ).rows[0]!;
      expect(committedRow).toMatchObject({
        execution_status: 'PENDING',
        progress_publication_status: 'CREATE_STARTED',
        progress_publication_version: 1,
        progress_expected_bot_author_id: '711',
        progress_publication_fence: winner.publicationFence,
      });

      const changedQuestion = 'Why was this different function changed?';
      for (const mismatch of [
        { forgeInstance: 'github.enterprise' },
        { installationId: 'installation-43' },
        { actorId: 'actor-100' },
        { repositoryId: 'repository-8' },
        { pullRequestNumber: 18 },
        { requestedHeadSha: 'b'.repeat(40) },
        { sourceCommentId: 'comment-1004' },
        { question: changedQuestion, questionHash: hashQuestion(changedQuestion) },
      ]) {
        await expect(
          reserveExplanationPublicationCreate(secondDb, { ...request, ...mismatch }),
        ).resolves.toEqual({ status: 'unavailable' });
      }

      await expect(
        settleExplanationPublicationCreate(secondDb, {
          ...request,
          expectedPublicationVersion: 0,
          publicationFence: winner.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 811,
        }),
      ).resolves.toEqual({ status: 'invalid' });
      for (const invalidAuthority of [
        { expectedPublicationVersion: 2 },
        { expectedBotAuthorId: 712 },
        { publicationFence: 'wrong-fence' },
      ]) {
        await expect(
          settleExplanationPublicationCreate(secondDb, {
            ...request,
            expectedPublicationVersion: 1,
            expectedBotAuthorId: 711,
            publicationFence: winner.publicationFence,
            outcome: 'ACKNOWLEDGED',
            commentId: 811,
            ...invalidAuthority,
          }),
        ).resolves.toMatchObject({ status: 'observed' });
      }
      await expect(
        settleExplanationPublicationCreate(secondDb, {
          ...request,
          expectedPublicationVersion: 1,
          publicationFence: winner.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 811,
        }),
      ).resolves.toMatchObject({ status: 'settled' });
      await expect(
        settleExplanationPublicationCreate(secondDb, {
          ...request,
          expectedPublicationVersion: 1,
          publicationFence: winner.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 811,
        }),
      ).resolves.toMatchObject({ status: 'observed' });

      const rollback = { ...identity, sourceCommentId: 'comment-1003' };
      const rollbackRequest = { ...request, ...rollback, channel: 'answer' as const };
      await expect(registerExplanationInvocation(firstDb, rollback)).resolves.toMatchObject({
        status: 'registered',
      });
      await harness.query(first, 'BEGIN');
      await expect(
        reserveExplanationPublicationCreate(firstDb, rollbackRequest),
      ).resolves.toMatchObject({
        status: 'reserved',
      });
      const released = reserveExplanationPublicationCreate(secondDb, rollbackRequest);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'ROLLBACK');
      await expect(released).resolves.toMatchObject({
        status: 'reserved',
        invocation: { answerPublicationStatus: 'CREATE_STARTED', answerPublicationVersion: 1 },
      });
      const reviewCountAfter = (
        await harness.query<{ count: number }>(
          observer,
          'SELECT count(*)::int AS count FROM reviews',
        )
      ).rows[0]!.count;
      expect(reviewCountAfter).toBe(reviewCountBefore);
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('makes a terminal boundary reservation visible to simulated caller I/O and preserves a seeded review row', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const observerDb = drizzle(observer, { schema });
      const installationId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            "INSERT INTO installations (github_installation_id, account_login, account_type) VALUES (9901, 'seed-owner', 'Organization') RETURNING id",
          )
        ).rows[0]!.id,
      );
      const repositoryId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            `INSERT INTO repositories (github_repo_id, installation_id, full_name) VALUES (9902, ${installationId}, 'seed-owner/seed-repository') RETURNING id`,
          )
        ).rows[0]!.id,
      );
      const reviewId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            `INSERT INTO reviews (repository_id, pr_number, status, mode, summary, findings, tokens_used, execution_time_ms, metadata) VALUES (${repositoryId}, 17, 'NEEDS_HUMAN_REVIEW', 'workflow', 'seeded review summary', '[{"rule":"seed-rule","severity":"high"}]'::jsonb, 321, 654, '{"source":"unit4i-proof","keep":true}'::jsonb) RETURNING id`,
          )
        ).rows[0]!.id,
      );
      const reviewBefore = (
        await harness.query<Record<string, unknown>>(
          observer,
          `SELECT * FROM reviews WHERE id = ${reviewId}`,
        )
      ).rows[0]!;
      const request = {
        ...identity,
        sourceCommentId: 'comment-1005',
        channel: 'progress' as const,
        expectedPublicationVersion: 2_147_483_645,
        expectedBotAuthorId: 721,
      };
      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      const seededVersion = await harness.query<{ progress_publication_version: number }>(
        observer,
        "UPDATE explanation_invocations SET progress_publication_version = 2147483645 WHERE source_comment_id = 'comment-1005' RETURNING progress_publication_version",
      );
      expect(seededVersion.rows).toEqual([{ progress_publication_version: 2_147_483_645 }]);

      const events: string[] = [];
      let callbackInvoked = false;
      await harness.query(first, 'BEGIN');
      const reservation = await reserveExplanationPublicationCreate(firstDb, request);
      if (reservation.status !== 'reserved') throw new Error('expected terminal reservation');
      events.push('reserved');
      expect(callbackInvoked).toBe(false);
      expect(events).toEqual(['reserved']);

      const simulatedSend = async () => {
        expect(events).toEqual(['reserved', 'committed']);
        const visible = await lookupExplanationInvocation(observerDb, request);
        expect(visible).toMatchObject({
          status: 'found',
          invocation: {
            progressPublicationStatus: 'CREATE_STARTED',
            progressPublicationVersion: 2_147_483_646,
            progressExpectedBotAuthorId: 721,
            progressPublicationFence: reservation.publicationFence,
          },
        });
        callbackInvoked = true;
        events.push('simulated-send');
      };

      await harness.query(first, 'COMMIT');
      events.push('committed');
      await simulatedSend();
      expect(callbackInvoked).toBe(true);
      expect(events).toEqual(['reserved', 'committed', 'simulated-send']);

      await expect(
        settleExplanationPublicationCreate(firstDb, {
          ...request,
          expectedPublicationVersion: 2_147_483_646,
          publicationFence: reservation.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 821,
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: {
          progressPublicationStatus: 'PUBLISHED',
          progressPublicationVersion: 2_147_483_647,
        },
      });
      const reviewAfter = (
        await harness.query<Record<string, unknown>>(
          observer,
          `SELECT * FROM reviews WHERE id = ${reviewId}`,
        )
      ).rows[0]!;
      expect(reviewAfter).toEqual(reviewBefore);
    });

    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});

describe('integration: explanation publication PATCH persistence', () => {
  it('accepts PATCH_STARTED on both channels and rejects unknown publication statuses', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const request = { ...identity, sourceCommentId: 'comment-1100' };
      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      await expect(
        harness.query(
          first,
          "UPDATE explanation_invocations SET progress_publication_status = 'PATCH_STARTED', answer_publication_status = 'PATCH_STARTED' WHERE source_comment_id = 'comment-1100'",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        harness.query(
          first,
          "UPDATE explanation_invocations SET progress_publication_status = 'UNKNOWN' WHERE source_comment_id = 'comment-1100'",
        ),
      ).rejects.toThrow();
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('fences both PATCH channels, exposes the committed reservation, and suppresses retries', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const observerDb = drizzle(observer, { schema });
      const request = { ...identity, sourceCommentId: 'comment-1101' };
      const create = {
        ...request,
        channel: 'progress' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 751,
      };
      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      const created = await reserveExplanationPublicationCreate(firstDb, create);
      if (created.status !== 'reserved') throw new Error('expected published seed reservation');
      await expect(
        settleExplanationPublicationCreate(firstDb, {
          ...create,
          expectedPublicationVersion: 1,
          publicationFence: created.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 901,
        }),
      ).resolves.toMatchObject({ status: 'settled' });

      const patch = {
        ...request,
        channel: 'progress' as const,
        expectedPublicationVersion: 2,
        expectedBotAuthorId: 751,
        commentId: 901,
      };
      const [firstPatch, secondPatch] = await Promise.all([
        reserveExplanationPublicationPatch(firstDb, patch),
        reserveExplanationPublicationPatch(secondDb, patch),
      ]);
      const reservations = [firstPatch, secondPatch];
      expect(reservations.filter((entry) => entry.status === 'reserved')).toHaveLength(1);
      expect(reservations.filter((entry) => entry.status === 'observed')).toHaveLength(1);
      const winner = reservations.find((entry) => entry.status === 'reserved');
      if (winner?.status !== 'reserved') throw new Error('expected patch winner');
      await expect(lookupExplanationInvocation(observerDb, request)).resolves.toMatchObject({
        status: 'found',
        invocation: {
          progressPublicationStatus: 'PATCH_STARTED',
          progressPublicationVersion: 3,
          progressCommentId: 901,
          progressExpectedBotAuthorId: 751,
          progressPublicationFence: winner.publicationFence,
        },
      });
      const createStartedAt = (
        await harness.query<{ progress_publication_create_started_at: string }>(
          observer,
          "SELECT progress_publication_create_started_at FROM explanation_invocations WHERE source_comment_id = 'comment-1101'",
        )
      ).rows[0]!.progress_publication_create_started_at;
      expect(createStartedAt).toBeTruthy();

      for (const mismatch of [
        { forgeInstance: 'github.enterprise' },
        { installationId: 'installation-43' },
        { actorId: 'actor-100' },
        { repositoryId: 'repository-8' },
        { pullRequestNumber: 18 },
        { requestedHeadSha: 'b'.repeat(40) },
        { sourceCommentId: 'comment-1102' },
        { question: 'changed question', questionHash: hashQuestion('changed question') },
      ]) {
        await expect(
          reserveExplanationPublicationPatch(secondDb, { ...patch, ...mismatch }),
        ).resolves.toEqual({
          status: 'unavailable',
        });
      }
      for (const wrongAuthority of [
        { expectedPublicationVersion: 2 },
        { expectedBotAuthorId: 752 },
        { commentId: 902 },
        { publicationFence: 'wrong-fence' },
      ]) {
        await expect(
          settleExplanationPublicationPatch(secondDb, {
            ...patch,
            expectedPublicationVersion: 3,
            publicationFence: winner.publicationFence,
            outcome: 'ACKNOWLEDGED',
            ...wrongAuthority,
          }),
        ).resolves.toMatchObject({ status: 'observed' });
      }
      await expect(
        settleExplanationPublicationPatch(secondDb, {
          ...patch,
          expectedPublicationVersion: 3,
          publicationFence: winner.publicationFence,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: {
          progressPublicationStatus: 'PUBLISHED',
          progressPublicationVersion: 4,
          progressCommentId: 901,
          answerPublicationStatus: 'NOT_STARTED',
        },
      });
      await expect(
        settleExplanationPublicationPatch(secondDb, {
          ...patch,
          expectedPublicationVersion: 3,
          publicationFence: winner.publicationFence,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toMatchObject({ status: 'observed' });

      const uncertainRequest = { ...identity, sourceCommentId: 'comment-1103' };
      const uncertainCreate = {
        ...uncertainRequest,
        channel: 'answer' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 753,
      };
      await registerExplanationInvocation(firstDb, uncertainRequest);
      const uncertainCreated = await reserveExplanationPublicationCreate(firstDb, uncertainCreate);
      if (uncertainCreated.status !== 'reserved')
        throw new Error('expected uncertain seed reservation');
      await settleExplanationPublicationCreate(firstDb, {
        ...uncertainCreate,
        expectedPublicationVersion: 1,
        publicationFence: uncertainCreated.publicationFence,
        outcome: 'ACKNOWLEDGED',
        commentId: 903,
      });
      const uncertainPatch = await reserveExplanationPublicationPatch(firstDb, {
        ...uncertainRequest,
        channel: 'answer',
        expectedPublicationVersion: 2,
        expectedBotAuthorId: 753,
        commentId: 903,
      });
      if (uncertainPatch.status !== 'reserved')
        throw new Error('expected uncertain patch reservation');
      await expect(
        settleExplanationPublicationPatch(firstDb, {
          ...uncertainRequest,
          channel: 'answer',
          expectedPublicationVersion: 3,
          expectedBotAuthorId: 753,
          commentId: 903,
          publicationFence: uncertainPatch.publicationFence,
          outcome: 'UNCERTAIN',
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: { answerPublicationStatus: 'AMBIGUOUS' },
      });
      await expect(
        reserveExplanationPublicationPatch(secondDb, {
          ...uncertainRequest,
          channel: 'answer',
          expectedPublicationVersion: 4,
          expectedBotAuthorId: 753,
          commentId: 903,
        }),
      ).resolves.toMatchObject({
        status: 'observed',
        invocation: { answerPublicationStatus: 'AMBIGUOUS' },
      });
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('releases a rolled-back PATCH reservation so the blocked contender can reserve it', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      const secondDb = drizzle(second, { schema });
      const firstPid = Number(
        (await harness.query<{ pid: number }>(first, 'SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid,
      );
      const secondPid = Number(
        (await harness.query<{ pid: number }>(second, 'SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid,
      );
      const request = { ...identity, sourceCommentId: 'comment-1104' };
      const create = {
        ...request,
        channel: 'answer' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 754,
      };
      await registerExplanationInvocation(firstDb, request);
      const created = await reserveExplanationPublicationCreate(firstDb, create);
      if (created.status !== 'reserved') throw new Error('expected rollback seed reservation');
      await settleExplanationPublicationCreate(firstDb, {
        ...create,
        expectedPublicationVersion: 1,
        publicationFence: created.publicationFence,
        outcome: 'ACKNOWLEDGED',
        commentId: 904,
      });
      const patch = {
        ...request,
        channel: 'answer' as const,
        expectedPublicationVersion: 2,
        expectedBotAuthorId: 754,
        commentId: 904,
      };
      await harness.query(first, 'BEGIN');
      await expect(reserveExplanationPublicationPatch(firstDb, patch)).resolves.toMatchObject({
        status: 'reserved',
      });
      const contender = reserveExplanationPublicationPatch(secondDb, patch);
      await harness.waitForBlocked(observer, secondPid, firstPid);
      await harness.query(first, 'ROLLBACK');
      await expect(contender).resolves.toMatchObject({
        status: 'reserved',
        invocation: { answerPublicationStatus: 'PATCH_STARTED', answerPublicationVersion: 3 },
      });
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('denies every valid-but-wrong PATCH authority and forbidden predecessor on both channels without mutating its row', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const firstDb = drizzle(first, { schema });
      for (const channel of ['progress', 'answer'] as const) {
        const fields =
          channel === 'progress'
            ? {
                status: 'progress_publication_status',
                fence: 'progress_publication_fence',
              }
            : {
                status: 'answer_publication_status',
                fence: 'answer_publication_fence',
              };
        const denialCases = [
          { label: 'wrong owner', request: { expectedBotAuthorId: 782 } },
          { label: 'wrong comment', request: { commentId: 972 } },
          { label: 'wrong version', request: { expectedPublicationVersion: 1 } },
          { label: 'active fence', fence: 'already-active-fence' },
          { label: 'NOT_STARTED', status: 'NOT_STARTED' },
          { label: 'CREATE_STARTED', status: 'CREATE_STARTED' },
          { label: 'STALE', status: 'STALE' },
          { label: 'PATCH_STARTED', status: 'PATCH_STARTED' },
          { label: 'AMBIGUOUS', status: 'AMBIGUOUS' },
        ];
        for (const [index, denial] of denialCases.entries()) {
          const request = { ...identity, sourceCommentId: `comment-1110-${channel}-${index}` };
          const create = {
            ...request,
            channel,
            expectedPublicationVersion: 0,
            expectedBotAuthorId: 781,
          };
          await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
            status: 'registered',
          });
          const created = await reserveExplanationPublicationCreate(firstDb, create);
          if (created.status !== 'reserved') throw new Error(`expected ${channel} published seed`);
          await expect(
            settleExplanationPublicationCreate(firstDb, {
              ...create,
              expectedPublicationVersion: 1,
              publicationFence: created.publicationFence,
              outcome: 'ACKNOWLEDGED',
              commentId: 971,
            }),
          ).resolves.toMatchObject({ status: 'settled' });
          if ('fence' in denial) {
            await expect(
              harness.query(
                observer,
                `UPDATE explanation_invocations SET ${fields.fence} = '${denial.fence}' WHERE source_comment_id = '${request.sourceCommentId}'`,
              ),
            ).resolves.toMatchObject({ rowCount: 1 });
          }
          if ('status' in denial) {
            await expect(
              harness.query(
                observer,
                `UPDATE explanation_invocations SET ${fields.status} = '${denial.status}' WHERE source_comment_id = '${request.sourceCommentId}'`,
              ),
            ).resolves.toMatchObject({ rowCount: 1 });
          }
          const before = (
            await harness.query<Record<string, unknown>>(
              observer,
              `SELECT * FROM explanation_invocations WHERE source_comment_id = '${request.sourceCommentId}'`,
            )
          ).rows[0]!;
          await expect(
            reserveExplanationPublicationPatch(firstDb, {
              ...request,
              channel,
              expectedPublicationVersion: 2,
              expectedBotAuthorId: 781,
              commentId: 971,
              ...('request' in denial ? denial.request : {}),
            }),
          ).resolves.toMatchObject({ status: 'observed' });
          const after = (
            await harness.query<Record<string, unknown>>(
              observer,
              `SELECT * FROM explanation_invocations WHERE source_comment_id = '${request.sourceCommentId}'`,
            )
          ).rows[0]!;
          expect(after).toEqual(before);
        }
      }
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);

  it('commits the terminal PATCH before simulated caller I/O, logs its CAS, and preserves review and other-channel state', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, observer } = await harness.connectClients();
      const sqlLog: { query: string; params: unknown[] }[] = [];
      const logger = {
        logQuery: (query: string, params: unknown[]) => sqlLog.push({ query, params }),
      };
      const firstDb = drizzle(first, { schema, logger });
      const observerDb = drizzle(observer, { schema });
      const installationId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            "INSERT INTO installations (github_installation_id, account_login, account_type) VALUES (9911, 'patch-owner', 'Organization') RETURNING id",
          )
        ).rows[0]!.id,
      );
      const repositoryId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            `INSERT INTO repositories (github_repo_id, installation_id, full_name) VALUES (9912, ${installationId}, 'patch-owner/patch-repository') RETURNING id`,
          )
        ).rows[0]!.id,
      );
      const reviewId = Number(
        (
          await harness.query<{ id: number }>(
            observer,
            `INSERT INTO reviews (repository_id, pr_number, status, mode, summary, findings, tokens_used, execution_time_ms, metadata) VALUES (${repositoryId}, 18, 'NEEDS_HUMAN_REVIEW', 'workflow', 'PATCH review summary', '[{"rule":"patch-rule","severity":"high"}]'::jsonb, 322, 655, '{"source":"unit4j-proof","keep":true}'::jsonb) RETURNING id`,
          )
        ).rows[0]!.id,
      );
      const reviewBefore = (
        await harness.query<Record<string, unknown>>(
          observer,
          `SELECT * FROM reviews WHERE id = ${reviewId}`,
        )
      ).rows[0]!;
      const request = { ...identity, sourceCommentId: 'comment-1105' };
      const create = {
        ...request,
        channel: 'progress' as const,
        expectedPublicationVersion: 0,
        expectedBotAuthorId: 761,
      };
      await expect(registerExplanationInvocation(firstDb, request)).resolves.toMatchObject({
        status: 'registered',
      });
      const created = await reserveExplanationPublicationCreate(firstDb, create);
      if (created.status !== 'reserved') throw new Error('expected published PATCH seed');
      await expect(
        settleExplanationPublicationCreate(firstDb, {
          ...create,
          expectedPublicationVersion: 1,
          publicationFence: created.publicationFence,
          outcome: 'ACKNOWLEDGED',
          commentId: 971,
        }),
      ).resolves.toMatchObject({ status: 'settled' });
      await expect(
        harness.query(
          observer,
          "UPDATE explanation_invocations SET progress_publication_version = 2147483645 WHERE source_comment_id = 'comment-1105'",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const invocationBefore = (
        await harness.query<Record<string, unknown>>(
          observer,
          "SELECT * FROM explanation_invocations WHERE source_comment_id = 'comment-1105'",
        )
      ).rows[0]!;
      const publicationSqlStart = sqlLog.length;
      const patch = {
        ...request,
        channel: 'progress' as const,
        expectedPublicationVersion: 2_147_483_645,
        expectedBotAuthorId: 761,
        commentId: 971,
      };
      const events: string[] = [];
      await harness.query(first, 'BEGIN');
      const reservation = await reserveExplanationPublicationPatch(firstDb, patch);
      if (reservation.status !== 'reserved') throw new Error('expected terminal PATCH reservation');
      events.push('reserved');
      await expect(lookupExplanationInvocation(observerDb, request)).resolves.toMatchObject({
        status: 'found',
        invocation: {
          progressPublicationStatus: 'PUBLISHED',
          progressPublicationVersion: 2_147_483_645,
        },
      });
      await harness.query(first, 'COMMIT');
      events.push('committed');
      const simulatedSend = async () => {
        expect(events).toEqual(['reserved', 'committed']);
        await expect(lookupExplanationInvocation(observerDb, request)).resolves.toMatchObject({
          status: 'found',
          invocation: {
            progressPublicationStatus: 'PATCH_STARTED',
            progressPublicationVersion: 2_147_483_646,
            progressExpectedBotAuthorId: 761,
            progressCommentId: 971,
            progressPublicationFence: reservation.publicationFence,
          },
        });
        events.push('simulated-send');
      };
      await simulatedSend();
      expect(events).toEqual(['reserved', 'committed', 'simulated-send']);
      await expect(
        settleExplanationPublicationPatch(firstDb, {
          ...patch,
          expectedPublicationVersion: 2_147_483_646,
          publicationFence: reservation.publicationFence,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: {
          progressPublicationStatus: 'PUBLISHED',
          progressPublicationVersion: 2_147_483_647,
        },
      });
      await expect(
        settleExplanationPublicationPatch(firstDb, {
          ...patch,
          expectedPublicationVersion: 2_147_483_646,
          publicationFence: reservation.publicationFence,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toMatchObject({ status: 'observed' });

      const invocationAfter = (
        await harness.query<Record<string, unknown>>(
          observer,
          "SELECT * FROM explanation_invocations WHERE source_comment_id = 'comment-1105'",
        )
      ).rows[0]!;
      expect(invocationAfter).toEqual({
        ...invocationBefore,
        progress_publication_status: 'PUBLISHED',
        progress_publication_version: 2_147_483_647,
        progress_publication_fence: null,
      });
      const reviewAfter = (
        await harness.query<Record<string, unknown>>(
          observer,
          `SELECT * FROM reviews WHERE id = ${reviewId}`,
        )
      ).rows[0]!;
      expect(reviewAfter).toEqual(reviewBefore);

      const publicationSql = sqlLog.slice(publicationSqlStart);
      const publicationUpdates = publicationSql.filter(({ query }) =>
        query.toLowerCase().startsWith('update "explanation_invocations"'),
      );
      expect(publicationUpdates).toHaveLength(3);
      const successfulMutations = 2;
      expect(successfulMutations).toBe(2);
      for (const predicate of [
        'forge_instance',
        'installation_id',
        'actor_id',
        'repository_id',
        'pull_request_number',
        'requested_head_sha',
        'source_comment_id',
        'question_hash',
        'question',
        'publication_status',
        'publication_version',
        'expected_bot_author_id',
        'comment_id',
        'publication_fence',
      ]) {
        expect(
          publicationUpdates.every(({ query }) =>
            query.slice(query.toLowerCase().indexOf(' where ')).includes(predicate),
          ),
        ).toBe(true);
      }
      expect(publicationSql.some(({ query }) => /insert|on conflict/i.test(query))).toBe(false);
    });
    expect(result.cleanup).toEqual({
      clientsReleased: true,
      poolEnded: true,
      containerStopped: true,
    });
  }, 180_000);
});
