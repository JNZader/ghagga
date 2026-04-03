/**
 * Doc-Validation Scanner
 *
 * Extracts changed symbol names from unified diffs and scans
 * documentation files for references to those symbols.
 *
 * Pure functions with no side effects.
 */

import type { DiffFile } from '../utils/diff.js';
import type { DocReference, DocValidationResult } from './types.js';

// ─── Constants ────────────────────────────────────────────────

/** Minimum symbol name length to avoid false positives on common words. */
const MIN_SYMBOL_LENGTH = 3;

/**
 * Regex patterns to extract symbol declarations from diff added lines.
 *
 * Matches:
 *   - `function name(` / `async function name(`
 *   - `class Name` / `abstract class Name`
 *   - `interface Name`
 *   - `type Name`
 *   - `export function name(`
 *   - `def name(` (Python)
 *   - `func name(` / `func (r *Receiver) name(` (Go)
 */
const SYMBOL_DECLARATION_PATTERNS: RegExp[] = [
  // TypeScript / JavaScript
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
  /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  /(?:export\s+)?interface\s+(\w+)/,
  /(?:export\s+)?type\s+(\w+)\s*[=<{]/,
  // Arrow function: const name = (...) =>
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  // Python
  /def\s+(\w+)\s*\(/,
  /class\s+(\w+)\s*[:(]/,
  // Go
  /func\s+(\w+)\s*\(/,
  /func\s+\([^)]+\)\s+(\w+)\s*\(/,
];

/** File extensions considered documentation. */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

// ─── Symbol Extraction ───────────────────────────────────────

/**
 * Extract changed symbol names from a unified diff string.
 *
 * Scans added lines (lines starting with `+`) for function, class,
 * interface, and type declarations. Returns unique symbol names.
 *
 * @param diff - Full unified diff string
 * @returns Array of unique changed symbol names (filtered by min length)
 */
export function extractChangedSymbols(diff: string): string[] {
  const symbols = new Set<string>();
  const lines = diff.split('\n');

  for (const line of lines) {
    // Only scan added/modified lines (start with +, but not +++ header)
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    const content = line.slice(1); // Remove the leading +

    for (const pattern of SYMBOL_DECLARATION_PATTERNS) {
      const match = pattern.exec(content);
      if (match?.[1] && match[1].length >= MIN_SYMBOL_LENGTH) {
        symbols.add(match[1]);
      }
    }
  }

  return [...symbols];
}

// ─── Doc Reference Scanning ──────────────────────────────────

/**
 * Check if a file path is a documentation file based on extension.
 */
export function isDocFile(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return false;
  return DOC_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

/**
 * Scan documentation files for references to changed symbols.
 *
 * For each doc file, searches line-by-line for symbol references
 * (backtick-wrapped or plain word boundaries). If the doc file
 * was NOT in the changed files list, its references are flagged
 * as stale.
 *
 * @param symbols - Changed symbol names to search for
 * @param allFiles - All files from the diff (used to find doc content and check if updated)
 * @param changedCodeFiles - Paths of files that were changed in the diff
 * @param docContents - Optional map of doc file path → content (for docs NOT in the diff)
 * @returns DocValidationResult with stale references
 */
export function scanDocsForSymbols(
  symbols: string[],
  allFiles: DiffFile[],
  changedCodeFiles: string[],
  docContents?: Map<string, string>,
): DocValidationResult {
  if (symbols.length === 0) {
    return { changedSymbols: [], staleReferences: [], docsScanned: 0 };
  }

  const changedSet = new Set(changedCodeFiles);
  const staleReferences: DocReference[] = [];
  let docsScanned = 0;

  // Build regex for all symbols (word boundary match)
  const symbolPatterns = symbols.map((s) => ({
    symbol: s,
    regex: new RegExp(`(?:\`${escapeRegex(s)}(?:\\(\\))?\`|\\b${escapeRegex(s)}\\b)`, 'g'),
  }));

  // Scan doc files from the diff
  for (const file of allFiles) {
    if (!isDocFile(file.path)) continue;
    docsScanned++;

    // If doc is in the diff (was updated), skip — it's not stale
    if (changedSet.has(file.path)) continue;

    // This doc was NOT changed — scan for symbol references
    scanContent(file.path, file.content, symbolPatterns, staleReferences);
  }

  // Scan external doc contents (docs not in the diff at all)
  if (docContents) {
    for (const [filePath, content] of docContents) {
      if (!isDocFile(filePath)) continue;
      docsScanned++;
      scanContent(filePath, content, symbolPatterns, staleReferences);
    }
  }

  return {
    changedSymbols: symbols,
    staleReferences,
    docsScanned,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Scan a single document's content for symbol references.
 */
function scanContent(
  filePath: string,
  content: string,
  symbolPatterns: Array<{ symbol: string; regex: RegExp }>,
  results: DocReference[],
): void {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip diff header lines
    if (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    // Strip diff markers for content matching
    const cleanLine = line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line;

    for (const { symbol, regex } of symbolPatterns) {
      regex.lastIndex = 0; // Reset regex state
      if (regex.test(cleanLine)) {
        results.push({
          file: filePath,
          line: i + 1,
          symbol,
          context: cleanLine.trim().slice(0, 120),
        });
      }
    }
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
