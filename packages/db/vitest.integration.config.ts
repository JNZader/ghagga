import { defineConfig } from 'vitest/config';

/**
 * Vitest config for DB integration tests.
 *
 * These tests spin up a real PostgreSQL container via testcontainers and
 * therefore require Docker. They are deliberately kept OUT of the default unit
 * run (see vitest.config.ts, which excludes `*.integration.test.ts`) so that
 * `turbo run test` — executed in environments without Docker, including CI —
 * never attempts to start a container.
 *
 * Run with: `pnpm --filter ghagga-db test:integration`
 *
 * Timeouts are generous because pulling/booting the postgres image can take
 * tens of seconds on a cold cache. They apply ONLY to this integration run and
 * do not slow down the unit suite.
 */
export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.integration.test.ts'],
    // Container pull + boot can take a while on a cold image cache.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
