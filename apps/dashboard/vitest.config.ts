import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.spec.ts',
        'src/test/**',
        'src/main.tsx',
      ],
      // Gradual coverage gate (PRODOPS-009). Deliberately conservative floors so
      // this doesn't retroactively block on pre-existing debt — the point is to
      // catch *regressions*, not to force an immediate rewrite. Dashboard starts
      // lower than the backend packages (UI/component coverage is typically
      // thinner); ratchet up over time, never lower without a note here.
      thresholds: {
        statements: 35,
        branches: 30,
        functions: 35,
        lines: 35,
      },
    },
  },
});
