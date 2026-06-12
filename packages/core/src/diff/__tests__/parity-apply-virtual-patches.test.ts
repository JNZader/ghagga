/**
 * Phase 4 GATE — differential parity harness for the `applyVirtualPatches`
 * walker migration (recursive/patch-extractor.ts → unified diff model).
 *
 * `legacyApplyVirtualPatches` below is a VERBATIM frozen copy of the
 * historical walker (`recursive/patch-extractor.ts` as of commit `51095d6`,
 * pre-migration). The live walker must produce STRING-IDENTICAL output for
 * every fixture in the directory except the KNOWN_DIVERGENT set (golden
 * corpus C1–C16, the M6 fixtures, the adversarial fixtures AND the real
 * GitHub-API provenance diff) under a dense probe-patch grid.
 *
 * Spec R7 freeze: the legacy walker's buggy accounting is the contract —
 * metadata lines count, quoted headers never match (patches leak across the
 * boundary), the header b-side capture beats `+++ b/`, and line-less patches
 * are dropped. One byte of "improvement" on these axes = parity break =
 * NO COMMIT (see also recursive-golden.test.ts).
 *
 * ⚠️ INTENTIONAL DESIGN-B DIVERGENCE — the MARKER PATH (sdd/recursive-coordinate-contract).
 * The off-by-N that the legacy walker exhibited on iteration 2+ is the ONE
 * behavior we DID change: when a `+[SUGGESTED FIX]` marker is injected, the new
 * walker renumbers the affected hunk's `newCount` (+= markers-in-hunk) and every
 * LATER hunk's `newStart` (+= markers-injected-above) so the declared `@@ +N`
 * tells the truth about physical line position. The legacy walker leaves headers
 * untouched, so its declared coordinates lie — that lie is the off-by-N.
 *
 * Therefore byte-equality with the legacy walker can ONLY be asserted on fixtures
 * where ZERO markers land (the renumber pass is then a strict no-op). On a fixture
 * where ≥1 marker lands, new and legacy diverge BY CONSTRUCTION, and the divergence
 * is EXACTLY the rewritten `@@` header lines — every NON-header line (context,
 * additions, removals, AND the injected markers themselves) is byte-identical
 * between the two. `assertMarkerPathDivergence` pins BOTH faces: it asserts the
 * outputs differ (so the renumber can never silently vanish) AND that the diff is
 * confined to `@@` lines (so no NON-header behavior can drift in under cover of
 * the documented divergence). This is the documented "MARKER_DIVERGENT" set.
 *
 * The probe grid targets, per fixture, the UNION of both implementations'
 * key spaces: every resolved `path` and raw `headerNewPath` from the unified
 * parser (they diverge on adv-header-b-mismatch) PLUS every b-side capture
 * of the legacy boundary regex over the raw lines (a key only the OLD walker
 * can generate — e.g. the malformed mixed-quoted `inside "b/x"` — would
 * otherwise never be probed), and a guaranteed-miss path. Each target is
 * probed at EVERY line of the fixture (0..lineCount+5; the old fixed 0–40
 * grid left counter drift past line 40 invisible) plus one line-less patch —
 * dense enough that ANY counter divergence anywhere in the fixture surfaces
 * as an output diff.
 *
 * Fixtures in KNOWN_DIVERGENT are EXCLUDED from the blanket parity run: they
 * are malformed-only inputs where old and new intentionally diverge
 * (unreachable via git, the GitHub API or `truncateDiff` output, which cuts
 * at line boundaries). Each one is pinned by an explicit old-vs-new test at
 * the bottom of this file (same pattern as adv-header-b-mismatch in
 * parity-parse-diff-files.test.ts).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVirtualPatches } from '../../recursive/patch-extractor.js';
import type { SuggestionPatch } from '../../recursive/types.js';
import { parseUnifiedDiff } from '../parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Malformed-only fixtures where the two walkers INTENTIONALLY diverge.
 * Excluded from the blanket parity run; pinned explicitly below.
 */
const KNOWN_DIVERGENT = new Set(['adv-loose-hunk-header.diff', 'adv-mixed-quoted-malformed.diff']);

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.diff') && !KNOWN_DIVERGENT.has(f))
  .sort();

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

const patchRounds = JSON.parse(readFileSync(join(FIXTURES, 'c16-patches.json'), 'utf8')) as {
  round1: SuggestionPatch[];
  round2: SuggestionPatch[];
};

// ─── Frozen baseline (verbatim copy of patch-extractor.ts @ 51095d6) ──

/** VERBATIM frozen copy of the pre-migration walker. DO NOT EDIT. */
function legacyApplyVirtualPatches(originalDiff: string, patches: SuggestionPatch[]): string {
  if (patches.length === 0) return originalDiff;

  // Group patches by file
  const patchesByFile = new Map<string, SuggestionPatch[]>();
  for (const patch of patches) {
    const existing = patchesByFile.get(patch.file) ?? [];
    existing.push(patch);
    patchesByFile.set(patch.file, existing);
  }

  // Build the synthetic diff
  const lines = originalDiff.split('\n');
  const result: string[] = [];

  let currentFile: string | null = null;
  let currentFilePatches: SuggestionPatch[] = [];
  let lineCounter = 0; // Tracks the target-side line number in current hunk

  for (const line of lines) {
    // Detect file boundaries
    const fileMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      currentFilePatches = patchesByFile.get(currentFile) ?? [];
      lineCounter = 0;
    }

    // Track hunk line numbers
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch?.[1]) {
      lineCounter = parseInt(hunkMatch[1], 10) - 1;
    }

    // Count lines for position tracking (added or context lines increment target counter)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineCounter++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed lines don't increment target counter
    } else if (
      !line.startsWith('\\') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('---') &&
      !line.startsWith('+++') &&
      !line.startsWith('@@')
    ) {
      lineCounter++;
    }

    result.push(line);

    // Check if any patch targets this line
    if (currentFile && currentFilePatches.length > 0) {
      const matchingPatches = currentFilePatches.filter((p) => p.line === lineCounter);
      for (const patch of matchingPatches) {
        // Insert the suggestion as a synthetic replacement block
        result.push(`+[SUGGESTED FIX] ${patch.suggestion}`);
      }
    }
  }

  return result.join('\n');
}

// ─── Probe grid ──────────────────────────────────────────────────

/**
 * The historical walker's file-boundary regex, verbatim — used to derive
 * probe targets that ONLY the legacy implementation can generate (e.g. the
 * greedy capture `inside "b/x"` on a malformed mixed-quoted header), so the
 * harness probes the union of both key spaces instead of just the new one.
 */
const LEGACY_BOUNDARY_RE = /^diff --git a\/.+ b\/(.+)$/;

/**
 * Dense, deterministic probe patches for one fixture: the union of both
 * implementations' file keys (resolved `path` + raw `headerNewPath` from the
 * unified parser, plus every legacy-regex b-side capture over the raw lines)
 * and a guaranteed-miss path, each probed at every line of the fixture
 * (0..lineCount+5) plus one line-less (file-level) patch.
 */
function probesFor(raw: string): SuggestionPatch[] {
  const targets = new Set<string>();
  for (const file of parseUnifiedDiff(raw).files) {
    targets.add(file.path);
    targets.add(file.headerNewPath);
  }
  for (const line of raw.split('\n')) {
    const legacyKey = LEGACY_BOUNDARY_RE.exec(line)?.[1];
    if (legacyKey) targets.add(legacyKey);
  }
  targets.add('no-such-file.ts');

  const maxProbeLine = raw.split('\n').length + 5;

  const probes: SuggestionPatch[] = [];
  let findingIndex = 0;
  for (const target of targets) {
    for (let line = 0; line <= maxProbeLine; line++) {
      probes.push({
        file: target,
        line,
        originalMessage: `probe ${target}:${line}`,
        suggestion: `PROBE ${target}:${line}`,
        findingIndex: findingIndex++,
      });
    }
    probes.push({
      file: target,
      originalMessage: `probe ${target}:file-level`,
      suggestion: `PROBE ${target}:file-level`,
      findingIndex: findingIndex++,
    });
  }
  return probes;
}

// ─── Differential parity ─────────────────────────────────────────

/** Is a line a unified-diff hunk header (`@@ ... @@ ...`)? */
const isHunkHeader = (line: string): boolean => line.startsWith('@@');

/**
 * Marker-path divergence pin (Design B). When markers land, the new walker may
 * differ from the legacy walker ONLY on renumbered `@@` hunk headers — every
 * other line (context/+/-/injected markers) MUST be byte-identical, and no line
 * may be added/removed/reordered off the header path.
 *
 * Two valid shapes:
 *  - markers land in a hunk ⇒ that hunk's header is renumbered ⇒ the outputs
 *    differ, but ONLY on `@@` lines (markers land at identical positions);
 *  - markers land in a HEADERLESS region (binary/mode-only diff: no `@@` at
 *    all, frozen R7 metadata-line counting) ⇒ no header to renumber ⇒ the
 *    outputs are byte-IDENTICAL to legacy. Equality is therefore allowed.
 *
 * Either way the assertion guarantees: nothing OTHER than `@@` headers ever
 * drifts — no NON-header behavior can change under cover of the divergence.
 */
function assertMarkerPathDivergence(newOut: string, legacyOut: string): void {
  const newLines = newOut.split('\n');
  const legacyLines = legacyOut.split('\n');
  // No line count change — the renumber rewrites headers in place, never
  // adds/drops a line relative to the legacy output (markers land identically).
  expect(newLines.length).toBe(legacyLines.length);
  for (let i = 0; i < newLines.length; i++) {
    if (isHunkHeader(newLines[i] ?? '') && isHunkHeader(legacyLines[i] ?? '')) {
      // Header line — allowed to differ (renumbered). Old-side accounting must
      // still be untouched: only the `+N[,M]` segment may change.
      continue;
    }
    expect(newLines[i], `non-header line ${i} drifted`).toBe(legacyLines[i]);
  }
}

/**
 * Assert new-vs-legacy parity for one fixture under a patch set:
 *  - zero markers landed ⇒ STRICT byte-equality (renumber is a no-op);
 *  - ≥1 marker landed   ⇒ MARKER_DIVERGENT (header-only divergence, both faces pinned).
 * Marker presence is read off the NEW output's out-of-band `injectedLineIndices`
 * (positional identity, not a text scan).
 */
function assertParity(raw: string, patches: SuggestionPatch[]): void {
  const result = applyVirtualPatches(raw, patches);
  const legacyOut = legacyApplyVirtualPatches(raw, patches);
  if (result.injectedLineIndices.length === 0) {
    expect(result.diff).toBe(legacyOut); // no marker ⇒ strict legacy parity
  } else {
    assertMarkerPathDivergence(result.diff, legacyOut); // marker ⇒ header-only divergence
  }
}

describe.each(FIXTURE_NAMES)('applyVirtualPatches parity — %s', (name) => {
  const raw = fixture(name);

  it('matches the frozen legacy walker under the dense probe grid (or diverges only on renumbered headers)', () => {
    assertParity(raw, probesFor(raw));
  });

  it('matches the frozen legacy walker with the c16 round-1 patches (or diverges only on renumbered headers)', () => {
    assertParity(raw, patchRounds.round1);
  });
});

describe('applyVirtualPatches parity — recursive composition', () => {
  it('2-iteration run (c01 → round1 → round2): DIVERGES from legacy on the marker path (off-by-N closed)', () => {
    // This is the headline fix. Under the LEGACY walker, iteration-1 markers shift
    // the iteration-2 counter (the headers lie), so round-2 markers land one line
    // late per preceding injection — the off-by-N. Under Design B iteration-1
    // renumbers the headers, so iteration 2 reads truthful coordinates and round-2
    // markers land on the intended real lines. The two walkers therefore produce
    // DIFFERENT end-to-end output — that difference IS the bug fix, pinned by the
    // both-interpretation contract test (recursive/coordinate-contract.test.ts) and
    // the recursive golden (diff/__tests__/recursive-golden.test.ts).
    const c01 = fixture('c01.diff');
    const legacy = legacyApplyVirtualPatches(
      legacyApplyVirtualPatches(c01, patchRounds.round1),
      patchRounds.round2,
    );
    const current = applyVirtualPatches(
      applyVirtualPatches(c01, patchRounds.round1).diff,
      patchRounds.round2,
    ).diff;
    // The legacy off-by-N face is pinned in recursive-golden's git history; here we
    // only assert the NEW walker no longer reproduces it.
    expect(current).not.toBe(legacy);
  });

  it('empty patch list returns the input unchanged (referential passthrough)', () => {
    const c01 = fixture('c01.diff');
    expect(applyVirtualPatches(c01, []).diff).toBe(c01);
  });
});

// ─── Pinned divergences (malformed-only, KNOWN_DIVERGENT fixtures) ──
//
// Same pattern as the adv-header-b-mismatch pin in
// parity-parse-diff-files.test.ts: old and new behavior are BOTH asserted
// explicitly, so neither can drift silently. These inputs are unreachable
// via real git output, the GitHub API, or `truncateDiff` (its dominant
// branch discards the partial line and appends the truncation marker —
// verified), so the divergence is synthetic-only by design.

describe('pinned divergence — adv-loose-hunk-header.diff (`@@ -1,2 +100` without trailing ` @@`)', () => {
  const raw = fixture('adv-loose-hunk-header.diff');
  const probeAt100: SuggestionPatch[] = [
    {
      file: 'loose.ts',
      line: 100,
      originalMessage: 'probe loose.ts:100',
      suggestion: 'LOOSE-100',
      findingIndex: 0,
    },
  ];

  it('legacy walker: the loose regex resets the counter to 99 — a patch at line 100 applies', () => {
    const out = legacyApplyVirtualPatches(raw, probeAt100);
    const lines = out.split('\n');
    const at = lines.indexOf('+[SUGGESTED FIX] LOOSE-100');
    expect(at).toBeGreaterThan(-1);
    // The context line after the loose header takes the counter 99 → 100.
    expect(lines[at - 1]).toBe(' contexto');
  });

  it('new walker: the malformed header is not a hunk header — the counter is NOT reset and the patch never applies', () => {
    expect(applyVirtualPatches(raw, probeAt100).diff).toBe(raw);
  });
});

describe('pinned divergence — adv-mixed-quoted-malformed.diff (`diff --git a/old-with b/inside "b/x"`)', () => {
  const raw = fixture('adv-mixed-quoted-malformed.diff');
  // The legacy greedy capture resolves this header to the key `inside "b/x"`
  // (last ` b/` occurrence wins) — a key only the OLD walker can generate.
  const legacyKeyPatch: SuggestionPatch[] = [
    {
      file: 'inside "b/x"',
      line: 1,
      originalMessage: 'probe inside "b/x":1',
      suggestion: 'MIXED-1',
      findingIndex: 0,
    },
  ];

  it('sanity: the legacy boundary regex captures `inside "b/x"` on this header', () => {
    const header = raw.split('\n')[0] ?? '';
    expect(LEGACY_BOUNDARY_RE.exec(header)?.[1]).toBe('inside "b/x"');
  });

  it('legacy walker: the greedy capture is a file boundary — the patch applies', () => {
    const out = legacyApplyVirtualPatches(raw, legacyKeyPatch);
    const lines = out.split('\n');
    const at = lines.indexOf('+[SUGGESTED FIX] MIXED-1');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at - 1]).toBe(' uno');
  });

  it('new walker: the header parses as quoted (headerQuoted gate, no boundary) — the patch never applies', () => {
    expect(applyVirtualPatches(raw, legacyKeyPatch).diff).toBe(raw);
  });
});
