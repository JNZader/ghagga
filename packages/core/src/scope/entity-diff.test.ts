/**
 * Unit tests for entity-level semantic diff classification.
 *
 * All tests use synthetic data — no tree-sitter or WASM required.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyEntityChanges,
  detectRenames,
  extractEntityDiffLines,
  filterLogicChanges,
} from './entity-diff.js';
import type { AffectedSymbol, SymbolInfo } from './types.js';
import { ENTITY_CHANGE_KIND } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────

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

const makeAffected = (symbol: SymbolInfo): AffectedSymbol => ({
  symbol,
  overlappingHunks: [],
});

// ─── extractEntityDiffLines ───────────────────────────────────

describe('extractEntityDiffLines', () => {
  it('extracts addition lines within symbol range', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -5,3 +5,5 @@ imports',
      ' unchanged line 5',
      '+added at line 6',
      '+added at line 7',
      ' unchanged line 8',
      ' unchanged line 9',
    ].join('\n');

    const symbol = makeSymbol('foo', 5, 10);
    const lines = extractEntityDiffLines(diff, symbol);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('+added at line 6');
    expect(lines[1]).toBe('+added at line 7');
  });

  it('extracts deletion lines within symbol range', () => {
    const diff = [
      '@@ -10,4 +10,2 @@ function bar()',
      ' unchanged',
      '-removed at line 11',
      '-removed at line 12',
      ' unchanged',
    ].join('\n');

    const symbol = makeSymbol('bar', 10, 15);
    const lines = extractEntityDiffLines(diff, symbol);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('-removed at line 11');
    expect(lines[1]).toBe('-removed at line 12');
  });

  it('excludes lines outside symbol range', () => {
    const diff = [
      '@@ -1,3 +1,4 @@ top of file',
      ' line 1',
      '+added at line 2',
      ' line 3',
      ' line 4',
    ].join('\n');

    const symbol = makeSymbol('distant', 20, 30);
    const lines = extractEntityDiffLines(diff, symbol);

    expect(lines).toHaveLength(0);
  });

  it('returns empty for diff with no hunks', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts';
    const symbol = makeSymbol('foo', 1, 10);

    expect(extractEntityDiffLines(diff, symbol)).toEqual([]);
  });

  it('handles multiple hunks', () => {
    const diff = [
      '@@ -5,2 +5,3 @@ first hunk',
      ' line 5',
      '+added at line 6',
      '@@ -20,2 +21,3 @@ second hunk',
      ' line 21',
      '+added at line 22',
    ].join('\n');

    // Symbol spans both hunks
    const symbol = makeSymbol('wide', 5, 25);
    const lines = extractEntityDiffLines(diff, symbol);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('+added at line 6');
    expect(lines[1]).toBe('+added at line 22');
  });
});

// ─── classifyEntityChanges ────────────────────────────────────

describe('classifyEntityChanges', () => {
  it('classifies whitespace-only changes as cosmetic', () => {
    const _diff = [
      '@@ -10,3 +10,3 @@ function foo()',
      '-  const x = 1;',
      '+    const x = 1;',
      ' return x;',
    ].join('\n');

    // The diff lines are indentation changes only
    const whitespaceOnlyDiff = ['@@ -10,2 +10,2 @@ function foo()', '-', '+   '].join('\n');

    const symbol = makeSymbol('foo', 10, 15);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, whitespaceOnlyDiff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.COSMETIC);
  });

  it('classifies comment-only changes as cosmetic', () => {
    const diff = [
      '@@ -10,2 +10,3 @@ function foo()',
      ' const x = 1;',
      '+// This is a new comment',
      ' return x;',
    ].join('\n');

    const symbol = makeSymbol('foo', 10, 15);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.COSMETIC);
  });

  it('classifies python comment changes as cosmetic', () => {
    const diff = [
      '@@ -10,2 +10,3 @@ def foo():',
      ' x = 1',
      '+# This is a python comment',
      ' return x',
    ].join('\n');

    const symbol = makeSymbol('foo', 10, 15);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.COSMETIC);
  });

  it('classifies logic changes as logic', () => {
    const diff = [
      '@@ -10,3 +10,3 @@ function foo()',
      ' const x = 1;',
      '-return x;',
      '+return x + 1;',
    ].join('\n');

    const symbol = makeSymbol('foo', 10, 15);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.LOGIC);
  });

  it('classifies mixed cosmetic+logic as logic', () => {
    const diff = [
      '@@ -10,4 +10,5 @@ function foo()',
      ' const x = 1;',
      '+// added comment',
      '-return x;',
      '+return x + 1;',
      ' }',
    ].join('\n');

    const symbol = makeSymbol('foo', 10, 16);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.LOGIC);
  });

  it('defaults to logic when no diff lines found in range', () => {
    const diff = ['@@ -1,2 +1,3 @@ imports', ' import a;', '+import b;', ' import c;'].join('\n');

    // Symbol is far from the change
    const symbol = makeSymbol('distant', 50, 60);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.LOGIC);
  });

  it('classifies multiple symbols independently', () => {
    const diff = [
      '@@ -5,2 +5,3 @@ first',
      ' line 5',
      '+// just a comment at line 6',
      '@@ -20,2 +21,2 @@ second',
      ' line 21',
      '-old logic',
      '+new logic',
    ].join('\n');

    const cosmSymbol = makeSymbol('cosm', 5, 10);
    const logicSymbol = makeSymbol('logic', 20, 25);
    const affected = [makeAffected(cosmSymbol), makeAffected(logicSymbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe(ENTITY_CHANGE_KIND.COSMETIC);
    expect(result[1]?.kind).toBe(ENTITY_CHANGE_KIND.LOGIC);
  });

  it('includes diff lines in the result', () => {
    const diff = [
      '@@ -10,2 +10,3 @@ function foo()',
      ' const x = 1;',
      '+const y = 2;',
      ' return x;',
    ].join('\n');

    const symbol = makeSymbol('foo', 10, 15);
    const affected = [makeAffected(symbol)];
    const result = classifyEntityChanges(affected, diff);

    expect(result[0]?.diffLines).toHaveLength(1);
    expect(result[0]?.diffLines[0]).toBe('+const y = 2;');
  });
});

// ─── detectRenames ────────────────────────────────────────────

describe('detectRenames', () => {
  it('detects a function rename with identical body', () => {
    const oldSource = ['function foo() {', '  const x = 1;', '  return x + 2;', '}'].join('\n');

    const newSource = ['function bar() {', '  const x = 1;', '  return x + 2;', '}'].join('\n');

    const removed = [makeSymbol('foo', 1, 4)];
    const added = [makeSymbol('bar', 1, 4)];

    const renames = detectRenames(removed, added, oldSource, newSource);

    expect(renames).toHaveLength(1);
    expect(renames[0]?.oldName).toBe('foo');
    expect(renames[0]?.newName).toBe('bar');
    expect(renames[0]?.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('does not match rename when body is different', () => {
    const oldSource = ['function foo() {', '  return 1;', '}'].join('\n');

    const newSource = [
      'function bar() {',
      '  return completelyDifferentLogic();',
      '  const a = somethingElse();',
      '  return a.map(x => x * 2);',
      '}',
    ].join('\n');

    const removed = [makeSymbol('foo', 1, 3)];
    const added = [makeSymbol('bar', 1, 5)];

    const renames = detectRenames(removed, added, oldSource, newSource);

    expect(renames).toHaveLength(0);
  });

  it('does not match rename across different symbol kinds', () => {
    const oldSource = 'function foo() {\n  return 1;\n}';
    const newSource = 'class foo {\n  return 1;\n}';

    const removed = [makeSymbol('foo', 1, 3, 'function')];
    const added = [makeSymbol('foo', 1, 3, 'class')];

    const renames = detectRenames(removed, added, oldSource, newSource);

    expect(renames).toHaveLength(0);
  });

  it('respects custom similarity threshold', () => {
    const oldSource = 'function foo() {\n  return 1;\n}';
    const newSource = 'function bar() {\n  return 1;\n}';

    const removed = [makeSymbol('foo', 1, 3)];
    const added = [makeSymbol('bar', 1, 3)];

    // Default threshold (0.9) should match since bodies are nearly identical
    const renamesDefault = detectRenames(removed, added, oldSource, newSource);
    expect(renamesDefault).toHaveLength(1);

    // Very low threshold should also match
    const renamesLow = detectRenames(removed, added, oldSource, newSource, {
      similarityThreshold: 0.1,
    });
    expect(renamesLow).toHaveLength(1);
  });

  it('returns empty when no removed symbols', () => {
    const renames = detectRenames([], [makeSymbol('bar', 1, 3)], '', 'code');
    expect(renames).toEqual([]);
  });

  it('returns empty when no added symbols', () => {
    const renames = detectRenames([makeSymbol('foo', 1, 3)], [], 'code', '');
    expect(renames).toEqual([]);
  });

  it('matches at most one added symbol per removed symbol', () => {
    const body = '  const x = 1;\n  return x + 2;';
    const oldSource = `function foo() {\n${body}\n}`;
    const newSource = `function bar() {\n${body}\n}\nfunction baz() {\n${body}\n}`;

    const removed = [makeSymbol('foo', 1, 4)];
    const added = [makeSymbol('bar', 1, 4), makeSymbol('baz', 5, 8)];

    const renames = detectRenames(removed, added, oldSource, newSource);

    // Should match exactly one
    expect(renames).toHaveLength(1);
  });
});

// ─── filterLogicChanges ───────────────────────────────────────

describe('filterLogicChanges', () => {
  it('returns only logic changes', () => {
    const changes = [
      { symbol: makeSymbol('a', 1, 5), kind: ENTITY_CHANGE_KIND.COSMETIC as const, diffLines: [] },
      {
        symbol: makeSymbol('b', 10, 20),
        kind: ENTITY_CHANGE_KIND.LOGIC as const,
        diffLines: ['+new code'],
      },
      { symbol: makeSymbol('c', 25, 30), kind: ENTITY_CHANGE_KIND.RENAMED as const, diffLines: [] },
    ];

    const result = filterLogicChanges(changes);

    expect(result).toHaveLength(1);
    expect(result[0]?.symbol.name).toBe('b');
  });

  it('returns empty array when no logic changes', () => {
    const changes = [
      { symbol: makeSymbol('a', 1, 5), kind: ENTITY_CHANGE_KIND.COSMETIC as const, diffLines: [] },
    ];

    expect(filterLogicChanges(changes)).toHaveLength(0);
  });

  it('returns all when all are logic changes', () => {
    const changes = [
      { symbol: makeSymbol('a', 1, 5), kind: ENTITY_CHANGE_KIND.LOGIC as const, diffLines: ['+x'] },
      {
        symbol: makeSymbol('b', 10, 20),
        kind: ENTITY_CHANGE_KIND.LOGIC as const,
        diffLines: ['+y'],
      },
    ];

    expect(filterLogicChanges(changes)).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(filterLogicChanges([])).toEqual([]);
  });
});
