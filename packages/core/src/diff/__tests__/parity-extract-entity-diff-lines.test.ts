/**
 * Phase 6 gate (task 6.3) — parity harness for `extractEntityDiffLines`
 * (scope/entity-diff.ts) over the golden corpus + adversarial fixtures.
 *
 * TWO frozen baselines (Phase 4 dual-baseline pattern):
 *
 *   - `baselineOld`   — VERBATIM frozen copy of the historical
 *     implementation (scope/entity-diff.ts as of commit `861d48e`,
 *     pre-adapter), INCLUDING the CORE-M9 bug (deletions attributed by
 *     their OLD-side line number against NEW-side symbol ranges).
 *   - `baselineOldM9` — the same frozen copy with EXACTLY ONE comparison
 *     changed: deletions compared against the live new-side position
 *     (the documented M9 fix, spec R6). Nothing else differs.
 *
 * Gate: the live implementation must equal `baselineOldM9` on EVERY
 * fixture × probe window. Because the two baselines differ by a single
 * line, any old-vs-live divergence that is NOT explained by M9 shows up
 * as a live-vs-baselineOldM9 mismatch — the only permitted delta is M9.
 *
 * Probe space (Phase 4 lesson: derive ranges from the real input size, not
 * a fixed grid): for each fixture, symbol windows [s, s+k] for every
 * s in 0..lineCount+5 and k in {0, 3, 10}.
 *
 * KNOWN synthetic-only divergence (pinned below): hunk headers with loose
 * `\s+` separators (tabs/multi-space) reset the legacy counters but are
 * ignored by THE single strict hunk regex of the unified model. git only
 * emits the single-space form.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractEntityDiffLines } from '../../scope/entity-diff.js';
import type { SymbolInfo } from '../../scope/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.diff`), 'utf8');
}

const ALL_FIXTURES = [
  'c01',
  'c02',
  'c03',
  'c04',
  'c05',
  'c06',
  'c07',
  'c08',
  'c09',
  'c10',
  'c11',
  'c12',
  'c13',
  'c14',
  'c15',
  'c16',
  'adv-empty-line-mid-hunk',
  'adv-header-b-mismatch',
  'adv-loose-hunk-header',
  'adv-mixed-quoted-malformed',
  'm6-mixed-quoted',
  'm6-quoted-consecutive',
  'provenance-gh-api-pr209',
] as const;

function makeSymbol(startLine: number, endLine: number): SymbolInfo {
  return {
    name: `probe-${startLine}-${endLine}`,
    kind: 'function',
    startLine,
    endLine,
    startByte: 0,
    endByte: 0,
  };
}

// ─── Frozen baselines (verbatim copies of scope/entity-diff.ts @ 861d48e) ──

const BASELINE_HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/** VERBATIM frozen copy of the pre-adapter implementation. DO NOT EDIT. */
function baselineOld(diffContent: string, symbol: SymbolInfo): string[] {
  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentNewLine = 0;
  let currentOldLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = BASELINE_HUNK_RE.exec(line);
    if (hunkMatch) {
      currentOldLine = Number.parseInt(hunkMatch[1]!, 10);
      currentNewLine = Number.parseInt(hunkMatch[2]!, 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (currentOldLine >= symbol.startLine && currentOldLine <= symbol.endLine) {
        result.push(line);
      }
      currentOldLine++;
    } else {
      currentNewLine++;
      currentOldLine++;
    }
  }

  return result;
}

/**
 * Frozen copy of `baselineOld` with EXACTLY ONE change — the M9 fix:
 * deletions compared against `currentNewLine` (the live new-side position)
 * instead of `currentOldLine`. DO NOT EDIT ANYTHING ELSE.
 */
function baselineOldM9(diffContent: string, symbol: SymbolInfo): string[] {
  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentNewLine = 0;
  let currentOldLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = BASELINE_HUNK_RE.exec(line);
    if (hunkMatch) {
      currentOldLine = Number.parseInt(hunkMatch[1]!, 10);
      currentNewLine = Number.parseInt(hunkMatch[2]!, 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
      currentNewLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // THE single M9 change: new-side attribution (spec R6).
      if (currentNewLine >= symbol.startLine && currentNewLine <= symbol.endLine) {
        result.push(line);
      }
      currentOldLine++;
    } else {
      currentNewLine++;
      currentOldLine++;
    }
  }

  return result;
}

// ─── Probe windows derived from the real fixture size ───────────

const WINDOW_SIZES = [0, 3, 10] as const;

function probeWindows(raw: string): SymbolInfo[] {
  const lineCount = raw.split('\n').length;
  const anchors = new Set<number>();
  for (let s = 0; s <= lineCount + 5; s++) anchors.add(s);

  // 3vr fix-forward (Codex, Phase 5-7 review): hunk headers can reference
  // new-side positions FAR beyond the textual length of the diff (a short
  // diff touching deep lines of a large file is perfectly reachable git
  // output). Anchor extra windows at every old/new start captured by the
  // LEGACY loose regex over the raw lines — impl-independent key space, so
  // the probe grid cannot inherit a blind spot from either implementation.
  for (const line of raw.split('\n')) {
    const m = BASELINE_HUNK_RE.exec(line);
    if (m) {
      for (const v of [Number.parseInt(m[1] ?? '0', 10), Number.parseInt(m[2] ?? '0', 10)]) {
        for (const off of [-3, -1, 0, 1, 3, 11]) anchors.add(Math.max(0, v + off));
      }
    }
  }

  const windows: SymbolInfo[] = [];
  for (const s of anchors) {
    for (const k of WINDOW_SIZES) windows.push(makeSymbol(s, s + k));
  }
  return windows;
}

// ─── Parity gate: live === baselineOldM9, only delta vs old is M9 ──

describe.each(ALL_FIXTURES)('extractEntityDiffLines parity %s', (name) => {
  it('live output equals the M9-fixed frozen baseline on every probe window', () => {
    const raw = fixture(name);
    for (const symbol of probeWindows(raw)) {
      const live = extractEntityDiffLines(raw, symbol);
      const expected = baselineOldM9(raw, symbol);
      expect(live, `${name} window [${symbol.startLine}, ${symbol.endLine}]`).toEqual(expected);
    }
  });
});

describe('gate 6.3 aggregate — the only old-vs-live delta is M9 (non-vacuous)', () => {
  it('old-vs-M9 divergent windows exist and live always sides with M9', () => {
    let divergentWindows = 0;
    let comparedWindows = 0;
    for (const name of ALL_FIXTURES) {
      const raw = fixture(name);
      for (const symbol of probeWindows(raw)) {
        comparedWindows++;
        const old = baselineOld(raw, symbol);
        const m9 = baselineOldM9(raw, symbol);
        const live = extractEntityDiffLines(raw, symbol);
        expect(live, `${name} [${symbol.startLine}, ${symbol.endLine}] vs M9 baseline`).toEqual(m9);
        if (JSON.stringify(old) !== JSON.stringify(m9)) divergentWindows++;
      }
    }
    expect(comparedWindows).toBeGreaterThan(1000);
    // The corpus itself exhibits the M9 delta (c07 deleted-file hunks and
    // c15 drift, among others) — proves the dual-baseline gate is sensitive.
    expect(divergentWindows).toBeGreaterThan(0);
  });
});

// ─── Bare hunk fragments (no `diff --git` header → model preamble) ──

describe('parity on bare hunk fragments (kept in the model preamble)', () => {
  const FRAGMENTS: Array<[string, string]> = [
    ['additions only', '@@ -5,2 +5,3 @@\n line 5\n+added at 6\n line 7'],
    [
      'deletions with drift',
      '@@ -1,2 +1,7 @@\n a\n+i1\n+i2\n+i3\n+i4\n+i5\n b\n@@ -10,3 +15,2 @@\n c\n-gone\n d',
    ],
    ['prose then hunk', 'not a diff\n@@ -3,2 +3,2 @@\n-x\n+y\n z'],
    [
      'deep positions: short diff touching far lines of a large file (3vr fix-forward)',
      'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -99998,3 +199998,3 @@ deep\n ctx\n-deep gone\n+deep new\n@@ -100010,2 +200010,3 @@ deeper\n ctx\n+deep added',
    ],
  ];

  it.each(FRAGMENTS)('%s', (_label, raw) => {
    for (const symbol of probeWindows(raw)) {
      expect(
        extractEntityDiffLines(raw, symbol),
        `[${symbol.startLine}, ${symbol.endLine}]`,
      ).toEqual(baselineOldM9(raw, symbol));
    }
  });
});

// ─── KNOWN synthetic-only divergence: loose `\s+` hunk separators ──

describe('KNOWN synthetic-only divergence: loose whitespace hunk headers (pinned)', () => {
  it('a multi-space header reset the legacy counters; the unified model ignores it', () => {
    // Legacy: the loose header resets the counter to new-side 50, so the
    // addition lands at line 50. Unified model: the malformed header is not
    // a hunk — the walk never enters a hunk, nothing is extracted.
    const raw = '@@  -50,2  +50,2  @@\n ctx\n+added';
    const symbol = makeSymbol(50, 52);

    expect(baselineOld(raw, symbol)).toEqual(['+added']);
    expect(baselineOldM9(raw, symbol)).toEqual(['+added']);
    expect(extractEntityDiffLines(raw, symbol)).toEqual([]);
  });

  it('the strict single-space form (what git emits) stays in full parity', () => {
    const raw = '@@ -50,2 +50,2 @@\n ctx\n+added';
    const symbol = makeSymbol(50, 52);
    expect(extractEntityDiffLines(raw, symbol)).toEqual(baselineOldM9(raw, symbol));
    expect(extractEntityDiffLines(raw, symbol)).toEqual(['+added']);
  });
});

// ─── M9 — both faces pinned old-vs-new (documented delta, changelog) ──

describe('CORE-M9 — documented delta vs the historical behavior (spec R6)', () => {
  const DRIFT_DIFF = [
    'diff --git a/src/svc.ts b/src/svc.ts',
    '--- a/src/svc.ts',
    '+++ b/src/svc.ts',
    '@@ -1,2 +1,7 @@',
    ' line one',
    '+ins two',
    '+ins three',
    '+ins four',
    '+ins five',
    '+ins six',
    ' line two',
    '@@ -10,4 +15,3 @@ function svc()',
    ' ctx A',
    '-removed inside svc',
    ' ctx B',
    ' ctx C',
  ].join('\n');

  it('face 1: the deletion now reaches the symbol containing its new-side position', () => {
    const svc = makeSymbol(15, 17);
    expect(baselineOld(DRIFT_DIFF, svc)).toEqual([]); // historical miss
    expect(extractEntityDiffLines(DRIFT_DIFF, svc)).toEqual(['-removed inside svc']);
  });

  it('face 2: the deletion no longer leaks into the symbol spanning its old-side number', () => {
    const bystander = makeSymbol(10, 12);
    expect(baselineOld(DRIFT_DIFF, bystander)).toEqual(['-removed inside svc']); // historical leak
    expect(extractEntityDiffLines(DRIFT_DIFF, bystander)).toEqual([]);
  });
});
