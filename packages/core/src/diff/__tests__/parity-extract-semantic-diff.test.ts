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
 * Expected divergences vs the baseline: NONE on any fixture (no fixture
 * carries declaration lines inside quoted/malformed sections). The
 * documented delta classes (quoted headers resolving to a real path under
 * the CORE-M6 umbrella, and synthetic-only malformed-header boundaries)
 * are pinned explicitly when the adapter lands (Phase 7 task 7.2).
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

// ─── Parity gate ────────────────────────────────────────────────

describe.each(ALL_FIXTURES)('extractSemanticDiff parity %s', (name) => {
  it('is deeply equal to the frozen baseline (changes order included)', () => {
    const raw = fixture(name);
    expect(extractSemanticDiff(raw)).toEqual(baselineExtractSemanticDiff(raw));
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
    expect(extractSemanticDiff(raw)).toEqual(baselineExtractSemanticDiff(raw));
  });

  it('empty and newline-only inputs stay empty', () => {
    for (const raw of ['', '\n']) {
      expect(extractSemanticDiff(raw)).toEqual(baselineExtractSemanticDiff(raw));
      expect(extractSemanticDiff(raw).changes).toEqual([]);
    }
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
