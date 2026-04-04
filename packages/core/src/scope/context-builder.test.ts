/**
 * Unit tests for the scoped context builder.
 *
 * All tests use synthetic data — no tree-sitter or WASM required.
 */

import { describe, expect, it } from 'vitest';
import { buildScopedContext } from './context-builder.js';
import type { AffectedSymbol, DiffHunk, ScopedFile, SymbolInfo } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────

const makeSymbol = (
  name: string,
  kind: SymbolInfo['kind'],
  startLine: number,
  endLine: number,
  parent?: string,
): SymbolInfo => ({
  name,
  kind,
  startLine,
  endLine,
  startByte: 0,
  endByte: 0,
  ...(parent ? { parent } : {}),
});

const makeHunk = (newStart: number, newCount: number): DiffHunk => ({
  oldStart: 1,
  oldCount: 1,
  newStart,
  newCount,
});

const makeAffected = (
  symbol: SymbolInfo,
  hunks: DiffHunk[] = [makeHunk(symbol.startLine, 1)],
): AffectedSymbol => ({
  symbol,
  overlappingHunks: hunks,
});

const makeFile = (
  filePath: string,
  symbols: AffectedSymbol[],
  lineCount: number = 50,
): ScopedFile => ({
  filePath,
  symbols,
  sourceLines: Array.from({ length: lineCount }, (_, i) => `line ${i + 1} content`),
});

// ─── buildScopedContext ───────────────────────────────────────

describe('buildScopedContext', () => {
  it('returns empty string for empty input', () => {
    expect(buildScopedContext([])).toBe('');
  });

  it('returns empty string when files have no affected symbols', () => {
    const file: ScopedFile = {
      filePath: 'src/foo.ts',
      symbols: [],
      sourceLines: ['line 1'],
    };
    expect(buildScopedContext([file])).toBe('');
  });

  it('builds context for a single file with one function', () => {
    const symbol = makeSymbol('foo', 'function', 3, 5);
    const file = makeFile('src/utils.ts', [makeAffected(symbol)], 10);

    const result = buildScopedContext([file]);

    expect(result).toContain('## src/utils.ts');
    expect(result).toContain('### function foo (lines 3-5)');
    expect(result).toContain('```ts');
    expect(result).toContain('line 3 content');
    expect(result).toContain('line 4 content');
    expect(result).toContain('line 5 content');
    expect(result).not.toContain('line 2 content');
    expect(result).not.toContain('line 6 content');
  });

  it('builds context for a method with parent class', () => {
    const symbol = makeSymbol('getData', 'method', 10, 15, 'MyService');
    const file = makeFile('src/service.ts', [makeAffected(symbol)], 20);

    const result = buildScopedContext([file]);

    expect(result).toContain('### method MyService.getData (lines 10-15)');
  });

  it('builds context for multiple symbols in one file', () => {
    const sym1 = makeSymbol('alpha', 'function', 1, 3);
    const sym2 = makeSymbol('beta', 'function', 8, 12);
    const file = makeFile('src/helpers.ts', [makeAffected(sym1), makeAffected(sym2)], 15);

    const result = buildScopedContext([file]);

    expect(result).toContain('### function alpha (lines 1-3)');
    expect(result).toContain('### function beta (lines 8-12)');
    // Both should be under the same file header
    const headerCount = (result.match(/## src\/helpers\.ts/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('builds context for multiple files', () => {
    const sym1 = makeSymbol('foo', 'function', 1, 3);
    const sym2 = makeSymbol('bar', 'class', 1, 5);

    const file1 = makeFile('src/a.ts', [makeAffected(sym1)], 10);
    const file2 = makeFile('src/b.py', [makeAffected(sym2)], 10);

    const result = buildScopedContext([file1, file2]);

    expect(result).toContain('## src/a.ts');
    expect(result).toContain('## src/b.py');
    // Files separated by ---
    expect(result).toContain('---');
  });

  it('infers correct code fence language for Python files', () => {
    const symbol = makeSymbol('main', 'function', 1, 3);
    const file = makeFile('app/main.py', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).toContain('```python');
  });

  it('infers correct code fence language for Go files', () => {
    const symbol = makeSymbol('Handler', 'function', 1, 3);
    const file = makeFile('cmd/server.go', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).toContain('```go');
  });

  it('infers correct code fence language for JavaScript files', () => {
    const symbol = makeSymbol('render', 'function', 1, 3);
    const file = makeFile('src/app.jsx', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).toContain('```jsx');
  });

  it('deduplicates symbols with same name and start line', () => {
    const symbol = makeSymbol('foo', 'function', 5, 10);
    // Same symbol appearing in two different hunk mappings
    const affected1 = makeAffected(symbol, [makeHunk(5, 2)]);
    const affected2 = makeAffected(symbol, [makeHunk(8, 1)]);
    const file = makeFile('src/dup.ts', [affected1, affected2], 15);

    const result = buildScopedContext([file]);

    const matches = result.match(/### function foo/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('skips files where all symbols have no content', () => {
    // File with 0 source lines
    const symbol = makeSymbol('ghost', 'function', 1, 3);
    const file: ScopedFile = {
      filePath: 'src/empty.ts',
      symbols: [makeAffected(symbol)],
      sourceLines: [],
    };

    const result = buildScopedContext([file]);

    // Should still produce output (empty code block) since symbol exists
    // The slice will be empty but the section is still generated
    expect(result).toContain('### function ghost');
  });

  it('handles symbol at the very end of a file', () => {
    const symbol = makeSymbol('last', 'function', 8, 10);
    const file = makeFile('src/end.ts', [makeAffected(symbol)], 10);

    const result = buildScopedContext([file]);

    expect(result).toContain('line 8 content');
    expect(result).toContain('line 9 content');
    expect(result).toContain('line 10 content');
  });

  it('handles symbol spanning entire file', () => {
    const symbol = makeSymbol('everything', 'class', 1, 5);
    const file = makeFile('src/all.ts', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).toContain('line 1 content');
    expect(result).toContain('line 5 content');
  });

  it('handles interface symbol kind', () => {
    const symbol = makeSymbol('Config', 'interface', 1, 5);
    const file = makeFile('src/types.ts', [makeAffected(symbol)], 10);

    const result = buildScopedContext([file]);

    expect(result).toContain('### interface Config (lines 1-5)');
  });

  it('produces no separator when only one file', () => {
    const symbol = makeSymbol('solo', 'function', 1, 3);
    const file = makeFile('src/solo.ts', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).not.toContain('---');
  });

  it('handles unknown file extension gracefully', () => {
    const symbol = makeSymbol('main', 'function', 1, 3);
    const file = makeFile('src/script.zsh', [makeAffected(symbol)], 5);

    const result = buildScopedContext([file]);

    expect(result).toContain('```zsh');
  });
});
