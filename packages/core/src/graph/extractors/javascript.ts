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

/** export { x, y } */
const EXPORT_NAMED_RE = /export\s+{([^}]+)}/g;

/** export default anonymous */
const EXPORT_DEFAULT_ANON_RE = /export\s+default\s+(?:function|class)\s*[({]/g;

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

    // export { x, y }
    for (const match of content.matchAll(EXPORT_NAMED_RE)) {
      const names = match[1]
        ?.split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);
      for (const name of names) {
        add(name, 'variable');
      }
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
