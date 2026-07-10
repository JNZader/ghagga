import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/index.ts'],
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
