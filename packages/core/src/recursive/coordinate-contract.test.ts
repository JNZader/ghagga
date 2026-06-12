/**
 * COORDINATE CONTRACT — both-interpretation integration test (Design B).
 *
 * The recursive review loop feeds a SYNTHETIC diff (with injected
 * `+[SUGGESTED FIX]` markers) back to the LLM on iteration 2+. The historical
 * walker did NOT renumber the hunk headers when it injected markers, so the
 * declared `@@ +N` lied about physical line positions. A real LLM can number
 * the new-file side in (at least) two self-consistent ways:
 *
 *   - Interp A — discounts markers: it treats `[SUGGESTED FIX]` lines as
 *     review annotations, NOT real source, and does not count them when
 *     assigning a line number to a real code line.
 *   - Interp B — counts physical lines: it numbers every `+`/context line it
 *     sees, markers included.
 *
 * Under the LEGACY (non-renumbered) headers these two interpretations assign
 * DIFFERENT line numbers to the SAME real code line, so the marker the walker
 * injects on iteration 2 lands in a DIFFERENT place depending on which way the
 * LLM happened to number — a non-deterministic off-by-N.
 *
 * Under Design B the synthetic diff is a VALID unified diff: the header tells
 * the truth (physical position == declared `@@ +N` == real new-file line). A
 * and B then read the SAME number off the header, so the iteration-2 marker
 * lands adjacent to the SAME intended real line for BOTH interpretations.
 *
 * This test drives the FULL `recursiveReview` loop (iter1 -> iter2 threading)
 * and asserts A and B converge on the same landing with NO drift. It is RED
 * against the current legacy walker and turns GREEN once Design B renumbering
 * lands.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GenerateTextFn } from '../providers/generate-fn.js';
import { recursiveReview } from './index.js';
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

const MARKER_PREFIX = '+[SUGGESTED FIX]';

type Interp = 'A' | 'B';

/** Extract the ```diff fenced block from a re-review prompt. */
function extractDiffFromPrompt(prompt: string): string {
  const m = /```diff\n([\s\S]*?)\n```/.exec(prompt);
  return m?.[1] ?? '';
}

/**
 * Given a parsed synthetic diff (as a string), find the NEW-FILE line number
 * that a sane LLM would assign to the FIRST real (non-marker) `+`/context line
 * whose content contains `needle`, under the given interpretation.
 *
 * Interp A: markers are NOT counted (the LLM mentally subtracts them).
 * Interp B: markers ARE counted as physical lines.
 *
 * The two interpretations differ in WHICH coordinate they anchor to:
 *
 *   - Interp A (header-trusting, marker-discounting): resets the counter to the
 *     DECLARED `newStart - 1` at every hunk header and SKIPS injected markers.
 *     It believes the `@@ +N` literally and treats `[SUGGESTED FIX]` as an
 *     annotation, not source. Its number for a real line is HEADER-RELATIVE.
 *   - Interp B (physical truth, marker-counting): ignores the new-side of the
 *     header for anchoring and instead tracks the TRUE physical new-file line,
 *     anchoring each hunk by the STABLE old-side start (`@@ -O,..`, which is
 *     never renumbered) plus the running surplus of new-over-old lines
 *     (added lines AND injected markers) accumulated so far in the file. It
 *     counts every injected marker as a real new-file line.
 *
 * Under the LEGACY headers (new-side NOT renumbered for injected markers) A and
 * B assign DIFFERENT numbers to a real line in a hunk AFTER an injected marker:
 * A trusts the stale `+N`, B reflects the physical shift. Under Design B the
 * header's `+N` is corrected to equal the physical truth, so the two CONVERGE.
 * That convergence IS the contract under test.
 */
function lineNumberOf(diff: string, needle: string, interp: Interp): number | null {
  const lines = diff.split('\n');
  // Interp A state: header-relative counter (trusts the new-side `@@ +N`).
  let counterA = 0;
  // Interp B state: physical new-file counter. Re-anchored at every hunk on the
  // STABLE old-side start plus the running new-over-old surplus (added lines +
  // injected markers - removed lines) accumulated earlier in the same file.
  let counterB = 0;
  let markersInFile = 0; // injected markers seen so far in this file
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      markersInFile = 0; // new file — marker surplus resets
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk?.[1] && hunk?.[2]) {
      counterA = parseInt(hunk[2], 10) - 1;
      // Old start is never renumbered, so it is the stable anchor; the only
      // new-over-old surplus a pure-modify diff accrues is the injected markers
      // above this hunk. B re-derives its position header-independently.
      counterB = parseInt(hunk[1], 10) - 1 + markersInFile;
      continue;
    }
    const isMarker = line.startsWith(MARKER_PREFIX);
    const isAddition = line.startsWith('+') && !line.startsWith('+++');
    const isRemoval = line.startsWith('-') && !line.startsWith('---');
    const isMeta =
      line.startsWith('\\') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@');

    if (isMarker) {
      // B counts the marker as a real physical new-file line; A skips it.
      markersInFile++;
      counterB++;
      if (interp === 'B' && line.includes(needle)) return counterB;
      continue;
    }

    if (isRemoval) continue; // neither new-side counter advances on removals
    if (!isAddition && isMeta) continue;

    // Real new-side line (addition or context): both counters advance.
    counterA++;
    counterB++;
    if (line.includes(needle)) return interp === 'A' ? counterA : counterB;
  }
  return null;
}

/**
 * Mock LLM that numbers like a real one: it PARSES the patchedDiff it is given
 * and reports a finding on a REAL target line, computed under `interp`. It is
 * NOT hardcoded — change the input diff and the reported LINE follows.
 *
 * Round 1 of `recursiveReview` re-reviews `applyVirtualPatches(c01, round1)`.
 * That synthetic diff already contains the round-1 marker in alpha hunk 1. The
 * mock targets a real code line in alpha hunk 2 (`alpha30`), which lives AFTER
 * the injected marker — so a wrong header (legacy) makes A and B disagree on
 * its number, while a truthful header (Design B) makes them agree.
 */
function makeMockLLM(interp: Interp, calls: { prompt: string }[]): GenerateTextFn {
  return async (_system: string, prompt: string) => {
    calls.push({ prompt });
    const diff = extractDiffFromPrompt(prompt);
    // Target a real line in the SECOND hunk of alpha, after the injected marker.
    const target = lineNumberOf(diff, 'export const alpha30', interp);
    if (target == null) {
      return { text: 'STATUS: PASSED\nSUMMARY: nothing\nFINDINGS:', tokensUsed: 1 };
    }
    return {
      text: [
        'STATUS: FAILED',
        'SUMMARY: regression near alpha30',
        'FINDINGS:',
        '- SEVERITY: medium',
        '  CATEGORY: bug',
        '  FILE: src/alpha.ts',
        `  LINE: ${target}`,
        '  MESSAGE: alpha30 changed value may break callers',
        '  SUGGESTION: export const alpha30 = 3000; // validated',
      ].join('\n'),
      tokensUsed: 1,
    };
  };
}

/**
 * Resolve where the round-2 marker physically landed: the content of the real
 * line it was injected immediately AFTER, in the final synthetic diff produced
 * by re-applying the LLM's round-2 patch.
 *
 * We reconstruct the iter-2 patch from the recorded LLM call and re-run
 * `applyVirtualPatches` on the iter-1 synthetic diff (exactly what the loop
 * feeds iter 2), then read the "after" context of the NEW marker.
 */
function landingAfterContent(interp: Interp): string | null {
  const iter1Diff = applyVirtualPatches(c01, round1) as unknown as { diff: string } | string;
  const iter1Str = typeof iter1Diff === 'string' ? iter1Diff : iter1Diff.diff;
  // The LLM, on round 1 of the loop, sees iter1Str and reports a LINE on alpha30.
  const targetLine = lineNumberOf(iter1Str, 'export const alpha30', interp);
  if (targetLine == null) return null;
  const round2Patch: SuggestionPatch[] = [
    {
      file: 'src/alpha.ts',
      line: targetLine,
      originalMessage: 'regression near alpha30',
      suggestion: 'export const alpha30 = 3000; // validated',
      findingIndex: 0,
    },
  ];
  const iter2 = applyVirtualPatches(iter1Str, round2Patch) as unknown as { diff: string } | string;
  const iter2Str = typeof iter2 === 'string' ? iter2 : iter2.diff;
  const lines = iter2Str.split('\n');
  // Find the LAST injected marker (the round-2 one) and return its preceding line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.startsWith(MARKER_PREFIX) && lines[i]?.includes('validated')) {
      return lines[i - 1] ?? null;
    }
  }
  return null;
}

describe('coordinate contract — robust to both LLM numbering interpretations', () => {
  it('A and B assign the SAME line number to a real code line after an injected marker', () => {
    const iter1 = applyVirtualPatches(c01, round1) as unknown as { diff: string } | string;
    const iter1Str = typeof iter1 === 'string' ? iter1 : iter1.diff;
    const a = lineNumberOf(iter1Str, 'export const alpha30', 'A');
    const b = lineNumberOf(iter1Str, 'export const alpha30', 'B');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Under Design B the truthful header makes both interpretations agree.
    expect(a).toBe(b);
  });

  it('round-2 marker lands adjacent to the SAME real line under A and B (no drift)', () => {
    const landingA = landingAfterContent('A');
    const landingB = landingAfterContent('B');
    expect(landingA).not.toBeNull();
    expect(landingB).not.toBeNull();
    expect(landingA).toBe(landingB);
    // And it must land on the intended real line, not drift onto a neighbour.
    expect(landingA).toContain('alpha30');
  });

  it('full recursiveReview loop converges to the same regression line under A and B', async () => {
    const callsA: { prompt: string }[] = [];
    const callsB: { prompt: string }[] = [];

    const reportA = await recursiveReview({
      originalDiff: c01,
      findings: round1.map((p) => ({
        severity: 'medium' as const,
        category: 'bug' as const,
        file: p.file,
        line: p.line,
        message: p.originalMessage,
        suggestion: p.suggestion,
        source: 'ai' as const,
      })),
      generateFn: makeMockLLM('A', callsA),
      config: { maxIterations: 2 },
      features: { circuitBreaker: false },
    });

    const reportB = await recursiveReview({
      originalDiff: c01,
      findings: round1.map((p) => ({
        severity: 'medium' as const,
        category: 'bug' as const,
        file: p.file,
        line: p.line,
        message: p.originalMessage,
        suggestion: p.suggestion,
        source: 'ai' as const,
      })),
      generateFn: makeMockLLM('B', callsB),
      config: { maxIterations: 2 },
      features: { circuitBreaker: false },
    });

    // Both interpretations parsed the same iter-1 synthetic diff prompt.
    expect(callsA.length).toBeGreaterThan(0);
    expect(callsB.length).toBeGreaterThan(0);

    // The LINE the LLM reported (parsed back from the prompt) must be identical
    // across A and B — that is the contract: the header tells the truth.
    const firstDiffA = extractDiffFromPrompt(callsA[0]?.prompt ?? '');
    const firstDiffB = extractDiffFromPrompt(callsB[0]?.prompt ?? '');
    expect(lineNumberOf(firstDiffA, 'export const alpha30', 'A')).toBe(
      lineNumberOf(firstDiffB, 'export const alpha30', 'B'),
    );

    // Both loops produced a report (regression detected) — same shape.
    expect(reportA?.iterations).toBe(reportB?.iterations);
  });
});
