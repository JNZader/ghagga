import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const queryTimeoutMs = 5_000;

export interface HarnessCleanup {
  clientsReleased: boolean;
  poolEnded: boolean;
  containerStopped: boolean;
}

export interface PostgresHarness {
  containerId: string;
  cleanup: HarnessCleanup;
  connectClients(): Promise<{ first: PoolClient; second: PoolClient; observer: PoolClient }>;
  query<T extends QueryResultRow>(client: PoolClient, text: string): Promise<QueryResult<T>>;
  waitForBlocked(observer: PoolClient, waitingPid: number, blockerPid: number): Promise<void>;
}

function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), queryTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function withPostgresHarness<T>(callback: (harness: PostgresHarness) => Promise<T>) {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  let result: { value: T } | undefined;
  let closing = false;
  const clients = new Set<PoolClient>();
  const pending = new Set<Promise<unknown>>();
  const cleanup: HarnessCleanup = {
    clientsReleased: false,
    poolEnded: false,
    containerStopped: false,
  };

  const track = <V>(operation: Promise<V>) => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };

  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withLabels({ 'ghagga.test-harness': 'pr-native-readonly' })
      .start();
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 3,
      connectionTimeoutMillis: queryTimeoutMs,
    });
    await bounded(migrate(drizzle(pool), { migrationsFolder }), 'journaled migration timed out');

    const activePool = pool;
    const query = <T extends QueryResultRow>(client: PoolClient, text: string) =>
      track(bounded(client.query<T>(text), `query timed out: ${text.slice(0, 48)}`));
    const harness: PostgresHarness = {
      containerId: container.getId(),
      cleanup,
      connectClients: async () => {
        const connected: PoolClient[] = [];
        for (let index = 0; index < 3; index++) {
          if (closing) throw new Error('harness is closing');
          const client = await track(
            activePool.connect().then((connectedClient) => {
              if (closing) {
                connectedClient.release(true);
                throw new Error('client acquired while harness was closing');
              }
              clients.add(connectedClient);
              return connectedClient;
            }),
          );
          connected.push(client);
        }
        const [first, second, observer] = connected;
        if (!first || !second || !observer)
          throw new Error('harness did not acquire three clients');
        return { first, second, observer };
      },
      query,
      waitForBlocked: async (observer, waitingPid, blockerPid) => {
        const deadline = Date.now() + queryTimeoutMs;
        while (Date.now() < deadline) {
          const result = await query<{ pids: number[] }>(
            observer,
            `SELECT pg_blocking_pids(${waitingPid}) AS pids`,
          );
          if (result.rows[0]?.pids.includes(blockerPid)) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('contender was not observably blocked');
      },
    };
    result = { value: await callback(harness) };
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  }

  closing = true;
  let cleanupFailure: unknown;
  for (const client of clients) {
    try {
      client.release(true);
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  cleanup.clientsReleased = true;
  try {
    await bounded(Promise.allSettled(pending), 'pending queries did not settle');
  } catch (error) {
    cleanupFailure ??= error;
  }
  try {
    await bounded(pool?.end() ?? Promise.resolve(), 'pool cleanup timed out');
    if (pool) cleanup.poolEnded = true;
  } catch (error) {
    cleanupFailure ??= error;
  }
  try {
    await bounded(
      container?.stop().then(() => undefined) ?? Promise.resolve(),
      'container cleanup timed out',
    );
    if (container) cleanup.containerStopped = true;
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!result) throw new Error('harness completed without a result');
  return { ...result, cleanup };
}
