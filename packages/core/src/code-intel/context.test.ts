/**
 * Unit tests for code intelligence context builder.
 *
 * Tests cover:
 * - Formatting with structural data
 * - Empty data returns empty string
 * - Token budget truncation
 * - Multiple files formatting
 */

import { describe, expect, it } from 'vitest';
import { buildCodeIntelContext, DEFAULT_CODE_INTEL_MAX_TOKENS } from './context.js';
import type { CodeIntelResult } from './types.js';

// ─── Test Fixtures ─────────────────────────────────────────────

function makeResult(overrides: Partial<CodeIntelResult> = {}): CodeIntelResult {
  return {
    file: 'src/auth.ts',
    callers: [],
    callees: [],
    imports: [],
    exports: [],
    ...overrides,
  };
}

describe('buildCodeIntelContext', () => {
  // ─── Empty/No Data ───────────────────────────────────────

  it('returns empty string for empty results array', () => {
    expect(buildCodeIntelContext([])).toBe('');
  });

  it('returns empty string when all results have no structural data', () => {
    const results = [makeResult(), makeResult({ file: 'src/b.ts' })];
    expect(buildCodeIntelContext(results)).toBe('');
  });

  // ─── Formatting ──────────────────────────────────────────

  it('formats callers section correctly', () => {
    const results = [
      makeResult({
        callers: [
          { file: 'src/login.ts', symbol: 'handleLogin', line: 42 },
          { file: 'src/api.ts', symbol: 'processRequest' },
        ],
      }),
    ];

    const context = buildCodeIntelContext(results);

    expect(context).toContain('#### `src/auth.ts`');
    expect(context).toContain('**Called by:**');
    expect(context).toContain('`handleLogin` in `src/login.ts:42`');
    expect(context).toContain('`processRequest` in `src/api.ts`');
  });

  it('formats callees section correctly', () => {
    const results = [
      makeResult({
        callees: [{ file: 'src/db.ts', symbol: 'query', line: 10 }],
      }),
    ];

    const context = buildCodeIntelContext(results);

    expect(context).toContain('**Calls into:**');
    expect(context).toContain('`query` in `src/db.ts:10`');
  });

  it('formats imports and exports inline', () => {
    const results = [
      makeResult({
        imports: ['./utils.js', './types.js'],
        exports: ['validateToken', 'AuthConfig'],
      }),
    ];

    const context = buildCodeIntelContext(results);

    expect(context).toContain('**Imports:** `./utils.js`, `./types.js`');
    expect(context).toContain('**Exports:** `validateToken`, `AuthConfig`');
  });

  it('formats multiple files with separation', () => {
    const results = [
      makeResult({
        file: 'src/auth.ts',
        callers: [{ file: 'src/login.ts', symbol: 'login' }],
      }),
      makeResult({
        file: 'src/db.ts',
        exports: ['query', 'connect'],
      }),
    ];

    const context = buildCodeIntelContext(results);

    expect(context).toContain('#### `src/auth.ts`');
    expect(context).toContain('#### `src/db.ts`');
    // Sections separated by double newline
    expect(context).toContain('\n\n');
  });

  it('skips files with no meaningful data in mixed results', () => {
    const results = [
      makeResult({ file: 'src/empty.ts' }), // no data
      makeResult({
        file: 'src/auth.ts',
        callers: [{ file: 'src/login.ts', symbol: 'login' }],
      }),
    ];

    const context = buildCodeIntelContext(results);

    expect(context).not.toContain('src/empty.ts');
    expect(context).toContain('src/auth.ts');
  });

  // ─── Token Budget ────────────────────────────────────────

  it('truncates when exceeding token budget', () => {
    // Create many results that would exceed a tiny budget
    const results = Array.from({ length: 50 }, (_, i) =>
      makeResult({
        file: `src/file-${i}.ts`,
        callers: [{ file: `src/caller-${i}.ts`, symbol: `func${i}`, line: i }],
        exports: [`export${i}A`, `export${i}B`, `export${i}C`],
      }),
    );

    // Very small token budget — should truncate
    const context = buildCodeIntelContext(results, 100);

    expect(context).toContain('truncated to fit token budget');
    // Should have some content but not all 50 files
    expect(context.length).toBeLessThan(50 * 100);
  });

  it('does not truncate when within budget', () => {
    const results = [
      makeResult({
        callers: [{ file: 'src/a.ts', symbol: 'a' }],
      }),
    ];

    const context = buildCodeIntelContext(results, DEFAULT_CODE_INTEL_MAX_TOKENS);

    expect(context).not.toContain('truncated');
  });

  // ─── Edge Cases ──────────────────────────────────────────

  it('handles symbol reference without line number', () => {
    const results = [
      makeResult({
        callers: [{ file: 'src/a.ts', symbol: 'doStuff' }],
      }),
    ];

    const context = buildCodeIntelContext(results);

    // No colon+line when line is undefined
    expect(context).toContain('`doStuff` in `src/a.ts`');
    expect(context).not.toContain('src/a.ts:');
  });
});
