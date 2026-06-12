/**
 * Phase 4 GATE — differential parity harness for the `applyVirtualPatches`
 * walker migration (recursive/patch-extractor.ts → unified diff model).
 *
 * `legacyApplyVirtualPatches` below is a VERBATIM frozen copy of the
 * historical walker (`recursive/patch-extractor.ts` as of commit `51095d6`,
 * pre-migration). The live walker must produce STRING-IDENTICAL output for
 * every fixture in the directory (golden corpus C1–C16, the M6 fixtures,
 * the adversarial fixtures AND the real GitHub-API provenance diff) under a
 * dense probe-patch grid.
 *
 * Spec R7 freeze: the legacy walker's buggy accounting is the contract —
 * metadata lines count, quoted headers never match (patches leak across the
 * boundary), `+[SUGGESTED FIX]` lines from a previous iteration shift the
 * counter (off-by-N), the header b-side capture beats `+++ b/`, and
 * line-less patches are dropped. One byte of "improvement" = parity break =
 * NO COMMIT (see also recursive-golden.test.ts).
 *
 * The probe grid targets, per fixture: every resolved `path`, every raw
 * `headerNewPath` (they diverge on adv-header-b-mismatch) and a miss path,
 * each at lines 0–40 plus one line-less patch — dense enough that ANY
 * counter divergence anywhere in the fixture surfaces as an output diff.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVirtualPatches } from '../../recursive/patch-extractor.js';
import type { SuggestionPatch } from '../../recursive/types.js';
import { parseUnifiedDiff } from '../parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.diff'))
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
 * Dense, deterministic probe patches for one fixture: every resolved path,
 * every raw header b-side capture and a guaranteed-miss path, each probed at
 * lines 0–40 plus one line-less (file-level) patch.
 */
function probesFor(raw: string): SuggestionPatch[] {
  const targets = new Set<string>();
  for (const file of parseUnifiedDiff(raw).files) {
    targets.add(file.path);
    targets.add(file.headerNewPath);
  }
  targets.add('no-such-file.ts');

  const probes: SuggestionPatch[] = [];
  let findingIndex = 0;
  for (const target of targets) {
    for (let line = 0; line <= 40; line++) {
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

describe.each(FIXTURE_NAMES)('applyVirtualPatches parity — %s', (name) => {
  const raw = fixture(name);

  it('matches the frozen legacy walker under the dense probe grid', () => {
    const probes = probesFor(raw);
    expect(applyVirtualPatches(raw, probes)).toBe(legacyApplyVirtualPatches(raw, probes));
  });

  it('matches the frozen legacy walker with the c16 round-1 patches', () => {
    expect(applyVirtualPatches(raw, patchRounds.round1)).toBe(
      legacyApplyVirtualPatches(raw, patchRounds.round1),
    );
  });
});

describe('applyVirtualPatches parity — recursive composition', () => {
  it('2-iteration run (c01 → round1 → round2) matches the legacy walker end-to-end', () => {
    const c01 = fixture('c01.diff');
    const legacy = legacyApplyVirtualPatches(
      legacyApplyVirtualPatches(c01, patchRounds.round1),
      patchRounds.round2,
    );
    const current = applyVirtualPatches(
      applyVirtualPatches(c01, patchRounds.round1),
      patchRounds.round2,
    );
    expect(current).toBe(legacy);
  });

  it('empty patch list returns the input unchanged (referential passthrough)', () => {
    const c01 = fixture('c01.diff');
    expect(applyVirtualPatches(c01, [])).toBe(c01);
  });
});
