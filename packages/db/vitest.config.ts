import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // Integration tests (*.integration.test.ts) spin up a real PostgreSQL
    // container via testcontainers and require Docker. They are NOT part of the
    // default unit run (which also feeds `turbo run test`, where Docker is
    // absent). Run them explicitly with `pnpm --filter ghagga-db test:integration`.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/index.ts', 'src/migrate.ts'],
      // Gradual coverage gate (PRODOPS-009). Deliberately conservative floors so
      // this doesn't retroactively block on pre-existing debt — the point is to
      // catch *regressions*, not to force an immediate rewrite. Ratchet these up
      // over time as real coverage grows; never lower them without a note here
      // explaining why.
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 50,
        lines: 50,
      },
    },
  },
});
