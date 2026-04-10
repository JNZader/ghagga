/**
 * Unit tests for diff-mapper: hunk parsing and diff-to-symbol mapping.
 *
 * All tests use synthetic data — no tree-sitter or WASM required.
 */

import { describe, expect, it } from 'vitest';
import { mapDiffToSymbols, parseHunks } from './diff-mapper.js';
import type { DiffHunk, SymbolInfo } from './types.js';

// ─── parseHunks ────────────────────────────────────────────────

describe('parseHunks', () => {
  it('parses a standard hunk header with counts', () => {
    const diff = '@@ -10,5 +10,7 @@ function foo()';
    const hunks = parseHunks(diff);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      oldStart: 10,
      oldCount: 5,
      newStart: 10,
      newCount: 7,
    });
  });

  it('parses a hunk header without counts (single line change)', () => {
    const diff = '@@ -1 +1 @@';
    const hunks = parseHunks(diff);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
    });
  });

  it('parses a hunk for new file (0,0 old side)', () => {
    const diff = '@@ -0,0 +1,20 @@';
    const hunks = parseHunks(diff);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 20,
    });
  });

  it('parses multiple hunks from a single file diff', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -5,3 +5,4 @@ imports',
      ' unchanged',
      '+added line',
      ' unchanged',
      '@@ -20,2 +21,5 @@ function bar()',
      ' unchanged',
      '+new code',
      '+more code',
      '+even more',
    ].join('\n');

    const hunks = parseHunks(diff);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({ oldStart: 5, oldCount: 3, newStart: 5, newCount: 4 });
    expect(hunks[1]).toEqual({ oldStart: 20, oldCount: 2, newStart: 21, newCount: 5 });
  });

  it('returns empty array for diff with no hunks', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts';
    expect(parseHunks(diff)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseHunks('')).toEqual([]);
  });

  it('handles hunk with only new count specified', () => {
    const diff = '@@ -5 +5,3 @@';
    const hunks = parseHunks(diff);

    expect(hunks[0]).toEqual({
      oldStart: 5,
      oldCount: 1,
      newStart: 5,
      newCount: 3,
    });
  });
});

// ─── mapDiffToSymbols ──────────────────────────────────────────

describe('mapDiffToSymbols', () => {
  const makeSymbol = (
    name: string,
    startLine: number,
    endLine: number,
    kind: SymbolInfo['kind'] = 'function',
  ): SymbolInfo => ({
    name,
    kind,
    startLine,
    endLine,
    startByte: 0,
    endByte: 0,
  });

  const makeHunk = (newStart: number, newCount: number): DiffHunk => ({
    oldStart: 1,
    oldCount: 1,
    newStart,
    newCount,
  });

  it('maps a hunk overlapping a single function', () => {
    const symbols = [makeSymbol('foo', 8, 20)];
    const hunks = [makeHunk(10, 5)]; // lines 10-14

    const result = mapDiffToSymbols(hunks, symbols);

    expect(result).toHaveLength(1);
    expect(result[0]?.symbol.name).toBe('foo');
    expect(result[0]?.overlappingHunks).toHaveLength(1);
  });

  it('returns empty when hunk does not overlap any symbol', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    const hunks = [makeHunk(1, 3)]; // lines 1-3, symbol at 10-20

    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(0);
  });

  it('maps a hunk overlapping multiple symbols', () => {
    const symbols = [
      makeSymbol('foo', 5, 15),
      makeSymbol('bar', 12, 25),
      makeSymbol('baz', 30, 40),
    ];
    const hunks = [makeHunk(10, 10)]; // lines 10-19

    const result = mapDiffToSymbols(hunks, symbols);

    expect(result).toHaveLength(2);
    expect(result.map((a) => a.symbol.name)).toEqual(['foo', 'bar']);
  });

  it('maps multiple hunks to the same symbol', () => {
    const symbols = [makeSymbol('foo', 5, 30)];
    const hunks = [makeHunk(8, 2), makeHunk(20, 3)];

    const result = mapDiffToSymbols(hunks, symbols);

    expect(result).toHaveLength(1);
    expect(result[0]?.overlappingHunks).toHaveLength(2);
  });

  it('handles exact boundary overlap (hunk end == symbol start)', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    const hunks = [makeHunk(10, 1)]; // exactly line 10

    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(1);
  });

  it('handles hunk ending exactly at symbol start line', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    const hunks = [makeHunk(8, 3)]; // lines 8-10, overlaps at line 10

    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(1);
  });

  it('handles hunk starting exactly at symbol end line', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    const hunks = [makeHunk(20, 3)]; // lines 20-22, overlaps at line 20

    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(1);
  });

  it('no overlap when hunk is one line after symbol', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    const hunks = [makeHunk(21, 3)]; // lines 21-23

    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(0);
  });

  it('returns empty for empty hunks array', () => {
    const symbols = [makeSymbol('foo', 10, 20)];
    expect(mapDiffToSymbols([], symbols)).toEqual([]);
  });

  it('returns empty for empty symbols array', () => {
    const hunks = [makeHunk(10, 5)];
    expect(mapDiffToSymbols(hunks, [])).toEqual([]);
  });

  it('handles zero-count hunk (deletion marker)', () => {
    const symbols = [makeSymbol('foo', 5, 10)];
    const hunks = [makeHunk(7, 0)]; // newStart=7, newCount=0 → range is [7, 6] → no overlap logic

    // With newCount=0, the range becomes [7, 6] which is empty
    // rangesOverlap(7, 6, 5, 10) → 7 <= 10 AND 5 <= 6 → true
    const result = mapDiffToSymbols(hunks, symbols);
    expect(result).toHaveLength(1);
  });

  it('includes class when change is inside a method', () => {
    const symbols = [
      makeSymbol('MyClass', 1, 50, 'class'),
      makeSymbol('myMethod', 10, 20, 'method'),
    ];
    const hunks = [makeHunk(12, 3)]; // lines 12-14, inside method AND class

    const result = mapDiffToSymbols(hunks, symbols);

    // Both the class and the method overlap
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.symbol.name)).toEqual(['MyClass', 'myMethod']);
  });
});
