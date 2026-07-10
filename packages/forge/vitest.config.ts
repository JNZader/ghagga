import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    // vitest v4's default exclude no longer covers dist/, so stale compiled
    // dist/**/*.test.js get collected and can fail locally. Exclude it explicitly.
    exclude: [...configDefaults.exclude, '**/.stryker-tmp/**', '**/dist/**'],
    // Type-level testing gate (P0 fix F1). Without this, the `@ts-expect-error`
    // directives in capability.test.ts — which prove the graph co-presence union
    // rejects an adapter with exactly one graph method — were enforced by NO
    // gate: tsconfig.json EXCLUDES test files from `tsc --noEmit`, and runtime
    // vitest does not typecheck. Enabling `typecheck` makes `vitest run` execute
    // tsc over the test files via tsconfig.test.json (which INCLUDES them), so an
    // unused `@ts-expect-error` (i.e. the union silently weakened back to a form
    // that accepts one-method adapters) fails the test run with TS2578.
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
      // The default typecheck glob only matches `*.test-d.ts`. Our type-level
      // assertions live in regular `*.test.ts` files, so widen the include.
      include: ['src/**/*.test.ts'],
    },
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
