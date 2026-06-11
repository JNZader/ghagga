/**
 * GOLDEN FREEZE — recursive loop, 2 iterations (spec R7 / corpus C16).
 *
 * Freezes the EXACT coordinates that applyVirtualPatches produces across two
 * iterations of the recursive review loop (recursive/index.ts:91-156), where
 * iteration 2 re-parses the synthetic diff produced by iteration 1.
 *
 * ⚠️ The off-by-N in iteration 2 is INTENTIONALLY FROZEN AS-IS: the injected
 * `+[SUGGESTED FIX]` lines from iteration 1 shift the lineCounter, so round-2
 * patches land one line late per preceding injection in the same hunk. This is
 * the documented pre-existing behavior (separate ticket — do NOT fix here).
 * If a migration "improves" these coordinates, that is a FORBIDDEN behavior
 * change: revert the migration, not this golden.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVirtualPatches } from '../../recursive/patch-extractor.js';
import type { SuggestionPatch } from '../../recursive/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const c01 = readFileSync(join(FIXTURES, 'c01.diff'), 'utf8');
const c16 = readFileSync(join(FIXTURES, 'c16.diff'), 'utf8');
const { round1, round2 } = JSON.parse(readFileSync(join(FIXTURES, 'c16-patches.json'), 'utf8')) as {
  round1: SuggestionPatch[];
  round2: SuggestionPatch[];
};

/** 0-based indices and context of every injected `+[SUGGESTED FIX]` line. */
function markerCoordinates(diff: string): Array<{ index: number; marker: string; after: string }> {
  const lines = diff.split('\n');
  const coords: Array<{ index: number; marker: string; after: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line?.startsWith('+[SUGGESTED FIX]')) {
      coords.push({ index: i, marker: line, after: lines[i - 1] ?? '' });
    }
  }
  return coords;
}

describe('recursive golden freeze — 2 iterations over C16', () => {
  const iter1 = applyVirtualPatches(c01, round1);
  const iter2 = applyVirtualPatches(c16, round2);

  it('iteration 1 output equals the committed c16 fixture', () => {
    expect(iter1).toBe(c16);
  });

  it('iteration 1 marker coordinates (frozen)', () => {
    const coords = markerCoordinates(iter1);
    // The file-level patch (no line) is silently dropped — only 3 of 4 emit.
    expect(coords).toHaveLength(3);
    expect(coords).toMatchSnapshot();
  });

  it('iteration 2 marker coordinates (frozen, off-by-N INCLUDED)', () => {
    const coords = markerCoordinates(iter2);
    // round-1 markers survive in the input plus the 2 new round-2 markers
    expect(coords).toHaveLength(5);
    expect(coords).toMatchSnapshot();
  });

  it('iteration 2 full output (frozen)', () => {
    expect(iter2).toMatchSnapshot();
  });

  it('2-iteration run is deterministic', () => {
    const again = applyVirtualPatches(applyVirtualPatches(c01, round1), round2);
    expect(again).toBe(iter2);
  });
});
