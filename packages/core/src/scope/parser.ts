/**
 * Tree-sitter Parser
 *
 * Initializes the web-tree-sitter WASM runtime and provides
 * functions to parse source code and walk the AST.
 *
 * The parser is lazily initialized on first use and cached
 * for subsequent calls. WASM grammars are loaded from the
 * `tree-sitter-wasms` package.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Tree } from 'web-tree-sitter';
import { Language, Parser } from 'web-tree-sitter';
import type { ScopeLanguage } from './types.js';

const require = createRequire(import.meta.url);

// ─── State ─────────────────────────────────────────────────────

let initialized = false;
const languageCache = new Map<string, Language>();

// ─── Initialization ────────────────────────────────────────────

/**
 * Initialize the tree-sitter WASM runtime.
 * Safe to call multiple times — only initializes once.
 */
export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

/**
 * Load a tree-sitter language grammar from a WASM file.
 * Caches loaded grammars for reuse.
 *
 * @param wasmPath - Absolute path to the .wasm grammar file
 * @returns The loaded Language object
 */
export async function loadLanguage(wasmPath: string): Promise<Language> {
  const cached = languageCache.get(wasmPath);
  if (cached) return cached;

  await initParser();
  const language = await Language.load(wasmPath);
  languageCache.set(wasmPath, language);
  return language;
}

/**
 * Parse source code into a tree-sitter syntax tree.
 *
 * @param source - The source code string
 * @param language - The loaded tree-sitter Language
 * @returns The parsed Tree (caller must call tree.delete() when done)
 */
export function parseSource(source: string, language: Language): Tree {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) {
    throw new Error('Tree-sitter parsing returned null');
  }
  return tree;
}

// ─── WASM Grammar Resolution ──────────────────────────────────

/** WASM file names inside the tree-sitter-wasms/out/ directory. */
const GRAMMAR_WASM_FILES: Record<ScopeLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

/**
 * Resolve the WASM file path for a language grammar.
 * Uses the `tree-sitter-wasms` package which bundles prebuilt grammars.
 *
 * @param language - The scope language
 * @returns Path to the .wasm file, or undefined if not found
 */
export function resolveGrammarPath(language: ScopeLanguage): string | undefined {
  const wasmFile = GRAMMAR_WASM_FILES[language];
  if (!wasmFile) return undefined;

  try {
    const packageDir = require.resolve('@cursorless/tree-sitter-wasms/package.json');
    const dir = packageDir.replace('/package.json', '');
    return resolve(dir, 'out', wasmFile);
  } catch {
    return undefined;
  }
}

/**
 * Reset parser state. Used in tests to ensure clean initialization.
 */
export function resetParser(): void {
  initialized = false;
  languageCache.clear();
}
