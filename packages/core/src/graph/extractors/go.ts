/**
 * Go Extractor
 *
 * Regex-based extractor for Go files.
 * Handles import blocks, single imports, and exported identifiers.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── Import Patterns ────────────────────────────────────────────

/** Single import: import "pkg" / import alias "pkg" */
const SINGLE_IMPORT_RE = /^import\s+(?:(\w+)\s+)?["']([^"']+)["']/gm;

/** Import block: import ( ... ) — captures the block content */
const IMPORT_BLOCK_RE = /import\s*\(\s*([\s\S]*?)\)/g;

/** Line inside import block: optional-alias "pkg" */
const IMPORT_LINE_RE = /(?:(\w+)\s+)?["']([^"']+)["']/g;

// ─── Export Patterns ────────────────────────────────────────────

/** func FuncName( — exported functions start with uppercase */
const FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*\(/gm;

/** type TypeName struct/interface */
const TYPE_RE = /^type\s+([A-Z]\w*)\s+(?:struct|interface)\b/gm;

/** var/const VarName — exported package-level vars/consts */
const VAR_RE = /^(?:var|const)\s+([A-Z]\w*)\s/gm;

// ─── Extractor ──────────────────────────────────────────────────

export const goExtractor: Extractor = {
  language: 'go',
  extensions: ['.go'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    function addImport(source: string, alias?: string): void {
      if (!seen.has(source)) {
        seen.add(source);
        imports.push({
          source,
          symbols: alias ? [alias] : [],
        });
      }
    }

    // Import blocks
    for (const blockMatch of content.matchAll(IMPORT_BLOCK_RE)) {
      const blockContent = blockMatch[1]!;
      for (const lineMatch of blockContent.matchAll(IMPORT_LINE_RE)) {
        const alias = lineMatch[1];
        const source = lineMatch[2]!;
        addImport(source, alias);
      }
    }

    // Single imports
    for (const match of content.matchAll(SINGLE_IMPORT_RE)) {
      const alias = match[1];
      const source = match[2]!;
      addImport(source, alias);
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

    // Exported functions
    for (const match of content.matchAll(FUNC_RE)) {
      add(match[1]!, 'function');
    }

    // Exported types
    for (const match of content.matchAll(TYPE_RE)) {
      add(match[1]!, 'type');
    }

    // Exported vars/consts
    for (const match of content.matchAll(VAR_RE)) {
      add(match[1]!, 'variable');
    }

    return exports;
  },
};
