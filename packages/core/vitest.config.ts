import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // v8 coverage instrumentation (now run on every PR — PRODOPS-009) slows tests
    // noticeably on the 2-core CI runners, pushing a few borderline diff-parity
    // tests past the 5s default. Give them headroom while still catching genuine
    // hangs. The suite's real per-test cost is a few ms; this only affects the
    // instrumented ceiling.
    testTimeout: 15_000,
    // Preserve vitest's default excludes and also skip Stryker's sandbox
    // directories, which contain stale test files that can break discovery.
    exclude: [...configDefaults.exclude, '**/.stryker-tmp/**'],
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
