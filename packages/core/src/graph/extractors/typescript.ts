/**
 * TypeScript Extractor
 *
 * Regex-based extractor for TypeScript/TSX files.
 * Handles ES module imports/exports including type-only imports.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── Import Patterns ────────────────────────────────────────────

/** import { x, y } from 'module' — also handles `import type { x } from 'module'` */
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** import x from 'module' — default import */
const DEFAULT_IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/** import * as x from 'module' — namespace import */
const NAMESPACE_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/** import 'module' — side-effect import */
const SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

/** import x, { y, z } from 'module' — mixed default + named */
const MIXED_IMPORT_RE = /import\s+(\w+)\s*,\s*{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

// ─── Export Patterns ────────────────────────────────────────────

/** export function x() / export async function x() */
const EXPORT_FUNCTION_RE = /export\s+(?:async\s+)?function\s+(\w+)/g;

/** export class x */
const EXPORT_CLASS_RE = /export\s+class\s+(\w+)/g;

/** export const/let/var x */
const EXPORT_VARIABLE_RE = /export\s+(?:const|let|var)\s+(\w+)/g;

/** export type x / export interface x */
const EXPORT_TYPE_RE = /export\s+(?:type|interface)\s+(\w+)/g;

/** export default */
const EXPORT_DEFAULT_RE = /export\s+default\s+(?:function\s+(\w+)|class\s+(\w+)|(\w+))/g;

/**
 * export { x, y, z } — LOCAL named exports only. The negative lookahead
 * excludes `export { x } from '...'` (a re-export), which is handled
 * separately by REEXPORT_NAMED_RE/REEXPORT_TYPE_RE below (D2 discriminator:
 * the `from` clause is the ground-truth signal that a name is re-exported,
 * not locally declared).
 */
const EXPORT_NAMED_RE = /export\s+{([^}]+)}(?!\s*from\b)/g;

/** export default (anonymous) — export default function() {}, export default class {} */
const EXPORT_DEFAULT_ANON_RE = /export\s+default\s+(?:function|class)\s*[({]/g;

// ─── Re-export Patterns (D1) ────────────────────────────────────

/** export { x, y } from 'module' — named re-export (multiline-safe) */
const REEXPORT_NAMED_RE = /export\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** export type { x, y } from 'module' — type-only re-export */
const REEXPORT_TYPE_RE = /export\s+type\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** export * from 'module' — wildcard re-export (symbols not enumerable) */
const REEXPORT_WILDCARD_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

// ─── Extractor ──────────────────────────────────────────────────

export const typescriptExtractor: Extractor = {
  language: 'typescript',
  extensions: ['.ts', '.tsx'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    // Mixed default + named: import x, { y, z } from 'module'
    for (const match of content.matchAll(MIXED_IMPORT_RE)) {
      const defaultName = match[1]!;
      const namedPart = match[2]!;
      const source = match[3]!;
      const symbols = [
        defaultName,
        ...namedPart
          .split(',')
          .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
          .filter(Boolean),
      ];
      const key = `${source}:${symbols.sort().join(',')}`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // Named imports: import { x, y } from 'module'
    for (const match of content.matchAll(NAMED_IMPORT_RE)) {
      const symbols = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      const source = match[2]!;
      const key = `${source}:named`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // Default imports: import x from 'module'
    for (const match of content.matchAll(DEFAULT_IMPORT_RE)) {
      const name = match[1]!;
      const source = match[2]!;
      const key = `${source}:default`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [name] });
      }
    }

    // Namespace imports: import * as x from 'module'
    for (const match of content.matchAll(NAMESPACE_IMPORT_RE)) {
      const name = match[1]!;
      const source = match[2]!;
      const key = `${source}:namespace`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [name] });
      }
    }

    // Side-effect imports: import 'module'
    for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const source = match[1]!;
      const key = `${source}:side-effect`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [] });
      }
    }

    // Re-export named: export { x, y } from 'module' (D1)
    for (const match of content.matchAll(REEXPORT_NAMED_RE)) {
      const symbols = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      const source = match[2]!;
      const key = `${source}:reexport-named`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // Re-export type-only: export type { x, y } from 'module' (D1)
    for (const match of content.matchAll(REEXPORT_TYPE_RE)) {
      const symbols = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      const source = match[2]!;
      const key = `${source}:reexport-type`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // Re-export wildcard: export * from 'module' (D1, D4 — never enumerate)
    for (const match of content.matchAll(REEXPORT_WILDCARD_RE)) {
      const source = match[1]!;
      const key = `${source}:reexport-wildcard`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [] });
      }
    }

    return imports;
  },

  extractExports(content: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    const seen = new Set<string>();
    const seenReExports = new Set<string>();

    function add(name: string, kind: ExportInfo['kind']): void {
      if (!seen.has(name)) {
        seen.add(name);
        exports.push({ name, kind });
      }
    }

    // Re-exported names are tracked in a SEPARATE seen-set, keyed by
    // `name:source`, so (a) they never collide with a genuine local export
    // of the same name and (b) the same name re-exported from two
    // different sources isn't silently dropped. The wildcard sentinel
    // (`'*'`) uses the same mechanism so multiple `export * from` lines
    // (different sources) are all recorded.
    function addReExport(name: string, kind: ExportInfo['kind'], source: string): void {
      const key = `${name}:${source}`;
      if (!seenReExports.has(key)) {
        seenReExports.add(key);
        exports.push({ name, kind, source });
      }
    }

    // export default (named)
    for (const match of content.matchAll(EXPORT_DEFAULT_RE)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name) add(name, 'default');
    }

    // export default (anonymous)
    for (const _match of content.matchAll(EXPORT_DEFAULT_ANON_RE)) {
      if (!seen.has('default')) add('default', 'default');
    }

    // export function
    for (const match of content.matchAll(EXPORT_FUNCTION_RE)) {
      add(match[1]!, 'function');
    }

    // export class
    for (const match of content.matchAll(EXPORT_CLASS_RE)) {
      add(match[1]!, 'class');
    }

    // export const/let/var
    for (const match of content.matchAll(EXPORT_VARIABLE_RE)) {
      add(match[1]!, 'variable');
    }

    // export type/interface
    for (const match of content.matchAll(EXPORT_TYPE_RE)) {
      add(match[1]!, 'type');
    }

    // export { x, y, z } — local named exports only (D2: `from`-suffixed
    // matches are excluded by EXPORT_NAMED_RE's negative lookahead)
    for (const match of content.matchAll(EXPORT_NAMED_RE)) {
      const names = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      for (const name of names) {
        add(name, 'variable');
      }
    }

    // export { x, y } from 'module' — named re-export (D1, D2)
    for (const match of content.matchAll(REEXPORT_NAMED_RE)) {
      const names = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      const source = match[2]!;
      for (const name of names) {
        addReExport(name, 'variable', source); // Can't determine kind from re-export
      }
    }

    // export type { x, y } from 'module' — type-only re-export (D1, D2)
    for (const match of content.matchAll(REEXPORT_TYPE_RE)) {
      const names = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      const source = match[2]!;
      for (const name of names) {
        addReExport(name, 'type', source);
      }
    }

    // export * from 'module' — wildcard re-export (D1, D4: sentinel name,
    // never enumerate individual symbols)
    for (const match of content.matchAll(REEXPORT_WILDCARD_RE)) {
      const source = match[1]!;
      addReExport('*', 'variable', source);
    }

    return exports;
  },
};
