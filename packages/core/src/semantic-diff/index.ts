/**
 * Semantic diff extraction.
 *
 * Instead of raw line diffs, extracts WHAT changed at the entity level:
 * function renamed, class added, method signature changed, etc.
 *
 * Implementation is regex-based — no tree-sitter required. File sectioning
 * is delegated to the unified diff parser (`src/diff/parse.ts`); declaration
 * detection stays local.
 *
 * WIRED TO PRODUCTION (SDD wire-semantic-diff, 2026-06-13).
 * `extractSemanticDiff` runs in the enrich phase (`pipeline/enrich.ts`),
 * its result lands on `ReviewResult.semanticDiff`, and that feeds the
 * "What changed" section of the PR comment via `formatSemanticDiffSection`
 * (`format.ts`). This is no longer an unwired re-export.
 *
 * Known limitations (real, by design — the extractor is regex-based, not a
 * parser, and matches single-line declarations only; all pinned in
 * `index.test.ts`):
 *   - a multiline arrow whose `=>` lands on the next line is not detected;
 *   - a generic constraint CONTAINING parens (`<T extends () => void>`) is
 *     not detected (the `[^(]*` guard that keeps comparisons out excludes it);
 *   - declarations spanning multiple lines are matched only by their first
 *     line.
 * The presentation layer (`format.ts`) drops `method_*` noise and gates to
 * TS/JS files, so these misses degrade the cosmetic comment section only —
 * never the review verdict.
 */

import { parseUnifiedDiff } from '../diff/index.js';

// ─── Types ───────────────────────────────────────────────────────

export type EntityChangeKind =
  | 'function_added'
  | 'function_removed'
  | 'function_modified'
  | 'class_added'
  | 'class_removed'
  | 'class_modified'
  | 'method_added'
  | 'method_removed'
  | 'method_modified'
  | 'import_added'
  | 'import_removed'
  | 'import_modified'
  | 'export_added'
  | 'export_removed'
  | 'export_modified'
  | 'type_added'
  | 'type_removed'
  | 'type_modified';

export interface EntityChange {
  kind: EntityChangeKind;
  name: string;
  filePath: string;
  /** Full declaration line for the old version (modifications only). */
  oldSignature?: string;
  /** Full declaration line for the new version (modifications only). */
  newSignature?: string;
}

export interface SemanticDiff {
  changes: EntityChange[];
  /** Human-readable summary, e.g. "3 functions modified, 1 class added" */
  summary: string;
}

// ─── Regex Patterns ──────────────────────────────────────────────

/**
 * Patterns that match declaration lines.
 * Each entry includes the entity category for grouping (function|class|method|import|export|type).
 */
const DECLARATION_PATTERNS: Array<{
  kind: 'function' | 'class' | 'method' | 'import' | 'export' | 'type';
  pattern: RegExp;
}> = [
  // NOTE: ORDER MATTERS. The generic "export <name>" pattern is intentionally
  // listed LAST so that more specific declarations — `export function foo`,
  // `export class Foo`, `export const fn = () => …`, `export type Foo` — are
  // classified by their real entity kind (function/class/type) instead of being
  // swallowed by a catch-all `export` rule. Only plain value re-exports
  // (e.g. `export const VERSION = '1.0'`, `export default expr`) fall through
  // to the `export` kind.

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
  // arrow / function-expression assigned to const/let/var (handles `export const fn = () =>`,
  // optionally typed: `export const fn: Foo = async () =>`).
  // The RHS must be a real function: `function` keyword, or arrow params
  // (paren-params — with an optional generic prefix `<T>` / `<T extends X>` —
  // bare single param, optional return-type annotation) followed by `=>`
  // ON THE SAME LINE. A bare `(` is NOT enough — that misclassified
  // parenthesized non-function initializers (e.g.
  // `const x = (row.metadata as Foo).bar`) as function_added.
  // The generic prefix `<[^(]*>` is anchored to paren-params only (a bare
  // param after a generic is not valid TS) and cannot contain `(` — so a
  // `<` comparison initializer (`const a = x < y`) never enters this branch,
  // and the cast false positive stays closed. Nested generics without parens
  // (`<T extends Record<string, K>>`) resolve via the greedy last-`>`.
  // Known limitations (accepted, pinned in index.test.ts):
  //   - a multiline arrow whose `=>` lands on the next line is not detected;
  //   - a generic constraint CONTAINING parens (`<T extends () => void>`)
  //     is not detected (the `[^(]*` guard that keeps comparisons out
  //     excludes it).
  {
    kind: 'function',
    pattern:
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>,\s|[\]]+?)?\s*=\s*(?:async\s+)?(?:function\b|(?:(?:<[^(]*>\s*)?\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>)/,
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

/**
 * Extract the entity name from a declaration line.
 * Returns [category, name] or null if no pattern matches.
 */
function extractDeclaration(
  line: string,
): { kind: 'function' | 'class' | 'method' | 'import' | 'export' | 'type'; name: string } | null {
  for (const { kind, pattern } of DECLARATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (kind === 'import') {
        // For imports, use the from-module as the "name" for deduplication
        const fromMatch = /from\s+['"]([^'"]+)['"]/.exec(line);
        return { kind, name: fromMatch?.[1] ?? line.trim().slice(0, 40) };
      }
      // Capture group 1 is the entity name for all other patterns
      const name = match[1];
      if (name) return { kind, name };
    }
  }
  return null;
}

// ─── Parser ──────────────────────────────────────────────────────

interface HunkSet {
  added: Map<
    string,
    {
      name: string;
      signature: string;
      kind: 'function' | 'class' | 'method' | 'import' | 'export' | 'type';
    }
  >;
  removed: Map<
    string,
    {
      name: string;
      signature: string;
      kind: 'function' | 'class' | 'method' | 'import' | 'export' | 'type';
    }
  >;
  filePath: string;
}

/**
 * FROZEN LEGACY BEHAVIOR — path resolution for the pre-header
 * pseudo-section. The historical splitter (`split(/^diff --git /m)`) kept
 * everything before the first file header as a section of its own and
 * resolved its "path" by running this tail regex over the FIRST line
 * (almost always yielding `unknown`). Reachable via arbitrary ACP input
 * and bare diff fragments, so it is preserved verbatim. This is NOT a
 * file-header or hunk-header regex (spec R8 keeps those solely in
 * `src/diff/`): it matches the tail of an already-isolated line.
 */
const LEGACY_SECTION_PATH_RE = /a\/.+ b\/(.+)$/;

/** Scan a section's raw lines for added/removed declaration lines. */
function scanSection(lines: string[], filePath: string): HunkSet {
  const added: HunkSet['added'] = new Map();
  const removed: HunkSet['removed'] = new Map();

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const decl = extractDeclaration(content);
      if (decl) {
        added.set(decl.name, { name: decl.name, signature: content.trim(), kind: decl.kind });
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1);
      const decl = extractDeclaration(content);
      if (decl) {
        removed.set(decl.name, { name: decl.name, signature: content.trim(), kind: decl.kind });
      }
    }
  }

  return { filePath, added, removed };
}

/**
 * Split added/removed declaration lines per file.
 *
 * Thin adapter over the unified parser (`src/diff/parse.ts`) — replaces the
 * historical local `parseHunks` that re-split the diff with its own
 * `/^diff --git /m` regex. Sections scan `rawLines` (NOT the structured
 * `hunk.lines`): the historical scanner looked at EVERY section line with
 * the +/- prefix checks, including metadata regions and orphan +/- tails
 * after a genuine empty line mid-hunk, which structured hunks do not carry.
 *
 * Path authority per file = the b-side of the `diff --git` header itself
 * (`headerNewPath`), which equals the historical regex capture for every
 * plain header (last ` b/` boundary included). Documented deltas vs the
 * historical splitter, pinned in
 * `src/diff/__tests__/parity-extract-semantic-diff.test.ts`:
 *   - quoted headers (CORE-M6 umbrella): historically the section existed
 *     but its path never matched the legacy regex → `unknown`; now the real
 *     unescaped path is resolved.
 *   - synthetic-only malformed headers (`diff --git <garbage>` mid-diff,
 *     mixed-quoted forms): the historical splitter opened a new section at
 *     ANY line starting with `diff --git `; the model only does so for
 *     parseable headers, so declarations after a garbage header line stay
 *     attributed to the previous file. Unreachable in git/GitHub/truncateDiff
 *     output.
 */
function collectHunkSets(unifiedDiff: string): HunkSet[] {
  const { preamble, files } = parseUnifiedDiff(unifiedDiff);
  const result: HunkSet[] = [];

  // Legacy pre-header pseudo-section (see LEGACY_SECTION_PATH_RE). The
  // historical splitter dropped it only when empty (`filter(Boolean)`).
  if (preamble.length > 0 && preamble.join('\n') !== '') {
    const pathMatch = LEGACY_SECTION_PATH_RE.exec(preamble[0] ?? '');
    result.push(scanSection(preamble, pathMatch?.[1] ?? 'unknown'));
  }

  for (const file of files) {
    result.push(scanSection(file.rawLines, file.headerNewPath || 'unknown'));
  }

  return result;
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Extract entity-level changes from a unified diff string.
 *
 * Returns a SemanticDiff with individual EntityChange items and a
 * human-readable summary string.
 *
 * Wired into the review pipeline (enrich phase → `ReviewResult.semanticDiff`
 * → "What changed" PR comment section). See the module header.
 */
export function extractSemanticDiff(unifiedDiff: string): SemanticDiff {
  const hunkSets = collectHunkSets(unifiedDiff);
  const changes: EntityChange[] = [];

  for (const { filePath, added, removed } of hunkSets) {
    // Entities in both added and removed → modified
    for (const [name, addedDecl] of added) {
      if (removed.has(name)) {
        const removedDecl = removed.get(name);
        const kind = mapToChangeKind(addedDecl.kind, 'modified');
        changes.push({
          kind,
          name,
          filePath,
          oldSignature: removedDecl?.signature,
          newSignature: addedDecl.signature,
        });
      } else {
        const kind = mapToChangeKind(addedDecl.kind, 'added');
        changes.push({ kind, name, filePath, newSignature: addedDecl.signature });
      }
    }

    // Entities only in removed → removed
    for (const [name, removedDecl] of removed) {
      if (!added.has(name)) {
        const kind = mapToChangeKind(removedDecl.kind, 'removed');
        changes.push({ kind, name, filePath, oldSignature: removedDecl.signature });
      }
    }
  }

  return { changes, summary: buildSummary(changes) };
}

// ─── Helpers ─────────────────────────────────────────────────────

function mapToChangeKind(
  category: 'function' | 'class' | 'method' | 'import' | 'export' | 'type',
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
          : 'class_modified';
    case 'method':
      return direction === 'added'
        ? 'method_added'
        : direction === 'removed'
          ? 'method_removed'
          : 'method_modified';
    // Modified imports/exports ARE reachable: a declaration whose name (for
    // imports, the from-module) appears on both the +/- sides of a section is
    // derived with direction 'modified'. Historically these fell into the
    // false branch of a two-way ternary and were misreported as
    // import_removed/export_removed (with both signatures set).
    case 'import':
      return direction === 'added'
        ? 'import_added'
        : direction === 'removed'
          ? 'import_removed'
          : 'import_modified';
    case 'export':
      return direction === 'added'
        ? 'export_added'
        : direction === 'removed'
          ? 'export_removed'
          : 'export_modified';
    case 'type':
      return direction === 'added'
        ? 'type_added'
        : direction === 'removed'
          ? 'type_removed'
          : 'type_modified';
  }
}

function buildSummary(changes: EntityChange[]): string {
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
