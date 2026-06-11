/**
 * Phase 3 GATE (task 3.3, BLOCKING) — byte-parity harness for the
 * `parseDiffFiles` adapter over the golden corpus C1–C16.
 *
 * `baselineParseDiffFiles` below is a VERBATIM frozen copy of the historical
 * implementation (`utils/diff.ts` as of commit `ce4f4f3`, pre-adapter). The
 * live `parseDiffFiles` must produce byte-identical output (path, additions,
 * deletions, and `content` compared as UTF-8 bytes) for every corpus case.
 *
 * The ONLY delta the spec allows is C3/CORE-M6 (quoted paths). It has two
 * faces, and BOTH must be asserted when the adapter lands (task 3.3):
 *   1. the quoted file appears as its own DiffFile (today: silently dropped);
 *   2. a preceding file no longer absorbs the quoted file's diff lines into
 *      its `content`/counters (today: contamination of the previous section).
 *
 * One undocumented byte of difference anywhere else = parity break = NO COMMIT.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type DiffFile, parseDiffFiles } from '../../utils/diff.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.diff`), 'utf8');
}

/**
 * Corpus cases where output must be byte-identical to the baseline.
 * c03 (quoted paths) is the single documented M6 delta — asserted separately.
 */
const PARITY_CASES = [
  'c01',
  'c02',
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

// ─── Frozen baseline (verbatim copy of utils/diff.ts @ ce4f4f3) ──

const BASELINE_FILE_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/;

/** VERBATIM frozen copy of the pre-adapter parseDiffFiles. DO NOT EDIT. */
function baselineParseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split('\n');

  let currentFile: DiffFile | null = null;
  const contentLines: string[] = [];

  function flushCurrent() {
    if (currentFile) {
      currentFile.content = contentLines.join('\n');
      files.push(currentFile);
      contentLines.length = 0;
    }
  }

  for (const line of lines) {
    const match = BASELINE_FILE_HEADER_RE.exec(line);
    if (match) {
      // Start of a new file — flush previous
      flushCurrent();
      currentFile = {
        path: match[1] ?? '',
        additions: 0,
        deletions: 0,
        content: '',
      };
      contentLines.push(line);
    } else if (currentFile) {
      contentLines.push(line);

      // Count additions and deletions (skip hunk headers and --- / +++ lines)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.deletions++;
      }
    }
  }

  // Flush last file
  flushCurrent();

  return files;
}

// ─── Byte-level comparison helper ───────────────────────────────

function expectByteEqual(actual: string, expected: string, label: string): void {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (!a.equals(b)) {
    // Surface the first divergent byte offset for fast diagnosis.
    let offset = 0;
    const max = Math.min(a.length, b.length);
    while (offset < max && a[offset] === b[offset]) offset++;
    expect.fail(
      `byte mismatch in ${label} at offset ${offset} ` +
        `(actual ${a.length}B vs baseline ${b.length}B): ` +
        `actual=${JSON.stringify(actual.slice(Math.max(0, offset - 20), offset + 20))} ` +
        `baseline=${JSON.stringify(expected.slice(Math.max(0, offset - 20), offset + 20))}`,
    );
  }
}

// ─── Parity gate ────────────────────────────────────────────────

describe.each(PARITY_CASES)('parseDiffFiles parity %s', (name) => {
  it('is byte-identical to the frozen baseline (path, counts, content)', () => {
    const raw = fixture(name);
    const baseline = baselineParseDiffFiles(raw);
    const current = parseDiffFiles(raw);

    expect(current).toHaveLength(baseline.length);
    current.forEach((file, i) => {
      // biome-ignore lint/style/noNonNullAssertion: same length asserted above
      const ref = baseline[i]!;
      expect(file.path, `${name} file[${i}] path`).toBe(ref.path);
      expect(file.additions, `${name} file[${i}] additions`).toBe(ref.additions);
      expect(file.deletions, `${name} file[${i}] deletions`).toBe(ref.deletions);
      expectByteEqual(file.content, ref.content, `${name} file[${i}] (${ref.path}) content`);
    });
    expect(current).toEqual(baseline);
  });
});

describe('GATE 3.3 aggregate', () => {
  it('compares every parity case file-by-file at byte level (corpus is not empty)', () => {
    let comparedFiles = 0;
    let comparedBytes = 0;
    for (const name of PARITY_CASES) {
      const baseline = baselineParseDiffFiles(fixture(name));
      const current = parseDiffFiles(fixture(name));
      expect(current).toEqual(baseline);
      comparedFiles += baseline.length;
      for (const f of baseline) comparedBytes += Buffer.byteLength(f.content, 'utf8');
    }
    // c01(3) c02(1) c04(2) c05(2) c06(1) c07(1) c08(1) c09(1) c10(1)
    // c11(1) c12(2) c13(0) c14(0) c15(2) c16(3) = 21 DiffFiles
    expect(comparedFiles).toBe(21);
    expect(comparedBytes).toBeGreaterThan(0);
  });
});

// ─── C3/CORE-M6 — the single documented delta, BOTH faces ──────

describe('C3/M6 quoted paths — documented delta vs baseline (changelog: minor)', () => {
  it('face 1: standalone quoted file (c03) now appears (baseline dropped it)', () => {
    // Baseline behavior, kept as evidence of the delta:
    expect(baselineParseDiffFiles(fixture('c03'))).toEqual([]);

    // New behavior: one DiffFile, unescaped path, byte-exact content
    // (the section is the ENTIRE c03 fixture — preamble is empty).
    const files = parseDiffFiles(fixture('c03'));
    expect(files).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const quoted = files[0]!;
    expect(quoted.path).toBe('café.ts');
    expect(quoted.additions).toBe(1);
    expect(quoted.deletions).toBe(1);
    expectByteEqual(quoted.content, fixture('c03'), 'c03 quoted file content');
  });

  it('face 2: a preceding file no longer absorbs the quoted section (exact byte redistribution)', () => {
    // Composite: c01 (3 plain files) followed by c03 (1 quoted file).
    const composite = fixture('c01') + fixture('c03');
    const baseline = baselineParseDiffFiles(composite);
    const current = parseDiffFiles(composite);

    // Baseline: quoted file missing, its lines glued to gamma (the previous file).
    expect(baseline.map((f) => f.path)).toEqual(['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts']);
    // New: quoted file is its own DiffFile.
    expect(current.map((f) => f.path)).toEqual([
      'src/alpha.ts',
      'src/beta.ts',
      'src/gamma.ts',
      'café.ts',
    ]);

    // Files untouched by the delta stay byte-identical.
    for (const i of [0, 1] as const) {
      // biome-ignore lint/style/noNonNullAssertion: lengths asserted above
      expectByteEqual(current[i]!.content, baseline[i]!.content, `composite file[${i}]`);
      expect(current[i]).toEqual(baseline[i]);
    }

    // biome-ignore lint/style/noNonNullAssertion: lengths asserted above
    const [gammaBaseline, gammaCurrent, quoted] = [baseline[2]!, current[2]!, current[3]!];

    // Gamma no longer carries the quoted section…
    expect(gammaCurrent.content).not.toContain('caf');
    // …and the bytes are EXACTLY redistributed, none lost, none invented:
    // baseline gamma === current gamma + '\n' + quoted file section.
    expectByteEqual(
      gammaBaseline.content,
      `${gammaCurrent.content}\n${quoted.content}`,
      'composite gamma+quoted byte redistribution',
    );
    // Counters move with the bytes: gamma loses c03's +1/-1, the quoted file gains them.
    expect(gammaCurrent.additions).toBe(gammaBaseline.additions - 1);
    expect(gammaCurrent.deletions).toBe(gammaBaseline.deletions - 1);
    expect(quoted).toMatchObject({ path: 'café.ts', additions: 1, deletions: 1 });
  });
});
