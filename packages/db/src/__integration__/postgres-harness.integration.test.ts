import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresHarness } from '../../test-support/postgres-harness.js';

type ProbeRow = { key: number };

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]!.pid;
}

const cleaned = { clientsReleased: true, poolEnded: true, containerStopped: true };

describe('integration: disposable PostgreSQL concurrency harness', () => {
  it('observes transaction visibility, unique-key blocking, rollback release, and cleanup', async () => {
    const result = await withPostgresHarness(async (harness) => {
      const { first, second, observer } = await harness.connectClients();
      const pids = await Promise.all([backendPid(first), backendPid(second), backendPid(observer)]);
      expect(new Set(pids).size).toBe(3);
      await harness.query(observer, 'CREATE TABLE harness_probe (key integer PRIMARY KEY)');

      await harness.query(first, 'BEGIN');
      await harness.query(first, 'INSERT INTO harness_probe VALUES (1)');
      expect(
        (await harness.query<ProbeRow>(observer, 'SELECT key FROM harness_probe')).rows,
      ).toEqual([]);
      const committedContender = harness.query(second, 'INSERT INTO harness_probe VALUES (1)');
      await harness.waitForBlocked(observer, pids[1]!, pids[0]!);
      await harness.query(first, 'COMMIT');
      await expect(committedContender).rejects.toThrow(/duplicate key/i);

      await harness.query(first, 'BEGIN');
      await harness.query(first, 'INSERT INTO harness_probe VALUES (2)');
      const rolledBackContender = harness.query(second, 'INSERT INTO harness_probe VALUES (2)');
      await harness.waitForBlocked(observer, pids[1]!, pids[0]!);
      await harness.query(first, 'ROLLBACK');
      await expect(rolledBackContender).resolves.toMatchObject({ rowCount: 1 });
      expect(
        (await harness.query<ProbeRow>(observer, 'SELECT key FROM harness_probe ORDER BY key'))
          .rows,
      ).toEqual([{ key: 1 }, { key: 2 }]);
      return harness.containerId;
    });

    expect(result.value).toMatch(/^[a-f0-9]+$/);
    expect(result.cleanup).toEqual(cleaned);
  }, 180_000);

  it('releases active clients and blocked work after a controlled callback failure', async () => {
    let cleanup: typeof cleaned | undefined;
    await expect(
      withPostgresHarness(async (harness) => {
        cleanup = harness.cleanup;
        const { first, second, observer } = await harness.connectClients();
        await harness.query(
          observer,
          'CREATE TABLE harness_failure_probe (key integer PRIMARY KEY)',
        );
        await harness.query(first, 'BEGIN');
        await harness.query(first, 'INSERT INTO harness_failure_probe VALUES (1)');
        void harness
          .query(second, 'INSERT INTO harness_failure_probe VALUES (1)')
          .catch(() => undefined);
        throw 0;
      }),
    ).rejects.toBe(0);
    expect(cleanup).toEqual(cleaned);
  }, 180_000);
});

type MockClient = {
  release: ReturnType<typeof vi.fn<(force?: boolean | Error) => void>>;
};

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function client(): MockClient {
  return { release: vi.fn<(force?: boolean | Error) => void>() };
}

async function mockHarness(
  connect: () => Promise<MockClient>,
  poolEnd: () => Promise<void>,
  containerStop: () => Promise<void>,
) {
  const poolOptions: { value?: { connectionTimeoutMillis?: number } } = {};
  vi.resetModules();
  vi.doMock('pg', () => ({
    Pool: class {
      constructor(options: { connectionTimeoutMillis?: number }) {
        poolOptions.value = options;
      }
      connect = connect;
      end = poolEnd;
    },
  }));
  vi.doMock('drizzle-orm/node-postgres', () => ({ drizzle: vi.fn(() => ({})) }));
  vi.doMock('drizzle-orm/node-postgres/migrator', () => ({
    migrate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }));
  vi.doMock('@testcontainers/postgresql', () => ({
    PostgreSqlContainer: class {
      withLabels() {
        return this;
      }
      async start() {
        return {
          getConnectionUri: () => 'postgres://mock',
          getId: () => 'mock-container',
          stop: containerStop,
        };
      }
    },
  }));
  return {
    ...(await import('../../test-support/postgres-harness.js')),
    poolOptions,
  };
}

function resetHarnessMocks() {
  vi.doUnmock('pg');
  vi.doUnmock('drizzle-orm/node-postgres');
  vi.doUnmock('drizzle-orm/node-postgres/migrator');
  vi.doUnmock('@testcontainers/postgresql');
  vi.resetModules();
}

describe('acquisition cleanup', () => {
  it('releases a late client during the release sweep without a third acquisition', async () => {
    const first = client();
    const lateSecond = client();
    const second = defer<MockClient>();
    const secondStarted = defer<void>();
    const connect = vi
      .fn<() => Promise<MockClient>>()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return second.promise;
      })
      .mockRejectedValueOnce(new Error('third acquisition started'));
    const poolEnd = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const containerStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    first.release.mockImplementationOnce(() => second.resolve(lateSecond));

    try {
      const { poolOptions, withPostgresHarness: harness } = await mockHarness(
        connect,
        poolEnd,
        containerStop,
      );
      let acquisition: Promise<unknown> | undefined;
      await expect(
        harness(async ({ connectClients }) => {
          acquisition = connectClients().catch(() => undefined);
          await secondStarted.promise;
          expect(connect).toHaveBeenCalledTimes(2);
          throw 0;
        }),
      ).rejects.toBe(0);
      await acquisition;

      expect(first.release).toHaveBeenCalledWith(true);
      expect(lateSecond.release).toHaveBeenCalledOnce();
      expect(lateSecond.release).toHaveBeenCalledWith(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(poolEnd).toHaveBeenCalledOnce();
      expect(containerStop).toHaveBeenCalledOnce();
      expect(poolOptions.value).toMatchObject({ connectionTimeoutMillis: 5_000 });
    } finally {
      resetHarnessMocks();
    }
  });

  it('releases partial acquisition state before ending the pool and stopping the container', async () => {
    const first = client();
    const failure = new Error('second connect failed');
    const connect = vi
      .fn<() => Promise<MockClient>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(failure);
    const poolEnd = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const containerStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    try {
      const { withPostgresHarness: harness } = await mockHarness(connect, poolEnd, containerStop);
      await expect(harness(async ({ connectClients }) => connectClients())).rejects.toBe(failure);
      expect(first.release).toHaveBeenCalledWith(true);
      expect(poolEnd).toHaveBeenCalledOnce();
      expect(containerStop).toHaveBeenCalledOnce();
    } finally {
      resetHarnessMocks();
    }
  });
});
