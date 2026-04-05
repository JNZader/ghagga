/**
 * Semantic diff extraction.
 *
 * Instead of raw line diffs, extracts WHAT changed at the entity level:
 * function renamed, class added, method signature changed, etc.
 *
 * Implementation is regex-based — no tree-sitter required.
 */

// ─── Types ───────────────────────────────────────────────────────

export type EntityChangeKind =
  | 'function_added'
  | 'function_removed'
  | 'function_modified'
  | 'class_added'
  | 'class_removed'
  | 'method_added'
  | 'method_removed'
  | 'method_modified'
  | 'import_added'
  | 'import_removed'
  | 'export_added'
  | 'export_removed'
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
  // import statements — match before export/function to avoid conflicts
  {
    kind: 'import',
    pattern:
      /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+['"][^'"]+['"]/,
  },
  // export default / named
  {
    kind: 'export',
    pattern:
      /^\s*export\s+(?:default\s+)?(?:const|let|var|function\*?|async\s+function\*?)\s+(\w+)/,
  },
  // export type / interface
  {
    kind: 'type',
    pattern: /^\s*export\s+(?:type|interface|enum)\s+(\w+)/,
  },
  // standalone type / interface / enum
  {
    kind: 'type',
    pattern: /^\s*(?:type|interface|enum)\s+(\w+)/,
  },
  // class declaration
  {
    kind: 'class',
    pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  },
  // method inside class (indented + no leading "function" keyword, has "()")
  {
    kind: 'method',
    pattern: /^[ \t]+(?:(?:public|private|protected|static|async|override|readonly)\s+)*(\w+)\s*\(/,
  },
  // top-level function declaration
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/,
  },
  // arrow function / const fn = ...
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  },
  // const fn = async () => or const fn = () =>
  {
    kind: 'function',
    pattern:
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\w[\w<>,\s]*?)?\s*=\s*(?:async\s+)?\(/,
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
 * Parse a unified diff and split added/removed declaration lines per file.
 */
function parseHunks(unifiedDiff: string): HunkSet[] {
  const result: HunkSet[] = [];
  const filePattern = /^diff --git a\/.+ b\/(.+)$/m;
  const sections = unifiedDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const pathMatch = /a\/.+ b\/(.+)$/.exec(section.split('\n')[0] ?? '');
    const filePath = pathMatch?.[1] ?? 'unknown';

    const added: HunkSet['added'] = new Map();
    const removed: HunkSet['removed'] = new Map();

    for (const line of section.split('\n')) {
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

    result.push({ filePath, added, removed });
  }

  // Suppress unused import warning — filePattern is used for documentation only
  void filePattern;

  return result;
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Extract entity-level changes from a unified diff string.
 *
 * Returns a SemanticDiff with individual EntityChange items and a
 * human-readable summary string.
 */
export function extractSemanticDiff(unifiedDiff: string): SemanticDiff {
  const hunkSets = parseHunks(unifiedDiff);
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
          : 'function_modified'; // classes cannot be "modified" at entity level, treat as function_modified
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
  groupSummary('class_added', 'class_removed', 'function_modified', 'class');
  groupSummary('method_added', 'method_removed', 'method_modified', 'method');
  groupSummary('import_added', 'import_removed', 'import_added', 'import');
  groupSummary('export_added', 'export_removed', 'export_added', 'export');
  groupSummary('type_added', 'type_removed', 'type_modified', 'type');

  if (parts.length === 0) return 'no entity-level changes detected';
  return parts.join(', ');
}
