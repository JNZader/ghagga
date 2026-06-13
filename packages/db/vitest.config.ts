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
    },
  },
});
