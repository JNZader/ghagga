/**
 * Rust Extractor
 *
 * Regex-based extractor for Rust files.
 * Handles use statements, mod declarations, and pub exports.
 */

import type { ExportInfo, Extractor, ImportInfo } from './types.js';

// ─── Import Patterns ────────────────────────────────────────────

/** use crate::module::item; / use super::module; / use std::collections::HashMap; */
const USE_RE = /^use\s+([\w:]+(?:::\{[^}]+\})?(?:::\*)?)\s*;/gm;

/** mod module_name; — external module declaration (links to another file) */
const MOD_RE = /^(?:pub\s+)?mod\s+(\w+)\s*;/gm;

// ─── Export Patterns ────────────────────────────────────────────

/** pub fn function_name */
const PUB_FN_RE = /^pub(?:\([\w]+\))?\s+(?:async\s+)?fn\s+(\w+)/gm;

/** pub struct StructName */
const PUB_STRUCT_RE = /^pub(?:\([\w]+\))?\s+struct\s+(\w+)/gm;

/** pub enum EnumName */
const PUB_ENUM_RE = /^pub(?:\([\w]+\))?\s+enum\s+(\w+)/gm;

/** pub trait TraitName */
const PUB_TRAIT_RE = /^pub(?:\([\w]+\))?\s+trait\s+(\w+)/gm;

/** pub type TypeName */
const PUB_TYPE_RE = /^pub(?:\([\w]+\))?\s+type\s+(\w+)/gm;

/** pub const/static CONST_NAME */
const PUB_CONST_RE = /^pub(?:\([\w]+\))?\s+(?:const|static)\s+(\w+)/gm;

/** pub mod module_name { ... } — inline public module */
const PUB_MOD_RE = /^pub\s+mod\s+(\w+)/gm;

// ─── Extractor ──────────────────────────────────────────────────

export const rustExtractor: Extractor = {
  language: 'rust',
  extensions: ['.rs'],

  extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const seen = new Set<string>();

    // use statements
    for (const match of content.matchAll(USE_RE)) {
      const fullPath = match[1]!;

      // Handle grouped imports: use std::collections::{HashMap, BTreeMap}
      const braceMatch = fullPath.match(/^(.+)::\{([^}]+)\}$/);
      if (braceMatch) {
        const prefix = braceMatch[1]!;
        const symbols = braceMatch[2]
          ?.split(',')
          .map((s) => s.trim().replace(/\s+as\s+\w+/, ''))
          .filter(Boolean);
        const key = `${prefix}:use`;
        if (!seen.has(key)) {
          seen.add(key);
          imports.push({ source: prefix, symbols });
        }
      } else {
        // Single import: use crate::module::Item
        const parts = fullPath.split('::');
        const lastPart = parts[parts.length - 1]!;
        const symbols = lastPart === '*' ? [] : [lastPart];
        const source = parts.slice(0, -1).join('::') || fullPath;
        const key = `${fullPath}:use`;
        if (!seen.has(key)) {
          seen.add(key);
          imports.push({ source, symbols });
        }
      }
    }

    // mod declarations (external modules)
    for (const match of content.matchAll(MOD_RE)) {
      const modName = match[1]!;
      const key = `mod:${modName}`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ source: modName, symbols: [] });
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

    // pub fn
    for (const match of content.matchAll(PUB_FN_RE)) {
      add(match[1]!, 'function');
    }

    // pub struct
    for (const match of content.matchAll(PUB_STRUCT_RE)) {
      add(match[1]!, 'type');
    }

    // pub enum
    for (const match of content.matchAll(PUB_ENUM_RE)) {
      add(match[1]!, 'type');
    }

    // pub trait
    for (const match of content.matchAll(PUB_TRAIT_RE)) {
      add(match[1]!, 'type');
    }

    // pub type
    for (const match of content.matchAll(PUB_TYPE_RE)) {
      add(match[1]!, 'type');
    }

    // pub const/static
    for (const match of content.matchAll(PUB_CONST_RE)) {
      add(match[1]!, 'variable');
    }

    // pub mod
    for (const match of content.matchAll(PUB_MOD_RE)) {
      add(match[1]!, 'variable');
    }

    return exports;
  },
};
