/**
 * Java Extractor
 *
 * Regex-based extractor for Java files.
 * Handles import statements and public class/interface/enum declarations.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── Import Patterns ────────────────────────────────────────────

/** import x.y.z; / import static x.y.z; */
const IMPORT_RE = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

// ─── Export Patterns ────────────────────────────────────────────

/** public class ClassName */
const PUBLIC_CLASS_RE = /public\s+(?:abstract\s+)?class\s+(\w+)/g;

/** public interface InterfaceName */
const PUBLIC_INTERFACE_RE = /public\s+interface\s+(\w+)/g;

/** public enum EnumName */
const PUBLIC_ENUM_RE = /public\s+enum\s+(\w+)/g;

/** public record RecordName */
const PUBLIC_RECORD_RE = /public\s+record\s+(\w+)/g;

/** public static? ReturnType methodName( — public methods */
const PUBLIC_METHOD_RE = /public\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/g;

// ─── Extractor ──────────────────────────────────────────────────

export const javaExtractor: Extractor = {
  language: 'java',
  extensions: ['.java'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    for (const match of content.matchAll(IMPORT_RE)) {
      const fullPath = match[1]!;
      if (!seen.has(fullPath)) {
        seen.add(fullPath);

        // Extract the class/symbol name (last segment)
        const parts = fullPath.split('.');
        const lastPart = parts[parts.length - 1]!;
        const symbols = lastPart === '*' ? [] : [lastPart];

        imports.push({
          source: fullPath,
          symbols,
        });
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

    // Public classes
    for (const match of content.matchAll(PUBLIC_CLASS_RE)) {
      add(match[1]!, 'class');
    }

    // Public interfaces
    for (const match of content.matchAll(PUBLIC_INTERFACE_RE)) {
      add(match[1]!, 'type');
    }

    // Public enums
    for (const match of content.matchAll(PUBLIC_ENUM_RE)) {
      add(match[1]!, 'type');
    }

    // Public records
    for (const match of content.matchAll(PUBLIC_RECORD_RE)) {
      add(match[1]!, 'type');
    }

    // Public methods (exclude common Java boilerplate names)
    const JAVA_NOISE = new Set(['main', 'toString', 'hashCode', 'equals', 'clone']);
    for (const match of content.matchAll(PUBLIC_METHOD_RE)) {
      const name = match[1]!;
      if (!JAVA_NOISE.has(name) && !seen.has(name)) {
        add(name, 'function');
      }
    }

    return exports;
  },
};
