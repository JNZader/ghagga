/**
 * JavaScript Extractor
 *
 * Regex-based extractor for JavaScript/JSX/MJS/CJS files.
 * Handles ES module imports/exports AND CommonJS require/module.exports.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── ES Module Import Patterns ──────────────────────────────────

/** import { x, y } from 'module' */
const NAMED_IMPORT_RE = /import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** import x from 'module' */
const DEFAULT_IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/** import * as x from 'module' */
const NAMESPACE_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/** import 'module' */
const SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

/** import x, { y, z } from 'module' */
const MIXED_IMPORT_RE = /import\s+(\w+)\s*,\s*{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

// ─── CommonJS Import Patterns ───────────────────────────────────

/** const x = require('module') / const { x, y } = require('module') */
const REQUIRE_RE =
  /(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** require('module') — bare require (side-effect) */
const BARE_REQUIRE_RE = /^require\(\s*['"]([^'"]+)['"]\s*\)/gm;

// ─── ES Module Export Patterns ──────────────────────────────────

/** export function x() / export async function x() */
const EXPORT_FUNCTION_RE = /export\s+(?:async\s+)?function\s+(\w+)/g;

/** export class x */
const EXPORT_CLASS_RE = /export\s+class\s+(\w+)/g;

/** export const/let/var x */
const EXPORT_VARIABLE_RE = /export\s+(?:const|let|var)\s+(\w+)/g;

/** export default */
const EXPORT_DEFAULT_RE = /export\s+default\s+(?:function\s+(\w+)|class\s+(\w+)|(\w+))/g;

/**
 * export { x, y } — LOCAL named exports only. The negative lookahead
 * excludes `export { x } from '...'` (a re-export), handled separately by
 * REEXPORT_NAMED_RE/REEXPORT_TYPE_RE below (mirrors typescript.ts D2).
 */
const EXPORT_NAMED_RE = /export\s+{([^}]+)}(?!\s*from\b)/g;

/** export default anonymous */
const EXPORT_DEFAULT_ANON_RE = /export\s+default\s+(?:function|class)\s*[({]/g;

// ─── Re-export Patterns (D1, mirrors typescript.ts) ─────────────

/** export { x, y } from 'module' — named re-export (multiline-safe) */
const REEXPORT_NAMED_RE = /export\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** export type { x, y } from 'module' — type-only re-export */
const REEXPORT_TYPE_RE = /export\s+type\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;

/** export * from 'module' — wildcard re-export (symbols not enumerable) */
const REEXPORT_WILDCARD_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

// ─── CommonJS Export Patterns ───────────────────────────────────

/** module.exports = x / module.exports = { x, y } */
const MODULE_EXPORTS_RE = /module\.exports\s*=\s*(?:{([^}]+)}|(\w+))/g;

/** exports.x = ... */
const EXPORTS_PROP_RE = /exports\.(\w+)\s*=/g;

// ─── Extractor ──────────────────────────────────────────────────

export const javascriptExtractor: Extractor = {
  language: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    // Mixed default + named
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

    // Named imports
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

    // Default imports
    for (const match of content.matchAll(DEFAULT_IMPORT_RE)) {
      const name = match[1]!;
      const source = match[2]!;
      const key = `${source}:default`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [name] });
      }
    }

    // Namespace imports
    for (const match of content.matchAll(NAMESPACE_IMPORT_RE)) {
      const name = match[1]!;
      const source = match[2]!;
      const key = `${source}:namespace`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [name] });
      }
    }

    // Side-effect imports
    for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const source = match[1]!;
      const key = `${source}:side-effect`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols: [] });
      }
    }

    // CommonJS require
    for (const match of content.matchAll(REQUIRE_RE)) {
      const defaultName = match[1];
      const namedPart = match[2];
      const source = match[3]!;
      const symbols = defaultName
        ? [defaultName]
        : namedPart
          ? namedPart
              .split(',')
              .map((s) => s.trim().replace(/\s*:\s*\w+/, ''))
              .filter(Boolean)
          : [];
      const key = `${source}:require`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // Bare require
    for (const match of content.matchAll(BARE_REQUIRE_RE)) {
      const source = match[1]!;
      const key = `${source}:bare-require`;
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

    // Re-exported names use a SEPARATE seen-set keyed by `name:source`
    // (mirrors typescript.ts D2) — never collides with a genuine local
    // export of the same name, and the wildcard sentinel (`'*'`) supports
    // multiple `export * from` lines from different sources.
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

    // export { x, y } — local named exports only (D2: `from`-suffixed
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
        addReExport(name, 'variable', source);
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

    // export * from 'module' — wildcard re-export (D1, D4: sentinel name)
    for (const match of content.matchAll(REEXPORT_WILDCARD_RE)) {
      const source = match[1]!;
      addReExport('*', 'variable', source);
    }

    // module.exports = { x, y } or module.exports = x
    for (const match of content.matchAll(MODULE_EXPORTS_RE)) {
      const objectPart = match[1];
      const singleName = match[2];
      if (objectPart) {
        const names = objectPart
          .split(',')
          .map((s) => s.trim().split(/\s*:\s*/)[0]!)
          .filter(Boolean);
        for (const name of names) {
          add(name, 'variable');
        }
      } else if (singleName) {
        add(singleName, 'default');
      }
    }

    // exports.x = ...
    for (const match of content.matchAll(EXPORTS_PROP_RE)) {
      add(match[1]!, 'variable');
    }

    return exports;
  },
};
