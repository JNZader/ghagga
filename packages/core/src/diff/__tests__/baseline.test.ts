/**
 * Golden corpus BASELINE — captures the CURRENT behavior of the 5 existing
 * unified-diff parsers BEFORE any migration to the unified parser.
 *
 * ⚠️ These snapshots freeze behavior AS-IS, including known bugs:
 *   - CORE-M6: quoted paths (c03) were silently dropped by parseDiffFiles.
 *     FIXED in Phase 3 (adapter over parseUnifiedDiff) — the c03
 *     parseDiffFiles snapshot reflects the new documented behavior; the
 *     other 4 parsers still freeze the pre-M6 behavior until their phases.
 *   - CORE-M9: extractEntityDiffLines attributed deletions by old-side line
 *     against new-side symbol ranges. FIXED in Phase 6 (adapter over
 *     parseUnifiedDiff) — the c07/c15 extractEntityDiffLines snapshots
 *     reflect the new documented behavior (deletions attributed by the live
 *     new-side position); both faces of the delta are gated in
 *     parity-extract-entity-diff-lines.test.ts.
 *   - recursive off-by-N on iteration 2+ (see recursive-golden.test.ts).
 * Do NOT "fix" a snapshot here — divergence means a parity break in the
 * migration, except where the spec explicitly documents a delta (M6/M9).
 *
 * Corpus provenance (spec sdd/unify-diff-parsers, C1–C16):
 *   c01–c10, c15  generated from a real local git repo (renames with -M,
 *                 core.quotepath octal escapes, --binary, -U0, CRLF, chmod).
 *   c11           = truncateDiff(c01, 250) — real production truncation.
 *   c12           = c01 cut mid `diff --git` header line.
 *   c13, c14      hand-written (arbitrary ACP input / empty).
 *   c16           = applyVirtualPatches(c01, round1 patches) — the input the
 *                 recursive loop re-parses on iteration 2 (recursive/index.ts:155).
 * Provenance of the derived fixtures (c11/c12/c16) is re-asserted below so
 * they can never drift from the functions that generated them.
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
import { parseDiffFiles, truncateDiff } from '../../utils/diff.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const CASES = [
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
] as const;

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.diff`), 'utf8');
}

const patchRounds = JSON.parse(readFileSync(join(FIXTURES, 'c16-patches.json'), 'utf8')) as {
  round1: SuggestionPatch[];
  round2: SuggestionPatch[];
};

/** Fixed symbol ranges (new-side) used to exercise extractEntityDiffLines. */
const SYMBOLS: SymbolInfo[] = [
  { name: 'symEarly', kind: 'function', startLine: 1, endLine: 10, startByte: 0, endByte: 0 },
  { name: 'symLate', kind: 'function', startLine: 25, endLine: 40, startByte: 0, endByte: 0 },
];

// ─── Derived-fixture provenance (must never drift) ───────────────

describe('derived fixture provenance', () => {
  it('c11 is exactly truncateDiff(c01, 250)', () => {
    const { truncated, wasTruncated } = truncateDiff(fixture('c01'), 250);
    expect(wasTruncated).toBe(true);
    expect(truncated).toBe(fixture('c11'));
  });

  it('c11 cuts mid-hunk (the truncation marker interrupts an open hunk)', () => {
    const lines = fixture('c11').split('\n');
    const markerIdx = lines.findIndex((l) => l.includes('diff truncated'));
    expect(markerIdx).toBeGreaterThan(0);
    // the last hunk header appears after the last file header → cut is inside a hunk
    const lastHunk = lines.reduce((acc, l, i) => (l.startsWith('@@') ? i : acc), -1);
    const lastFile = lines.reduce((acc, l, i) => (l.startsWith('diff --git') ? i : acc), -1);
    expect(lastHunk).toBeGreaterThan(lastFile);
  });

  it('c12 is c01 cut mid file-header line', () => {
    const c01 = fixture('c01');
    const gammaHeader = c01.indexOf('diff --git a/src/gamma.ts');
    expect(fixture('c12')).toBe(c01.slice(0, gammaHeader + 'diff --git a/src/ga'.length));
  });

  it('c16 is exactly applyVirtualPatches(c01, round1)', () => {
    expect(applyVirtualPatches(fixture('c01'), patchRounds.round1).diff).toBe(fixture('c16'));
  });

  it('c16 patch fixture is deterministic (two runs, identical output)', () => {
    const a = applyVirtualPatches(fixture('c01'), patchRounds.round1).diff;
    const b = applyVirtualPatches(fixture('c01'), patchRounds.round1).diff;
    expect(a).toBe(b);
  });
});

// ─── Baseline snapshots: the 5 current parsers over the corpus ───

describe.each(CASES)('baseline %s', (name) => {
  const raw = fixture(name);

  it('parseDiffFiles (utils/diff.ts)', () => {
    expect(parseDiffFiles(raw)).toMatchSnapshot();
  });

  it('parseHunks (scope/diff-mapper.ts)', () => {
    expect(parseHunks(raw)).toMatchSnapshot();
  });

  it('extractEntityDiffLines (scope/entity-diff.ts)', () => {
    const bySymbol = SYMBOLS.map((symbol) => ({
      symbol: symbol.name,
      lines: extractEntityDiffLines(raw, symbol),
    }));
    expect(bySymbol).toMatchSnapshot();
  });

  it('applyVirtualPatches (recursive/patch-extractor.ts)', () => {
    // Deterministic generic patches targeting the first parsed file of each
    // fixture (lines 3 and 6), so every corpus case exercises the walker.
    const firstPath = parseDiffFiles(raw)[0]?.path ?? 'no-file.ts';
    const generic: SuggestionPatch[] = [
      {
        file: firstPath,
        line: 3,
        originalMessage: 'baseline probe at line 3',
        suggestion: 'BASELINE_PROBE_3',
        findingIndex: 0,
      },
      {
        file: firstPath,
        line: 6,
        originalMessage: 'baseline probe at line 6',
        suggestion: 'BASELINE_PROBE_6',
        findingIndex: 1,
      },
    ];
    expect(applyVirtualPatches(raw, generic).diff).toMatchSnapshot();
  });

  it('extractSemanticDiff (semantic-diff/index.ts)', () => {
    expect(extractSemanticDiff(raw)).toMatchSnapshot();
  });
});

// ─── Documented current-behavior assertions (explicit, not snapshot) ───

describe('frozen known behaviors', () => {
  it('CORE-M6 FIXED (Phase 3, documented delta): quoted paths (c03) are now parsed', () => {
    // Pre-adapter baseline was `[]` (file silently dropped). The Phase 3
    // adapter over parseUnifiedDiff fixes M6: the quoted file appears with
    // its path unescaped. Both faces of the delta (file appears + previous
    // file no longer absorbs its lines) are gated byte-by-byte in
    // parity-parse-diff-files.test.ts.
    const files = parseDiffFiles(fixture('c03'));
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('café.ts');
  });

  it('non-diff input (c13) and empty input (c14) parse to []', () => {
    expect(parseDiffFiles(fixture('c13'))).toEqual([]);
    expect(parseDiffFiles(fixture('c14'))).toEqual([]);
    expect(parseDiffFiles('\n')).toEqual([]);
  });

  it('no parser throws on any corpus case', () => {
    for (const name of CASES) {
      const raw = fixture(name);
      expect(() => parseDiffFiles(raw)).not.toThrow();
      expect(() => parseHunks(raw)).not.toThrow();
      for (const s of SYMBOLS) expect(() => extractEntityDiffLines(raw, s)).not.toThrow();
      expect(() => applyVirtualPatches(raw, patchRounds.round1)).not.toThrow();
      expect(() => extractSemanticDiff(raw)).not.toThrow();
    }
  });
});
