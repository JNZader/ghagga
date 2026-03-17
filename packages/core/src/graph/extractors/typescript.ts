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

/** export { x, y, z } — re-exports or named exports */
const EXPORT_NAMED_RE = /export\s+{([^}]+)}/g;

/** export default (anonymous) — export default function() {}, export default class {} */
const EXPORT_DEFAULT_ANON_RE = /export\s+default\s+(?:function|class)\s*[({]/g;

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

    return imports;
  },

  extractExports(content: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    const seen = new Set<string>();

    function add(name: string, kind: ExportInfo['kind']): void {
      if (!seen.has(name)) {
        seen.add(name);
        exports.push({ name, kind });
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

    // export { x, y, z }
    for (const match of content.matchAll(EXPORT_NAMED_RE)) {
      const names = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      for (const name of names) {
        add(name, 'variable'); // Can't determine kind from re-export
      }
    }

    return exports;
  },
};
