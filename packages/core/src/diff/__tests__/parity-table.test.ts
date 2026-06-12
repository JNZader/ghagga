/**
 * Phase 8 (task 8.1) — FINAL cross-consumer parity table over the complete
 * corpus (23 fixtures) × the 5 migrated consumers:
 *
 *   parseDiffFiles · parseHunks/mapDiffToSymbols · extractEntityDiffLines ·
 *   applyVirtualPatches · extractSemanticDiff
 *
 * What this file asserts (and what it does NOT):
 *
 *  1. CROSS-CONSUMER CONSISTENCY — every consumer is a projection of the
 *     SAME unified model (`parseUnifiedDiff`), so for every fixture their
 *     outputs must agree through the model pivot: byte-exact reconstruction
 *     (R2), parseDiffFiles content/path/counters, parseHunks ≡ the strict
 *     hunk-header scan of the raw line stream, extractEntityDiffLines over
 *     the same stream, applyVirtualPatches reconstructing the input on a
 *     miss, and extractSemanticDiff resolving paths from the same headers.
 *
 *  2. DELTA INVENTORY — the documented behavior deltas vs the historical
 *     parsers (C3/M6, M9, and the pinned malformed/synthetic divergences)
 *     are enumerated as DATA below and each corpus-observable delta is
 *     re-demonstrated against the LIVE implementation on its exact fixture.
 *
 *  3. THE TABLE — a generated fixture × consumer report (live behavioral
 *     digests + delta annotations) pinned as a snapshot. Any future change
 *     to any consumer's observable output on any fixture flips a cell.
 *
 * EXCLUSIVITY of the deltas (the proof that the documented deltas are the
 * ONLY ones) is enforced by the five frozen-baseline harnesses — each one
 * compares the live consumer against a VERBATIM copy of its pre-migration
 * implementation across the full corpus (+ dense probe grids), failing on
 * any undocumented divergence:
 *
 *   parity-parse-diff-files.test.ts          (utils/diff.ts @ ce4f4f3)
 *   parity-apply-virtual-patches.test.ts     (patch-extractor.ts @ 51095d6)
 *   parity-parse-hunks.test.ts               (diff-mapper.ts @ 861d48e)
 *   parity-extract-entity-diff-lines.test.ts (entity-diff.ts @ 861d48e, dual baseline)
 *   parity-extract-semantic-diff.test.ts     (semantic-diff @ eaf05c9)
 *
 * This file does NOT duplicate those frozen baselines — it consolidates the
 * inventory and ties the five consumers to each other.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVirtualPatches } from '../../recursive/patch-extractor.js';
import type { SuggestionPatch } from '../../recursive/types.js';
import { parseHunks } from '../../scope/diff-mapper.js';
import { extractEntityDiffLines } from '../../scope/entity-diff.js';
import type { SymbolInfo } from '../../scope/types.js';
import { extractSemanticDiff } from '../../semantic-diff/index.js';
import { parseDiffFiles } from '../../utils/diff.js';
import { matchHunkHeader, parseUnifiedDiff } from '../parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.diff`), 'utf8');
}

/** The complete corpus: golden C1–C16 + adversarial + M6 + real provenance. */
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

const CONSUMERS = [
  'parseDiffFiles',
  'parseHunks',
  'extractEntityDiffLines',
  'applyVirtualPatches',
  'extractSemanticDiff',
] as const;

type Consumer = (typeof CONSUMERS)[number];

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

/** A window covering every possible line position (full-surface probe). */
const FULL_WINDOW = makeSymbol(0, 1_000_000_000);

const patchRounds = JSON.parse(readFileSync(join(FIXTURES, 'c16-patches.json'), 'utf8')) as {
  round1: SuggestionPatch[];
  round2: SuggestionPatch[];
};

// ─── Delta inventory (DATA — the documented deltas vs the legacy parsers) ──

interface DocumentedDelta {
  id: string;
  consumers: readonly Consumer[];
  /** Corpus fixtures whose OUTPUT differs from the legacy implementation. */
  corpusFixtures: readonly string[];
  /** Harness that pins BOTH faces (old & new) of the delta. */
  pinnedBy: string;
  note: string;
}

const DOCUMENTED_DELTAS: readonly DocumentedDelta[] = [
  {
    id: 'M6',
    consumers: ['parseDiffFiles'],
    corpusFixtures: ['c03', 'm6-quoted-consecutive', 'm6-mixed-quoted'],
    pinnedBy: 'parity-parse-diff-files.test.ts',
    note: 'CORE-M6: quoted headers are parsed + unescaped (legacy silently dropped the file and glued its lines to the previous one)',
  },
  {
    id: 'M6-path-auth',
    consumers: ['parseDiffFiles'],
    corpusFixtures: ['adv-header-b-mismatch', 'adv-mixed-quoted-malformed'],
    pinnedBy: 'parity-parse-diff-files.test.ts / parity-extract-semantic-diff.test.ts',
    note: 'malformed-only path divergence: `+++ b/` authority (and quoted-new parsing) vs the legacy greedy header capture — unreachable in git/GitHub/truncateDiff output',
  },
  {
    id: 'M9',
    consumers: ['extractEntityDiffLines'],
    corpusFixtures: ['c07', 'c15'],
    pinnedBy: 'parity-extract-entity-diff-lines.test.ts (dual baseline)',
    note: 'CORE-M9: deletions attributed by their live NEW-side position (legacy compared the OLD-side number against new-side symbol ranges)',
  },
  {
    id: 'R7-walker',
    consumers: ['applyVirtualPatches'],
    corpusFixtures: ['adv-loose-hunk-header', 'adv-mixed-quoted-malformed'],
    pinnedBy: 'parity-apply-virtual-patches.test.ts',
    note: 'malformed-only: a loose `@@ -1,2 +100` no longer resets the counter; a malformed mixed-quoted header is no longer a file boundary (headerQuoted gate)',
  },
  {
    id: 'M6-semantic',
    consumers: ['extractSemanticDiff'],
    corpusFixtures: [],
    pinnedBy: 'parity-extract-semantic-diff.test.ts',
    note: 'quoted sections resolve the real unescaped path instead of `unknown` — NO corpus fixture carries declaration lines inside a quoted section, so corpus output is unchanged (synthetic inputs pinned in the harness)',
  },
  {
    id: 'loose-separators',
    consumers: ['parseHunks', 'extractEntityDiffLines'],
    corpusFixtures: [],
    pinnedBy: 'parity-parse-hunks.test.ts / parity-extract-entity-diff-lines.test.ts',
    note: 'synthetic-only: `\\s+`-separated hunk headers (tabs/multi-space) no longer match — git only emits the single-space form; no corpus fixture carries one that the legacy `\\s+@@`-terminated regexes accepted',
  },
] as const;

// ─── Inventory sanity: entries reference real fixtures and real consumers ──

describe('delta inventory integrity', () => {
  it('every delta references existing corpus fixtures and migrated consumers', () => {
    const fixtureSet = new Set<string>(ALL_FIXTURES);
    const consumerSet = new Set<string>(CONSUMERS);
    for (const delta of DOCUMENTED_DELTAS) {
      for (const f of delta.corpusFixtures) {
        expect(fixtureSet.has(f), `${delta.id}: unknown fixture ${f}`).toBe(true);
      }
      for (const c of delta.consumers) {
        expect(consumerSet.has(c), `${delta.id}: unknown consumer ${c}`).toBe(true);
      }
    }
  });

  it('delta ids are unique', () => {
    const ids = DOCUMENTED_DELTAS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── 1) Cross-consumer consistency through the unified model pivot ──────

describe.each(ALL_FIXTURES)('cross-consumer consistency — %s', (name) => {
  const raw = fixture(name);
  const model = parseUnifiedDiff(raw);

  it('R2: the model reconstructs the input byte-exactly', () => {
    const stream = [...model.preamble, ...model.files.flatMap((f) => f.rawLines)];
    expect(stream.join('\n')).toBe(raw);
  });

  it('parseDiffFiles sections + model preamble re-join into the input byte-exactly', () => {
    const files = parseDiffFiles(raw);
    const segments = model.preamble.length > 0 ? [model.preamble.join('\n')] : [];
    segments.push(...files.map((f) => f.content));
    expect(segments.join('\n')).toBe(raw);
  });

  it('parseDiffFiles paths and counters agree with the model and the raw stream', () => {
    const files = parseDiffFiles(raw);
    expect(files.map((f) => f.path)).toEqual(model.files.map((f) => f.path));

    // The +/- counters over all DiffFiles equal the +/- lines of the raw
    // input minus those in the preamble (R2 partition — no line counted
    // twice, none lost).
    const count = (lines: string[]) => {
      let additions = 0;
      let deletions = 0;
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
      return { additions, deletions };
    };
    const total = count(raw.split('\n'));
    const preamble = count(model.preamble);
    expect(files.reduce((n, f) => n + f.additions, 0)).toBe(total.additions - preamble.additions);
    expect(files.reduce((n, f) => n + f.deletions, 0)).toBe(total.deletions - preamble.deletions);
  });

  it('parseHunks equals the strict hunk-header scan of the raw line stream', () => {
    // Computed independently of the model's preamble/file bucketing: THE
    // single hunk regex (via matchHunkHeader) over raw.split('\n').
    const expected = raw
      .split('\n')
      .map((line) => matchHunkHeader(line))
      .filter((h) => h !== null);
    expect(parseHunks(raw)).toEqual(expected);
  });

  it('extractEntityDiffLines over the full window yields exactly the in-hunk +/- lines of the stream', () => {
    const expected: string[] = [];
    let inHunk = false;
    for (const line of raw.split('\n')) {
      if (matchHunkHeader(line)) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))
      ) {
        expected.push(line);
      }
    }
    expect(extractEntityDiffLines(raw, FULL_WINDOW)).toEqual(expected);

    // Consistency with parseHunks: no hunks ⇒ nothing is ever extracted.
    if (parseHunks(raw).length === 0) {
      expect(expected).toEqual([]);
    }
  });

  it('applyVirtualPatches reconstructs the input byte-exactly on a guaranteed miss', () => {
    expect(applyVirtualPatches(raw, [])).toBe(raw);
    const miss: SuggestionPatch[] = [
      {
        file: 'no-such-file-anywhere.ts',
        line: 3,
        originalMessage: 'miss probe',
        suggestion: 'MISS',
        findingIndex: 0,
      },
    ];
    expect(applyVirtualPatches(raw, miss)).toBe(raw);
  });

  it('extractSemanticDiff resolves every filePath from the same model headers (or the legacy pseudo-section)', () => {
    const allowed = new Set<string>(['unknown']);
    for (const file of model.files) {
      if (file.headerNewPath) allowed.add(file.headerNewPath);
    }
    // Legacy pseudo-section path (preamble first line tail) — same frozen
    // rule as semantic-diff/index.ts LEGACY_SECTION_PATH_RE.
    const pseudo = /a\/.+ b\/(.+)$/.exec(model.preamble[0] ?? '')?.[1];
    if (pseudo) allowed.add(pseudo);

    for (const change of extractSemanticDiff(raw).changes) {
      expect(allowed.has(change.filePath), `unexpected filePath ${change.filePath}`).toBe(true);
    }
  });
});

// ─── 2) Delta inventory — corpus-observable deltas demonstrated LIVE ────
//
// Each documented delta with corpus fixtures is re-demonstrated here against
// the live implementation on those exact fixtures (the legacy face of each
// delta is pinned old-vs-new in the harness named in `pinnedBy`).

describe('delta M6 — quoted headers (parseDiffFiles)', () => {
  it('c03: the quoted file exists with its unescaped path (legacy: dropped)', () => {
    const files = parseDiffFiles(fixture('c03'));
    expect(files.map((f) => f.path)).toEqual(['café.ts']);
  });

  it('m6-quoted-consecutive: three clean files (legacy: one glued file)', () => {
    expect(parseDiffFiles(fixture('m6-quoted-consecutive')).map((f) => f.path)).toEqual([
      'src/normal.ts',
      'café.ts',
      'niño.ts',
    ]);
  });

  it('m6-mixed-quoted: both mixed forms parse (legacy: dropped)', () => {
    expect(parseDiffFiles(fixture('m6-mixed-quoted')).map((f) => f.path)).toEqual([
      'x y.ts',
      'x y.ts',
    ]);
  });
});

describe('delta M6-path-auth — malformed-only path authority (parseDiffFiles)', () => {
  it('adv-header-b-mismatch: the `+++ b/` line wins over the header capture', () => {
    expect(parseDiffFiles(fixture('adv-header-b-mismatch')).map((f) => f.path)).toEqual([
      'PLUS.ts',
    ]);
  });

  it('adv-mixed-quoted-malformed: the quoted-new form parses; path comes from `+++ "b/x"`', () => {
    expect(parseDiffFiles(fixture('adv-mixed-quoted-malformed')).map((f) => f.path)).toEqual(['x']);
  });
});

describe('delta M9 — new-side deletion attribution (extractEntityDiffLines)', () => {
  it('c07 (deleted file, `@@ -1,3 +0,0`): deletions live at new-side 0, not old-side 1..3', () => {
    const raw = fixture('c07');
    // Legacy attributed the three deletions to old lines 1..3 → a symbol at
    // [1,10] received them. Live: the new side never moves past 0.
    expect(extractEntityDiffLines(raw, makeSymbol(1, 10))).toEqual([]);
    expect(extractEntityDiffLines(raw, makeSymbol(0, 0))).toEqual([
      '-new line 1',
      '-new line 2',
      '-new line 3',
    ]);
  });

  it('c15 (drift +2): the deletion lives at new-side 12, not old-side 10', () => {
    const raw = fixture('c15');
    // Legacy leaked `-zline 10` into [1,10] (old-side 10). Live: only the
    // two insertions (new 6–7) fall in that window.
    expect(extractEntityDiffLines(raw, makeSymbol(1, 10))).toEqual(['+inserted A', '+inserted B']);
    expect(extractEntityDiffLines(raw, makeSymbol(12, 12))).toEqual([
      '-zline 10',
      '+zline 10 CHANGED',
    ]);
  });
});

describe('delta R7-walker — malformed boundaries (applyVirtualPatches)', () => {
  it('adv-loose-hunk-header: the loose header does not reset the counter — a probe at 100 never applies', () => {
    const raw = fixture('adv-loose-hunk-header');
    const probe: SuggestionPatch[] = [
      { file: 'loose.ts', line: 100, originalMessage: 'p', suggestion: 'LOOSE', findingIndex: 0 },
    ];
    expect(applyVirtualPatches(raw, probe)).toBe(raw);
  });

  it('adv-mixed-quoted-malformed: the legacy greedy key `inside "b/x"` is no longer a boundary', () => {
    const raw = fixture('adv-mixed-quoted-malformed');
    const probe: SuggestionPatch[] = [
      { file: 'inside "b/x"', line: 1, originalMessage: 'p', suggestion: 'MIX', findingIndex: 0 },
    ];
    expect(applyVirtualPatches(raw, probe)).toBe(raw);
  });
});

describe('delta M6-semantic has NO corpus cell (the reason it is corpus-empty)', () => {
  it('no quoted/malformed corpus fixture carries declaration lines → semantic output unchanged', () => {
    for (const name of [
      'c03',
      'm6-mixed-quoted',
      'm6-quoted-consecutive',
      'adv-mixed-quoted-malformed',
    ]) {
      expect(extractSemanticDiff(fixture(name)).changes, name).toEqual([]);
    }
  });
});

describe('delta loose-separators has NO corpus cell (synthetic-only, live face)', () => {
  it('a `\\s+`-separated header is ignored by parseHunks and extractEntityDiffLines', () => {
    const raw = '@@  -50,2  +50,2  @@\n ctx\n+added';
    expect(parseHunks(raw)).toEqual([]);
    expect(extractEntityDiffLines(raw, makeSymbol(50, 52))).toEqual([]);
  });
});

// ─── 3) The table — live behavioral digest per fixture × consumer ───────
//
// Digests: parseDiffFiles `<files>f +<adds>/-<dels>` · parseHunks `<n>h` ·
// extractEntityDiffLines (full window) `<n>L` · applyVirtualPatches
// `<inserted>p` (markers added by the c16 round-1 patches) · semantic `<n>c`.
// The Δ column annotates the corpus-observable documented deltas.

describe('cross-consumer parity table (generated report)', () => {
  it('matches the pinned table', () => {
    const deltasFor = (name: string): string =>
      DOCUMENTED_DELTAS.filter((d) => d.corpusFixtures.includes(name))
        .map((d) => `${d.id}(${d.consumers.join('+')})`)
        .join(' ') || '—';

    const rows = ALL_FIXTURES.map((name) => {
      const raw = fixture(name);
      const files = parseDiffFiles(raw);
      const additions = files.reduce((n, f) => n + f.additions, 0);
      const deletions = files.reduce((n, f) => n + f.deletions, 0);
      const hunks = parseHunks(raw).length;
      const entityLines = extractEntityDiffLines(raw, FULL_WINDOW).length;
      const patched = applyVirtualPatches(raw, patchRounds.round1);
      const markers = patched.split('\n').length - raw.split('\n').length;
      const changes = extractSemanticDiff(raw).changes.length;
      return [
        name,
        `${files.length}f +${additions}/-${deletions}`,
        `${hunks}h`,
        `${entityLines}L`,
        `${markers}p`,
        `${changes}c`,
        deltasFor(name),
      ];
    });

    const header = ['fixture', 'parseDiffFiles', 'hunks', 'entity', 'patches', 'semantic', 'Δ'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
    const fmt = (cells: string[]) =>
      `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
    const table = [
      fmt(header),
      fmt(widths.map((w) => '-'.repeat(w))),
      ...rows.map((r) => fmt(r)),
    ].join('\n');

    expect(`\n${table}\n`).toMatchSnapshot();
  });
});
