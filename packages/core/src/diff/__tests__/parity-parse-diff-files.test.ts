/**
 * Phase 3 GATE (task 3.3, BLOCKING) — byte-parity harness for the
 * `parseDiffFiles` adapter over the golden corpus C1–C16.
 *
 * `baselineParseDiffFiles` below is a VERBATIM frozen copy of the historical
 * implementation (`utils/diff.ts` as of commit `ce4f4f3`, pre-adapter). The
 * live `parseDiffFiles` must produce byte-identical output (path, additions,
 * deletions, and `content` compared as UTF-8 bytes) for every corpus case.
 *
 * Documented deltas (everything else must be byte-identical — one
 * undocumented byte of difference = parity break = NO COMMIT):
 *
 *   - C3/CORE-M6 (quoted paths), asserted BOTH-SIDES in four faces:
 *       1. a standalone quoted file appears as its own DiffFile
 *          (baseline: silently dropped);
 *       2. a preceding file no longer absorbs the quoted file's diff lines
 *          into its `content`/counters (baseline: contamination);
 *       3. TWO consecutive quoted files after a normal one yield 3 clean
 *          files (baseline: 1 glued file carrying all counters);
 *       4. mixed-quoted headers (`"a/x" b/y` and `a/x "b/y"`) parse
 *          (baseline: dropped).
 *   - MALFORMED-ONLY path divergence: when the `diff --git ... b/X` capture
 *     disagrees with the `+++ b/Y` line, the baseline resolved X (header
 *     regex) while the new parser resolves Y (`+++ b/` authority). Cannot
 *     occur in well-formed git/GitHub output, where both always agree.
 *
 * Adversarial contract pin (Phase 4 consumer): a genuine EMPTY line
 * mid-hunk (upstream stripped the ' ' prefix of a blank context line)
 * CLOSES the open hunk — see the dedicated describe block below.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type DiffFile, parseDiffFiles } from '../../utils/diff.js';
import { parseUnifiedDiff } from '../parse.js';

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

/**
 * Field-wise parity over the 4 HISTORICAL fields: path, additions, deletions
 * and content compared as UTF-8 bytes. Deliberately NOT a structural
 * `toEqual`: the gate freezes the legacy surface, not the shape of the type —
 * extending `DiffFile` with new fields must NOT break the gate while
 * historical parity holds.
 */
function expectHistoricalFieldParity(
  current: DiffFile[],
  baseline: DiffFile[],
  label: string,
): void {
  expect(current, `${label} file count`).toHaveLength(baseline.length);
  current.forEach((file, i) => {
    const ref = baseline[i]!;
    expect(file.path, `${label} file[${i}] path`).toBe(ref.path);
    expect(file.additions, `${label} file[${i}] additions`).toBe(ref.additions);
    expect(file.deletions, `${label} file[${i}] deletions`).toBe(ref.deletions);
    expectByteEqual(file.content, ref.content, `${label} file[${i}] (${ref.path}) content`);
  });
}

// ─── Parity gate ────────────────────────────────────────────────

describe.each(PARITY_CASES)('parseDiffFiles parity %s', (name) => {
  it('is byte-identical to the frozen baseline (path, counts, content)', () => {
    const raw = fixture(name);
    expectHistoricalFieldParity(parseDiffFiles(raw), baselineParseDiffFiles(raw), name);
  });
});

describe('GATE 3.3 aggregate', () => {
  it('compares every parity case file-by-file at byte level (corpus is not empty)', () => {
    let comparedFiles = 0;
    let baselineBytes = 0;
    for (const name of PARITY_CASES) {
      const baseline = baselineParseDiffFiles(fixture(name));
      const current = parseDiffFiles(fixture(name));
      expectHistoricalFieldParity(current, baseline, name);
      comparedFiles += baseline.length;
      for (const f of baseline) baselineBytes += Buffer.byteLength(f.content, 'utf8');
    }
    // c01(3) c02(1) c04(2) c05(2) c06(1) c07(1) c08(1) c09(1) c10(1)
    // c11(1) c12(2) c13(0) c14(0) c15(2) c16(3) = 21 DiffFiles
    expect(comparedFiles).toBe(21);
    expect(baselineBytes).toBeGreaterThan(0);
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

    // Files untouched by the delta keep full historical-field parity.
    for (const i of [0, 1] as const) {
      expectHistoricalFieldParity([current[i]!], [baseline[i]!], `composite file[${i}]`);
    }

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

  it('face 3: TWO consecutive quoted files after a normal one (exact byte redistribution)', () => {
    const raw = fixture('m6-quoted-consecutive');

    // Baseline behavior, kept as evidence of the delta: neither quoted header
    // matches the legacy regex, so BOTH quoted sections (lines AND counters)
    // are glued onto src/normal.ts — one file carrying the whole fixture.
    const baseline = baselineParseDiffFiles(raw);
    expect(baseline.map((f) => f.path)).toEqual(['src/normal.ts']);
    expect(baseline[0]).toMatchObject({ additions: 3, deletions: 3 });
    expectByteEqual(baseline[0]!.content, raw, 'glued baseline content (entire fixture)');

    // New behavior: 3 clean files, unescaped paths, +1/-1 each.
    const current = parseDiffFiles(raw);
    expect(current.map((f) => f.path)).toEqual(['src/normal.ts', 'café.ts', 'niño.ts']);
    for (const f of current) {
      expect([f.additions, f.deletions], `${f.path} counters`).toEqual([1, 1]);
    }

    // Bytes are EXACTLY redistributed, none lost, none invented:
    // glued baseline === the 3 clean sections re-joined.
    expectByteEqual(
      baseline[0]!.content,
      current.map((f) => f.content).join('\n'),
      'consecutive-quoted byte redistribution',
    );
  });

  it('face 4: mixed-quoted headers ("a/x" b/y and a/x "b/y") — baseline drops, new parses', () => {
    const raw = fixture('m6-mixed-quoted');

    // Baseline: NEITHER mixed form matches /^diff --git a\/.+ b\/(.+)$/ —
    // the quoted-old form starts with `"a/` (not `a/`), and the quoted-new
    // form has no unquoted ` b/` occurrence. Whole fixture silently dropped.
    expect(baselineParseDiffFiles(raw)).toEqual([]);

    // New parser: both mixed forms parse; display path comes from `+++ b/`.
    const current = parseDiffFiles(raw);
    expect(current.map((f) => f.path)).toEqual(['x y.ts', 'x y.ts']);
    expect(current.map((f) => [f.additions, f.deletions])).toEqual([
      [1, 1],
      [1, 1],
    ]);

    // The structured model distinguishes the two forms via the a-side.
    const { files } = parseUnifiedDiff(raw);
    expect(files.map((f) => f.oldPath)).toEqual(['x y.ts', 'x.ts']);
  });
});

// ─── Adversarial: genuine EMPTY line mid-hunk ───────────────────
//
// Some upstreams (mail clients, copy-paste, trailing-whitespace strippers)
// remove the ' ' prefix of a blank context line, leaving a genuinely empty
// line inside a hunk body. This block PINS the new parser's DEFINED behavior
// because Phase 4 (recursive) will consume `hunk.lines` — this is the
// contract it builds on.

describe('adversarial: genuine empty line mid-hunk (stripped blank-context prefix)', () => {
  it('parseDiffFiles keeps FULL historical parity (counts/content come from rawLines)', () => {
    const raw = fixture('adv-empty-line-mid-hunk');
    expectHistoricalFieldParity(
      parseDiffFiles(raw),
      baselineParseDiffFiles(raw),
      'adv-empty-line-mid-hunk',
    );
  });

  it('DEFINED contract for hunk.lines: the empty line CLOSES the hunk; the tail stays in rawLines only', () => {
    const raw = fixture('adv-empty-line-mid-hunk');
    const { files } = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    const file = files[0]!;

    // The empty line does NOT kill the section: both @@ headers form hunks.
    expect(file.hunks).toHaveLength(2);

    // Hunk 1 contains ONLY the body lines BEFORE the empty line. The empty
    // line has no valid prefix, so it closes the hunk, and the +/-/context
    // lines AFTER it are NOT attributed to any hunk (orphaned tail).
    expect(file.hunks[0]!.lines.map((l) => l.raw)).toEqual([' antes', '-viejo', '+nuevo']);

    // The empty line AND the orphaned tail are preserved verbatim in
    // rawLines (byte-exact section slice — nothing is dropped).
    const gap = file.rawLines.indexOf('');
    expect(gap).toBeGreaterThan(-1);
    expect(file.rawLines.slice(gap, gap + 4)).toEqual(['', ' despues', '-viejo2', '+nuevo2']);

    // A subsequent @@ header RE-OPENS hunk parsing: hunk 2 is fully captured.
    expect(file.hunks[1]!.lines.map((l) => l.raw)).toEqual([' ctx', '-old', '+new']);

    // Spec R2 still holds: byte-exact reconstruction from rawLines.
    expectByteEqual(file.rawLines.join('\n'), raw, 'empty-line-mid-hunk reconstruction');
  });
});

// ─── Malformed-only divergence: header b-side ≠ +++ b-side ──────

describe('malformed-only divergence: `diff --git ... b/X` disagrees with `+++ b/Y`', () => {
  it('baseline resolves the header capture; new parser gives authority to `+++ b/`', () => {
    const raw = fixture('adv-header-b-mismatch');
    const baseline = baselineParseDiffFiles(raw);
    const current = parseDiffFiles(raw);

    // KNOWN divergence, MALFORMED INPUT ONLY: well-formed git/GitHub output
    // always has header b-side === `+++ b/` path, so this cannot trigger on
    // real diffs. On disagreement the new parser trusts `+++ b/` (authority
    // order `+++ b/` → `rename to` → header), the baseline trusted the header.
    expect(baseline.map((f) => f.path)).toEqual(['HEADER.ts']);
    expect(current.map((f) => f.path)).toEqual(['PLUS.ts']);

    // Everything EXCEPT the path stays byte-identical.
    const [b, c] = [baseline[0]!, current[0]!];
    expect(c.additions).toBe(b.additions);
    expect(c.deletions).toBe(b.deletions);
    expectByteEqual(c.content, b.content, 'header-b-mismatch content');
  });
});

// ─── Provenance: real GitHub API diff ───────────────────────────

describe('provenance: real GitHub API diff (gh api repos/JNZader/ghagga/pulls/209, vnd.github.v3.diff)', () => {
  it('old and new parser agree on the full 4-field historical surface', () => {
    const raw = fixture('provenance-gh-api-pr209');
    const baseline = baselineParseDiffFiles(raw);
    const current = parseDiffFiles(raw);

    // Corpus sanity: PR #209 touched 8 files — guards against a truncated
    // or accidentally regenerated fixture.
    expect(baseline).toHaveLength(8);
    expectHistoricalFieldParity(current, baseline, 'gh-api-pr209');
  });
});
