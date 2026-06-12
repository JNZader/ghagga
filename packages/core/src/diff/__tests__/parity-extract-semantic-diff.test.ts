/**
 * Phase 7 gate (task 7.1) — parity harness for `extractSemanticDiff`
 * (semantic-diff/index.ts) over the golden corpus + adversarial fixtures.
 *
 * `baselineExtractSemanticDiff` below is a VERBATIM frozen copy of the
 * COMPLETE historical pipeline (semantic-diff/index.ts as of commit
 * `eaf05c9`, pre-adapter): declaration patterns, the section splitter
 * (`split(/^diff --git /m)`), per-section path resolution, change
 * derivation and summary building. The live `extractSemanticDiff` must
 * produce deeply equal output for every fixture and for bare/garbage
 * inputs without any `diff --git` header (the historical splitter kept
 * pre-header content as a pseudo-section and scanned its +/- lines).
 *
 * Expected divergences vs the baseline:
 *   - filePath deltas: quoted headers resolving to a real path under the
 *     CORE-M6 umbrella, and synthetic-only malformed-header boundaries —
 *     pinned explicitly below (Phase 7 task 7.2).
 *   - summary-kinds fix (deliberate, post-freeze): the baseline reproduces
 *     two historical bugs that the live implementation has since fixed:
 *       (A) buildSummary passed `import_added`/`export_added` as the
 *           group's modifiedKind (the `*_modified` members did not exist),
 *           so every added import/export was ALSO counted as modified; and
 *           modified imports/exports (name on both +/- sides) fell into the
 *           false branch of a two-way ternary → `import_removed`/
 *           `export_removed`.
 *       (B) mapToChangeKind returned `function_modified` for modified
 *           classes (no `class_modified` member), and buildSummary used
 *           `function_modified` as the class group's modifiedKind, so every
 *           modified FUNCTION was also counted as "N class modified".
 *     The divergence is CONFINED by `assertConfinedDivergence`: change sets
 *     are identical except for the three pinned kind rewrites
 *     (function_modified→class_modified for classes, import_removed→
 *     import_modified, export_removed→export_modified), and the summary may
 *     differ from the baseline only when one of the affected kinds is
 *     present — in which case it must equal the frozen FIXED summary
 *     expectation (`fixedBuildSummary`). Everything else stays byte-equal.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EntityChange, EntityChangeKind, SemanticDiff } from '../../semantic-diff/index.js';
import { extractSemanticDiff } from '../../semantic-diff/index.js';

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

// ─── Frozen baseline (verbatim copy of semantic-diff/index.ts @ eaf05c9) ──
// DO NOT EDIT anything inside this block.

type BaselineDeclKind = 'function' | 'class' | 'method' | 'import' | 'export' | 'type';

const BASELINE_DECLARATION_PATTERNS: Array<{
  kind: BaselineDeclKind;
  pattern: RegExp;
}> = [
  // import statements — match before export/function to avoid conflicts
  {
    kind: 'import',
    pattern:
      /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+['"][^'"]+['"]/,
  },
  // export type / interface / enum (before the generic export rule)
  {
    kind: 'type',
    pattern: /^\s*export\s+(?:type|interface|enum)\s+(\w+)/,
  },
  // standalone type / interface / enum
  {
    kind: 'type',
    pattern: /^\s*(?:type|interface|enum)\s+(\w+)/,
  },
  // class declaration (handles `export class` and `export abstract class`)
  {
    kind: 'class',
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
  },
  // top-level function declaration (handles `export function` / `export async function`)
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/,
  },
  // arrow / function-expression assigned to const/let/var
  {
    kind: 'function',
    pattern:
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>,\s|[\]]+?)?\s*=\s*(?:async\s+)?(?:function\b|\()/,
  },
  // method inside class (indented + no leading "function" keyword, has "()")
  {
    kind: 'method',
    pattern: /^[ \t]+(?:(?:public|private|protected|static|async|override|readonly)\s+)*(\w+)\s*\(/,
  },
  // generic export of a plain value — LAST so the rules above win first
  {
    kind: 'export',
    pattern: /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/,
  },
];

function baselineExtractDeclaration(line: string): { kind: BaselineDeclKind; name: string } | null {
  for (const { kind, pattern } of BASELINE_DECLARATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (kind === 'import') {
        const fromMatch = /from\s+['"]([^'"]+)['"]/.exec(line);
        return { kind, name: fromMatch?.[1] ?? line.trim().slice(0, 40) };
      }
      const name = match[1];
      if (name) return { kind, name };
    }
  }
  return null;
}

interface BaselineHunkSet {
  added: Map<string, { name: string; signature: string; kind: BaselineDeclKind }>;
  removed: Map<string, { name: string; signature: string; kind: BaselineDeclKind }>;
  filePath: string;
}

/** VERBATIM frozen copy of the historical local parseHunks. DO NOT EDIT. */
function baselineParseHunks(unifiedDiff: string): BaselineHunkSet[] {
  const result: BaselineHunkSet[] = [];
  const sections = unifiedDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const pathMatch = /a\/.+ b\/(.+)$/.exec(section.split('\n')[0] ?? '');
    const filePath = pathMatch?.[1] ?? 'unknown';

    const added: BaselineHunkSet['added'] = new Map();
    const removed: BaselineHunkSet['removed'] = new Map();

    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const content = line.slice(1);
        const decl = baselineExtractDeclaration(content);
        if (decl) {
          added.set(decl.name, { name: decl.name, signature: content.trim(), kind: decl.kind });
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const content = line.slice(1);
        const decl = baselineExtractDeclaration(content);
        if (decl) {
          removed.set(decl.name, { name: decl.name, signature: content.trim(), kind: decl.kind });
        }
      }
    }

    result.push({ filePath, added, removed });
  }

  return result;
}

function baselineMapToChangeKind(
  category: BaselineDeclKind,
  direction: 'added' | 'removed' | 'modified',
): EntityChangeKind {
  switch (category) {
    case 'function':
      return direction === 'added'
        ? 'function_added'
        : direction === 'removed'
          ? 'function_removed'
          : 'function_modified';
    case 'class':
      return direction === 'added'
        ? 'class_added'
        : direction === 'removed'
          ? 'class_removed'
          : 'function_modified';
    case 'method':
      return direction === 'added'
        ? 'method_added'
        : direction === 'removed'
          ? 'method_removed'
          : 'method_modified';
    case 'import':
      return direction === 'added' ? 'import_added' : 'import_removed';
    case 'export':
      return direction === 'added' ? 'export_added' : 'export_removed';
    case 'type':
      return direction === 'added'
        ? 'type_added'
        : direction === 'removed'
          ? 'type_removed'
          : 'type_modified';
  }
}

function baselineBuildSummary(changes: EntityChange[]): string {
  const counts: Partial<Record<EntityChangeKind, number>> = {};
  for (const c of changes) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  const parts: string[] = [];

  const groupSummary = (
    addedKind: EntityChangeKind,
    removedKind: EntityChangeKind,
    modifiedKind: EntityChangeKind,
    label: string,
  ) => {
    const added = counts[addedKind] ?? 0;
    const removed = counts[removedKind] ?? 0;
    const modified = counts[modifiedKind] ?? 0;
    if (added) parts.push(`${added} ${label} added`);
    if (removed) parts.push(`${removed} ${label} removed`);
    if (modified) parts.push(`${modified} ${label} modified`);
  };

  groupSummary('function_added', 'function_removed', 'function_modified', 'function');
  groupSummary('class_added', 'class_removed', 'function_modified', 'class');
  groupSummary('method_added', 'method_removed', 'method_modified', 'method');
  groupSummary('import_added', 'import_removed', 'import_added', 'import');
  groupSummary('export_added', 'export_removed', 'export_added', 'export');
  groupSummary('type_added', 'type_removed', 'type_modified', 'type');

  if (parts.length === 0) return 'no entity-level changes detected';
  return parts.join(', ');
}

/** VERBATIM frozen copy of the pre-adapter extractSemanticDiff. DO NOT EDIT. */
function baselineExtractSemanticDiff(unifiedDiff: string): SemanticDiff {
  const hunkSets = baselineParseHunks(unifiedDiff);
  const changes: EntityChange[] = [];

  for (const { filePath, added, removed } of hunkSets) {
    for (const [name, addedDecl] of added) {
      if (removed.has(name)) {
        const removedDecl = removed.get(name);
        const kind = baselineMapToChangeKind(addedDecl.kind, 'modified');
        changes.push({
          kind,
          name,
          filePath,
          oldSignature: removedDecl?.signature,
          newSignature: addedDecl.signature,
        });
      } else {
        const kind = baselineMapToChangeKind(addedDecl.kind, 'added');
        changes.push({ kind, name, filePath, newSignature: addedDecl.signature });
      }
    }

    for (const [name, removedDecl] of removed) {
      if (!added.has(name)) {
        const kind = baselineMapToChangeKind(removedDecl.kind, 'removed');
        changes.push({ kind, name, filePath, oldSignature: removedDecl.signature });
      }
    }
  }

  return { changes, summary: baselineBuildSummary(changes) };
}

// ─── Confined-divergence harness (summary-kinds fix) ────────────
//
// Precedent: `assertMarkerPathDivergence` in parity-apply-virtual-patches
// — scope the legacy equality to what did NOT change and pin the expected
// divergence explicitly, instead of deleting the harness.

/**
 * The ONLY kind rewrites the live implementation may produce relative to
 * the frozen baseline (baselineKind → liveKind):
 *  - modified class:  baseline collapsed to function_modified (no
 *    class_modified member existed) → live class_modified;
 *  - modified import: baseline fell into the false ternary branch →
 *    import_removed → live import_modified;
 *  - modified export: same shape → export_removed → live export_modified.
 */
const ALLOWED_KIND_DIVERGENCE: ReadonlyArray<readonly [EntityChangeKind, EntityChangeKind]> = [
  ['function_modified', 'class_modified'],
  ['import_removed', 'import_modified'],
  ['export_removed', 'export_modified'],
];

/**
 * Kinds whose presence changed the SUMMARY under the historical bugs even
 * when every per-change kind is identical: the baseline double-counted
 * added imports/exports as "modified" (modifiedKind = addedKind) and
 * cross-counted every function_modified as "N class modified".
 */
const SUMMARY_AFFECTED_KINDS: ReadonlySet<EntityChangeKind> = new Set([
  'function_modified',
  'class_modified',
  'import_added',
  'import_modified',
  'export_added',
  'export_modified',
]);

/**
 * FROZEN EXPECTED summary for the live implementation — a verbatim copy of
 * the FIXED buildSummary (semantic-diff/index.ts post summary-kinds fix),
 * mirroring how `baselineBuildSummary` freezes the historical one. DO NOT
 * sync with future impl changes without re-pinning.
 */
function fixedBuildSummary(changes: EntityChange[]): string {
  const counts: Partial<Record<EntityChangeKind, number>> = {};
  for (const c of changes) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  const parts: string[] = [];

  const groupSummary = (
    addedKind: EntityChangeKind,
    removedKind: EntityChangeKind,
    modifiedKind: EntityChangeKind,
    label: string,
  ) => {
    const added = counts[addedKind] ?? 0;
    const removed = counts[removedKind] ?? 0;
    const modified = counts[modifiedKind] ?? 0;
    if (added) parts.push(`${added} ${label} added`);
    if (removed) parts.push(`${removed} ${label} removed`);
    if (modified) parts.push(`${modified} ${label} modified`);
  };

  groupSummary('function_added', 'function_removed', 'function_modified', 'function');
  groupSummary('class_added', 'class_removed', 'class_modified', 'class');
  groupSummary('method_added', 'method_removed', 'method_modified', 'method');
  groupSummary('import_added', 'import_removed', 'import_modified', 'import');
  groupSummary('export_added', 'export_removed', 'export_modified', 'export');
  groupSummary('type_added', 'type_removed', 'type_modified', 'type');

  if (parts.length === 0) return 'no entity-level changes detected';
  return parts.join(', ');
}

/**
 * Live output may diverge from the frozen baseline ONLY on the
 * summary-kinds surface:
 *  1. change sets are identical (names, filePaths, signatures, ORDER,
 *     length) once `kind` is masked;
 *  2. every kind mismatch is one of the three pinned rewrites;
 *  3. the summary is byte-equal to the baseline's unless an affected kind
 *     is present — then it must equal the frozen FIXED expectation.
 * No other behavior can drift under cover of the documented divergence.
 */
function assertConfinedDivergence(live: SemanticDiff, baseline: SemanticDiff): void {
  const maskKind = (c: EntityChange) => ({ ...c, kind: 'MASKED' as const });
  expect(live.changes.map(maskKind)).toEqual(baseline.changes.map(maskKind));

  let kindDiverged = false;
  for (let i = 0; i < baseline.changes.length; i++) {
    const baselineChange = baseline.changes[i];
    const liveChange = live.changes[i];
    if (!baselineChange || !liveChange) continue; // lengths pinned equal above
    if (liveChange.kind !== baselineChange.kind) {
      kindDiverged = true;
      expect(
        ALLOWED_KIND_DIVERGENCE.some(
          ([from, to]) => from === baselineChange.kind && to === liveChange.kind,
        ),
        `change ${i} (${baselineChange.name}): kind diverged ${baselineChange.kind} → ${liveChange.kind} outside the pinned pairs`,
      ).toBe(true);
    }
  }

  const summaryMayDiverge =
    kindDiverged || live.changes.some((c) => SUMMARY_AFFECTED_KINDS.has(c.kind));
  if (summaryMayDiverge) {
    expect(live.summary).toBe(fixedBuildSummary(live.changes));
  } else {
    expect(live.summary).toBe(baseline.summary);
  }
}

// ─── Parity gate ────────────────────────────────────────────────

describe.each(ALL_FIXTURES)('extractSemanticDiff parity %s', (name) => {
  it('matches the frozen baseline up to the pinned summary-kinds divergence', () => {
    const raw = fixture(name);
    assertConfinedDivergence(extractSemanticDiff(raw), baselineExtractSemanticDiff(raw));
  });
});

describe('parity on inputs without any diff --git header (legacy pseudo-section)', () => {
  // The historical splitter kept everything before the first `diff --git `
  // line as a section of its own and scanned its +/- lines — reachable via
  // arbitrary ACP input and bare diff fragments.
  const BARE_INPUTS: Array<[string, string]> = [
    [
      'bare fragment with declarations',
      '@@ -1,3 +1,3 @@\n-export function oldHelper(a: string) {\n+export function newHelper(a: string) {\n ctx',
    ],
    [
      'prose followed by +/- declaration lines',
      'review summary:\n+export const added = () => {}\n-import { gone } from "./gone"',
    ],
    [
      'first line matching the legacy section-path tail (a/x b/y)',
      'see a/old.ts b/resolved.ts\n+export function fromPseudoSection() {',
    ],
    [
      'pseudo-section followed by a real file',
      '+function preludeDecl() {\ndiff --git a/real.ts b/real.ts\n--- a/real.ts\n+++ b/real.ts\n@@ -1,1 +1,2 @@\n ctx\n+export function inFile() {',
    ],
  ];

  it.each(BARE_INPUTS)('%s', (_label, raw) => {
    assertConfinedDivergence(extractSemanticDiff(raw), baselineExtractSemanticDiff(raw));
  });

  it('empty and newline-only inputs stay empty', () => {
    for (const raw of ['', '\n']) {
      expect(extractSemanticDiff(raw)).toEqual(baselineExtractSemanticDiff(raw));
      expect(extractSemanticDiff(raw).changes).toEqual([]);
    }
  });
});

// ─── Documented deltas vs the historical splitter (pinned old-vs-new) ──

describe('CORE-M6 umbrella — quoted headers now resolve a real filePath', () => {
  // Historically the quoted section EXISTED (the splitter fires on any line
  // starting with `diff --git `) but its path never matched the legacy tail
  // regex → declarations were attributed to 'unknown'. The unified model
  // parses and unescapes the quoted header (CORE-M6, changelog: minor).
  const QUOTED_WITH_DECL = [
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    'index 49de013..11c4483 100644',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
    '@@ -1,2 +1,2 @@',
    ' contexto',
    '+export function dentroDeQuoted() {',
  ].join('\n');

  it('baseline attributed the declaration to unknown; live resolves café.ts', () => {
    const baseline = baselineExtractSemanticDiff(QUOTED_WITH_DECL);
    const live = extractSemanticDiff(QUOTED_WITH_DECL);

    expect(baseline.changes).toEqual([
      expect.objectContaining({
        kind: 'function_added',
        name: 'dentroDeQuoted',
        filePath: 'unknown',
      }),
    ]);
    expect(live.changes).toEqual([
      expect.objectContaining({
        kind: 'function_added',
        name: 'dentroDeQuoted',
        filePath: 'café.ts',
      }),
    ]);
    // Everything except the filePath is identical.
    expect(live.summary).toBe(baseline.summary);
  });
});

describe('CORE-M6 umbrella — quoted sections WITH declarations, full old-vs-new (3vr fix-forward)', () => {
  // Codex 3vr finding: the corpus quoted fixtures carry no declaration
  // lines, so the blanket parity never exercised declaration EXTRACTION
  // inside quoted sections. This composite pins the complete surface:
  // everything except the quoted filePaths must be identical (names, kinds,
  // signatures, order, summary).
  const COMPOSITE = [
    'diff --git a/src/normal.ts b/src/normal.ts',
    'index 1111111..2222222 100644',
    '--- a/src/normal.ts',
    '+++ b/src/normal.ts',
    '@@ -1,3 +1,3 @@',
    ' uno',
    '-export function enNormal(a: string) {',
    '+export function enNormal(a: string, b: number) {',
    ' tres',
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    'index 49de013..11c4483 100644',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
    '@@ -1,2 +1,3 @@',
    ' contexto',
    '+export function enCafe() {',
    'diff --git "a/ni\\303\\261o.ts" "b/ni\\303\\261o.ts"',
    'index 3333333..4444444 100644',
    '--- "a/ni\\303\\261o.ts"',
    '+++ "b/ni\\303\\261o.ts"',
    '@@ -1,2 +1,1 @@',
    ' linea',
    "-import { gone } from './gone'",
  ].join('\n');

  it('declaration extraction inside quoted sections matches the baseline except filePath', () => {
    const baseline = baselineExtractSemanticDiff(COMPOSITE);
    const live = extractSemanticDiff(COMPOSITE);

    // Same changes, same order, same kinds/names/signatures — masking the
    // filePath, both outputs must be deeply identical.
    const mask = (c: EntityChange) => ({ ...c, filePath: 'MASKED' });
    expect(live.changes.map(mask)).toEqual(baseline.changes.map(mask));

    // Summary-kinds divergence (pinned): the function_modified change made
    // the BASELINE also count "1 class modified" (class group keyed its
    // modifiedKind off function_modified); the live summary no longer does.
    expect(baseline.summary).toBe(
      '1 function added, 1 function modified, 1 class modified, 1 import removed',
    );
    expect(live.summary).toBe('1 function added, 1 function modified, 1 import removed');

    // The ONLY delta: quoted sections historically resolved 'unknown'.
    expect(baseline.changes.map((c) => c.filePath)).toEqual([
      'src/normal.ts',
      'unknown',
      'unknown',
    ]);
    expect(live.changes.map((c) => c.filePath)).toEqual(['src/normal.ts', 'café.ts', 'niño.ts']);

    // And the extraction itself is non-trivial (kinds actually exercised).
    expect(live.changes.map((c) => c.kind)).toEqual([
      'function_modified',
      'function_added',
      'import_removed',
    ]);
  });
});

describe('KNOWN synthetic-only divergences: malformed header boundaries (pinned)', () => {
  it('mixed-quoted malformed header: legacy greedy capture vs model b-side', () => {
    // Same header shape as adv-mixed-quoted-malformed.diff, plus a
    // declaration so the filePath delta becomes observable. The legacy tail
    // regex greedily captured `inside "b/x"`; the model parses the
    // quoted-new form and resolves `x`. Hand-crafted only — git never emits
    // a path containing an unquoted ` b/` alongside a quoted b-side.
    const raw = [
      'diff --git a/old-with b/inside "b/x"',
      'index 3333333..4444444 100644',
      '--- a/old-with',
      '+++ "b/x"',
      '@@ -1,2 +1,2 @@',
      ' uno',
      '+export function enMalformado() {',
    ].join('\n');

    expect(baselineExtractSemanticDiff(raw).changes).toEqual([
      expect.objectContaining({ name: 'enMalformado', filePath: 'inside "b/x"' }),
    ]);
    expect(extractSemanticDiff(raw).changes).toEqual([
      expect.objectContaining({ name: 'enMalformado', filePath: 'x' }),
    ]);
  });

  it('garbage `diff --git` line mid-diff: legacy opened a new section, model keeps the previous file', () => {
    // The legacy splitter fired on ANY line starting with `diff --git `;
    // the unified model only opens a file for parseable headers, so the
    // declaration after the garbage line stays attributed to real.ts.
    // Unreachable in git/GitHub/truncateDiff output (truncateDiff cuts on
    // whole lines and appends its marker; only the FINAL header can be cut,
    // which produces no following declarations — see c12).
    const raw = [
      'diff --git a/real.ts b/real.ts',
      '--- a/real.ts',
      '+++ b/real.ts',
      '@@ -1,1 +1,2 @@',
      ' ctx',
      'diff --git esto-no-es-un-header',
      '+export function huerfana() {',
    ].join('\n');

    expect(baselineExtractSemanticDiff(raw).changes).toEqual([
      expect.objectContaining({ name: 'huerfana', filePath: 'unknown' }),
    ]);
    expect(extractSemanticDiff(raw).changes).toEqual([
      expect.objectContaining({ name: 'huerfana', filePath: 'real.ts' }),
    ]);
  });
});

describe('DELIBERATE divergence — summary-kinds fix (pinned old-vs-new)', () => {
  const wrap = (bodyLines: string[]): string =>
    [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 1111111..2222222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      ...bodyLines,
    ].join('\n');

  it('added import: identical change set, baseline double-counted it as modified', () => {
    const raw = wrap(["+import { bar } from './bar'"]);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(live.changes).toEqual(baseline.changes); // kinds identical (import_added)
    expect(baseline.summary).toBe('1 import added, 1 import modified'); // Bug A
    expect(live.summary).toBe('1 import added');
  });

  it('added export: identical change set, baseline double-counted it as modified', () => {
    const raw = wrap(['+export const VERSION = "2.0"']);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(live.changes).toEqual(baseline.changes); // kinds identical (export_added)
    expect(baseline.summary).toBe('1 export added, 1 export modified'); // Bug A
    expect(live.summary).toBe('1 export added');
  });

  it('modified import (same module, changed specifiers): baseline misreported import_removed', () => {
    const raw = wrap(["-import { a } from './m'", "+import { a, b } from './m'"]);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(baseline.changes).toEqual([
      expect.objectContaining({
        kind: 'import_removed', // false ternary branch — signatures betray the lie
        name: './m',
        oldSignature: "import { a } from './m'",
        newSignature: "import { a, b } from './m'",
      }),
    ]);
    expect(live.changes).toEqual([
      expect.objectContaining({
        kind: 'import_modified',
        name: './m',
        oldSignature: "import { a } from './m'",
        newSignature: "import { a, b } from './m'",
      }),
    ]);
    expect(baseline.summary).toBe('1 import removed');
    expect(live.summary).toBe('1 import modified');
  });

  it('modified export (same name, changed value): baseline misreported export_removed', () => {
    const raw = wrap(["-export const VERSION = '1.0'", "+export const VERSION = '2.0'"]);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(baseline.changes.map((c) => c.kind)).toEqual(['export_removed']);
    expect(live.changes.map((c) => c.kind)).toEqual(['export_modified']);
    expect(baseline.summary).toBe('1 export removed');
    expect(live.summary).toBe('1 export modified');
  });

  it('modified class: baseline collapsed to function_modified and double-counted in summary', () => {
    const raw = wrap(['-export class Foo {', '+export class Foo extends Base {']);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(baseline.changes.map((c) => c.kind)).toEqual(['function_modified']); // Bug B
    expect(live.changes.map((c) => c.kind)).toEqual(['class_modified']);
    // Baseline counted the SAME change in both the function and class groups.
    expect(baseline.summary).toBe('1 function modified, 1 class modified');
    expect(live.summary).toBe('1 class modified');
  });

  it("modified function: identical change set, baseline leaked it into the class group's summary", () => {
    const raw = wrap([
      '-export function f(a: string) {',
      '+export function f(a: string, b: number) {',
    ]);
    const baseline = baselineExtractSemanticDiff(raw);
    const live = extractSemanticDiff(raw);

    expect(live.changes).toEqual(baseline.changes); // kinds identical (function_modified)
    expect(baseline.summary).toBe('1 function modified, 1 class modified'); // Bug B leak
    expect(live.summary).toBe('1 function modified');
  });
});

describe('gate 7.1 aggregate (non-vacuous)', () => {
  it('the corpus produces a meaningful number of entity changes', () => {
    let total = 0;
    for (const name of ALL_FIXTURES)
      total += baselineExtractSemanticDiff(fixture(name)).changes.length;
    // provenance-gh-api-pr209 alone is a real TS PR with many declarations.
    expect(total).toBeGreaterThan(10);
    let live = 0;
    for (const name of ALL_FIXTURES) live += extractSemanticDiff(fixture(name)).changes.length;
    expect(live).toBe(total);
  });
});
