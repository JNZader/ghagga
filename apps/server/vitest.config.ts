import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30000,
    // Preserve vitest's default excludes and also skip Stryker's sandbox
    // directories, which contain stale test files that can break discovery.
    exclude: [...configDefaults.exclude, '**/.stryker-tmp/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/index.ts'],
    },
  },
});
