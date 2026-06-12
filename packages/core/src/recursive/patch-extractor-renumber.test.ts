/**
 * RENUMBER + OUT-OF-BAND TRACKING unit guards (Design B —
 * recursive-coordinate-contract, phases 3-4).
 *
 * These pin the precise header arithmetic and the collision-immune marker
 * tracking that the integration contract test (coordinate-contract.test.ts)
 * exercises end-to-end:
 *
 *   - newCount += (markers in THIS hunk); oldStart/oldCount UNTOUCHED.
 *   - a LATER hunk's newStart shifts by the markers injected ABOVE it, even
 *     when it receives ZERO markers itself (the crux of the off-by-N).
 *   - the verbatim `@@ ... @@ <section heading>` suffix is preserved.
 *   - injectedLineIndices are recorded positionally at the injection site, so a
 *     genuine `+` source line that literally begins `[SUGGESTED FIX]` is NOT
 *     mistaken for an injected marker.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVirtualPatches } from './patch-extractor.js';
import type { SuggestionPatch } from './types.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'diff',
  '__tests__',
  'fixtures',
);
const c01 = readFileSync(join(FIXTURES, 'c01.diff'), 'utf8');
const { round1 } = JSON.parse(readFileSync(join(FIXTURES, 'c16-patches.json'), 'utf8')) as {
  round1: SuggestionPatch[];
};

describe('renumber arithmetic — c01 (2 files x 2 hunks)', () => {
  // round1 lands one marker in alpha hunk 1 (alpha:5), one in beta hunk 2
  // (beta:30), one in gamma hunk 1 (gamma:6), plus a line-less alpha patch
  // that is silently dropped.
  const { diff } = applyVirtualPatches(c01, round1);

  it('alpha hunk 1 (receives 1 marker): newCount += 1, oldCount untouched, suffix preserved', () => {
    // legacy: `@@ -2,7 +2,7 @@ export const alpha1 = 1;`
    expect(diff).toContain('@@ -2,7 +2,8 @@ export const alpha1 = 1;');
  });

  it('alpha hunk 2 (ZERO markers): newStart shifts +1 from the marker above', () => {
    // legacy: `@@ -27,7 +27,7 @@ ...` → newStart 27 -> 28 (one marker in hunk 1
    // above), newCount unchanged (7), oldStart/oldCount untouched.
    expect(diff).toContain('@@ -27,7 +28,7 @@ export const alpha26 = 26;');
  });

  it('beta hunk 1 (ZERO markers): unchanged header', () => {
    expect(diff).toContain('@@ -2,7 +2,7 @@ export const beta1 = 1;');
  });

  it('beta hunk 2 (receives 1 marker at beta:30): newCount += 1', () => {
    // No marker above in beta, so newStart stays 27; newCount 7 -> 8.
    expect(diff).toContain('@@ -27,7 +27,8 @@ export const beta26 = 26;');
  });

  it('gamma hunk 1 (1 marker at gamma:6): newCount += 1; hunk 2 newStart shifts +1', () => {
    expect(diff).toContain('@@ -2,7 +2,8 @@ export const gamma1 = 1;');
    expect(diff).toContain('@@ -27,7 +28,7 @@ export const gamma26 = 26;');
  });

  it('old-side accounting is never touched (no -2,8 / -27,8 anywhere)', () => {
    expect(diff).not.toContain('@@ -2,8');
    expect(diff).not.toContain('@@ -27,8');
  });
});

describe('coordinate frame — markers in TWO consecutive hunks of one file', () => {
  // Regression guard (3vr CRITICAL, 2026-06-12): the matching counter must stay
  // in the UNSHIFTED (patch) coordinate frame even after an earlier hunk shifted
  // the EMITTED header. Resetting the counter to the shifted start would move
  // every later-hunk match by `injectedBefore` lines → wrong landing +
  // duplicate/missed injections. c01 never triggers this (no file has markers in
  // two consecutive hunks), so it needs its own fixture.
  const twoHunk = `diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@ h1
 a1
-a2
+a2new
 a3
@@ -10,3 +10,3 @@ h2
 b10
-b11
+b11new
 b12`;
  // new-side coords: a2new = 2 (hunk1), b11new = 11 (hunk2).
  const patches: SuggestionPatch[] = [
    { file: 'x.ts', line: 2, originalMessage: 'h1', suggestion: 'FIX-h1', findingIndex: 0 },
    { file: 'x.ts', line: 11, originalMessage: 'h2', suggestion: 'FIX-h2', findingIndex: 1 },
  ];
  const { diff, injectedLineIndices } = applyVirtualPatches(twoHunk, patches);
  const lines = diff.split('\n');

  it('exactly 2 markers injected (no duplicate from a mis-anchored counter)', () => {
    expect(injectedLineIndices).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('+[SUGGESTED FIX]'))).toHaveLength(2);
  });

  it('hunk1 marker lands after +a2new; hunk2 marker lands after +b11new', () => {
    const h1 = lines.findIndex((l) => l === '+[SUGGESTED FIX] FIX-h1');
    const h2 = lines.findIndex((l) => l === '+[SUGGESTED FIX] FIX-h2');
    expect(lines[h1 - 1]).toBe('+a2new');
    expect(lines[h2 - 1]).toBe('+b11new');
  });

  it('headers: hunk1 newCount+1; hunk2 newStart+1 AND newCount+1', () => {
    expect(diff).toContain('@@ -1,3 +1,4 @@ h1');
    expect(diff).toContain('@@ -10,3 +11,4 @@ h2');
  });
});

describe('out-of-band injected-line tracking', () => {
  it('injectedLineIndices match the actual marker positions, hand-counted', () => {
    const { diff, injectedLineIndices } = applyVirtualPatches(c01, round1);
    const lines = diff.split('\n');
    // Every recorded index IS a marker line.
    for (const idx of injectedLineIndices) {
      expect(lines[idx]?.startsWith('+[SUGGESTED FIX]')).toBe(true);
    }
    // And every marker line is recorded (no marker missed).
    const actualMarkerIdx = lines
      .map((l, i) => (l.startsWith('+[SUGGESTED FIX]') ? i : -1))
      .filter((i) => i >= 0);
    expect([...injectedLineIndices].sort((a, b) => a - b)).toEqual(actualMarkerIdx);
    // 3 of 4 round1 patches emit (the line-less alpha patch is dropped).
    expect(injectedLineIndices).toHaveLength(3);
  });

  it('collision: a genuine `+` line beginning [SUGGESTED FIX] is NOT flagged as injected', () => {
    // A diff whose real added content literally starts with the marker text.
    const collisionDiff = `diff --git a/src/c.ts b/src/c.ts
index 1111111..2222222 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,3 @@ header
 ctx1
+[SUGGESTED FIX] this is REAL source content, not an injected marker
 ctx2`;
    // Patch line 3 = the genuine `[SUGGESTED FIX]` content line → we inject a
    // marker AFTER it. Only the INJECTED one must be tracked, not the source.
    const patches: SuggestionPatch[] = [
      {
        file: 'src/c.ts',
        line: 2,
        originalMessage: 'before the colliding line',
        suggestion: 'injected here',
        findingIndex: 0,
      },
    ];
    const { diff, injectedLineIndices } = applyVirtualPatches(collisionDiff, patches);
    const lines = diff.split('\n');

    // Exactly ONE injected marker is tracked...
    expect(injectedLineIndices).toHaveLength(1);
    // ...and it is the one WE injected ("injected here"), NOT the source line.
    const trackedIdx = injectedLineIndices[0] ?? -1;
    expect(lines[trackedIdx]).toBe('+[SUGGESTED FIX] injected here');

    // The genuine source line that begins with the marker text still exists in
    // the output and is NOT in injectedLineIndices (out-of-band tracking ignores
    // it by construction — identity is positional, not textual).
    const sourceLineIdx = lines.findIndex((l) => l.includes('REAL source content'));
    expect(sourceLineIdx).toBeGreaterThan(-1);
    expect(injectedLineIndices).not.toContain(sourceLineIdx);
  });
});
