/**
 * Python Extractor
 *
 * Regex-based extractor for Python files.
 * Handles absolute imports, relative imports, and function/class definitions.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── Import Patterns ────────────────────────────────────────────

/** from x import y, z */
const FROM_IMPORT_RE = /^from\s+(\.{0,3}\w[\w.]*|\.{1,3})\s+import\s+(.+)$/gm;

/** import x / import x, y / import x as y */
const IMPORT_RE = /^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)$/gm;

// ─── Export Patterns ────────────────────────────────────────────

/** def function_name( */
const FUNCTION_DEF_RE = /^def\s+(\w+)\s*\(/gm;

/** class ClassName */
const CLASS_DEF_RE = /^class\s+(\w+)/gm;

/** Top-level variable assignment: NAME = ... (UPPERCASE convention for module-level constants) */
const TOP_LEVEL_VAR_RE = /^([A-Z_][A-Z0-9_]*)\s*=/gm;

/** __all__ = ['x', 'y', 'z'] — explicit export list */
const ALL_LIST_RE = /__all__\s*=\s*\[([^\]]+)\]/;

// ─── Extractor ──────────────────────────────────────────────────

export const pythonExtractor: Extractor = {
  language: 'python',
  extensions: ['.py'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    // from x import y, z
    for (const match of content.matchAll(FROM_IMPORT_RE)) {
      const source = match[1]!;
      const importPart = match[2]?.trim();

      // Handle `from x import (y, z)` — multi-line with parens
      const cleaned = importPart.replace(/[()]/g, '');
      const symbols = cleaned
        .split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter((s) => Boolean(s) && s !== '*');

      const key = `${source}:from`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source, symbols });
      }
    }

    // import x / import x, y
    for (const match of content.matchAll(IMPORT_RE)) {
      const modulesPart = match[1]!;
      const modules = modulesPart
        .split(',')
        .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
        .filter(Boolean);

      for (const mod of modules) {
        const key = `${mod}:import`;
        if (!seen.has(key)) {
          seen.add(key);
          imports.push({ source: mod, symbols: [] });
        }
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

    // Check for __all__ — if present, only export those names
    const allMatch = content.match(ALL_LIST_RE);
    if (allMatch) {
      const names = allMatch[1]
        ?.split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
      for (const name of names) {
        add(name, 'variable');
      }
      return exports;
    }

    // Public functions (not starting with _)
    for (const match of content.matchAll(FUNCTION_DEF_RE)) {
      const name = match[1]!;
      if (!name.startsWith('_')) {
        add(name, 'function');
      }
    }

    // Public classes (not starting with _)
    for (const match of content.matchAll(CLASS_DEF_RE)) {
      const name = match[1]!;
      if (!name.startsWith('_')) {
        add(name, 'class');
      }
    }

    // Top-level constants
    for (const match of content.matchAll(TOP_LEVEL_VAR_RE)) {
      add(match[1]!, 'variable');
    }

    return exports;
  },
};
