/**
 * Phase 5 gate (task 5.1) — parity harness for `parseHunks`
 * (scope/diff-mapper.ts) over the golden corpus + adversarial fixtures.
 *
 * `baselineParseHunks` below is a VERBATIM frozen copy of the historical
 * implementation (scope/diff-mapper.ts as of commit `861d48e`, pre-adapter).
 * The live `parseHunks` must produce structurally identical output (the 4
 * captures, in input order) for every fixture and for bare hunk fragments
 * (diff content WITHOUT any `diff --git` header — a documented input shape:
 * "raw unified diff content for a single file").
 *
 * Expected divergences vs the baseline: NONE on any fixture. The only
 * divergence class is synthetic-only (legacy `\s+` separators vs the strict
 * single-space regex of the unified model) and is pinned explicitly when the
 * adapter lands (Phase 5 task 5.2) — git never emits those forms.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHunks } from '../../scope/diff-mapper.js';
import type { DiffHunk } from '../../scope/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.diff`), 'utf8');
}

/** Every .diff fixture in the corpus, golden and adversarial alike. */
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

// ─── Frozen baseline (verbatim copy of scope/diff-mapper.ts @ 861d48e) ──

const BASELINE_HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** VERBATIM frozen copy of the pre-adapter parseHunks. DO NOT EDIT. */
function baselineParseHunks(diffContent: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffContent.split('\n');

  for (const line of lines) {
    const match = BASELINE_HUNK_HEADER_RE.exec(line);
    if (match) {
      hunks.push({
        oldStart: Number.parseInt(match[1]!, 10),
        oldCount: match[2] !== undefined ? Number.parseInt(match[2], 10) : 1,
        newStart: Number.parseInt(match[3]!, 10),
        newCount: match[4] !== undefined ? Number.parseInt(match[4], 10) : 1,
      });
    }
  }

  return hunks;
}

// ─── Parity gate ────────────────────────────────────────────────

describe.each(ALL_FIXTURES)('parseHunks parity %s', (name) => {
  it('is structurally identical to the frozen baseline', () => {
    const raw = fixture(name);
    expect(parseHunks(raw)).toEqual(baselineParseHunks(raw));
  });
});

describe('parity on bare hunk fragments (no `diff --git` header at all)', () => {
  // The documented input is "raw unified diff content for a single file",
  // which may be a fragment starting directly at an `@@` header. The unified
  // model keeps such lines in `preamble` — the adapter must still find them.
  const FRAGMENTS: Array<[string, string]> = [
    ['single hunk with section heading', '@@ -10,5 +10,7 @@ function foo()\n ctx\n+add\n ctx'],
    ['short form without counts', '@@ -1 +1 @@\n-a\n+b'],
    ['zero-context insertion', '@@ -5,0 +6,2 @@\n+x\n+y'],
    [
      'multiple fragments back to back',
      '@@ -5,2 +5,3 @@ first\n line\n+six\n@@ -20,2 +21,5 @@ second\n line\n+code',
    ],
    ['hunks after prose preamble', 'some prose first\nmore prose\n@@ -3,2 +3,2 @@\n-x\n+y'],
    [
      'fragment followed by a real file section',
      '@@ -1,2 +1,2 @@ bare\n-a\n+b\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -7,1 +7,2 @@\n ctx\n+add',
    ],
  ];

  it.each(FRAGMENTS)('%s', (_label, raw) => {
    expect(parseHunks(raw)).toEqual(baselineParseHunks(raw));
  });
});

describe('gate 5.1 aggregate (non-vacuous)', () => {
  it('the corpus exercises a meaningful number of hunks', () => {
    let total = 0;
    for (const name of ALL_FIXTURES) total += baselineParseHunks(fixture(name)).length;
    // c01(6) alone has multiple hunks; the full corpus is far above zero.
    expect(total).toBeGreaterThan(20);
    // And the live implementation agrees on the total.
    let live = 0;
    for (const name of ALL_FIXTURES) live += parseHunks(fixture(name)).length;
    expect(live).toBe(total);
  });
});
