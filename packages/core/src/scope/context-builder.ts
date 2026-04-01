/**
 * Scoped Context Builder
 *
 * Builds a focused review context string containing only the source
 * code of symbols affected by a diff. This dramatically reduces the
 * number of tokens sent to the LLM for review.
 *
 * Pure function with no side effects.
 */

import type { ScopedFile } from './types.js';

// ─── Constants ────────────────────────────────────────────────

/** Separator between file sections in the output. */
const FILE_SEPARATOR = '\n---\n';

/** Header format for each file section. */
const FILE_HEADER_PREFIX = '## ';

/** Header format for each symbol section. */
const SYMBOL_HEADER_PREFIX = '### ';

// ─── Builder ──────────────────────────────────────────────────

/**
 * Build a focused review context containing only the source code
 * of symbols affected by diff changes.
 *
 * Output format:
 * ```
 * ## path/to/file.ts
 *
 * ### function foo (lines 10-25)
 * ```ts
 * <source lines 10-25>
 * ```
 *
 * ### class Bar (lines 30-80)
 * ```ts
 * <source lines 30-80>
 * ```
 * ---
 * ## path/to/other.ts
 * ...
 * ```
 *
 * @param scopedFiles - Files with their affected symbols and source lines
 * @returns Formatted review context string, or empty string if no affected symbols
 */
export function buildScopedContext(scopedFiles: ScopedFile[]): string {
  if (scopedFiles.length === 0) return '';

  const sections: string[] = [];

  for (const file of scopedFiles) {
    if (file.symbols.length === 0) continue;

    const fileSection = buildFileSection(file);
    if (fileSection) {
      sections.push(fileSection);
    }
  }

  return sections.join(FILE_SEPARATOR);
}

// ─── Internals ────────────────────────────────────────────────

/**
 * Build the context section for a single file.
 */
function buildFileSection(file: ScopedFile): string | undefined {
  const ext = inferCodeFenceLanguage(file.filePath);
  const symbolSections: string[] = [];

  // Deduplicate symbols by name+startLine to avoid repeating
  // the same symbol if it appears in multiple hunks
  const seen = new Set<string>();

  for (const affected of file.symbols) {
    const { symbol } = affected;
    const key = `${symbol.name}:${symbol.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const startIdx = Math.max(0, symbol.startLine - 1);
    const endIdx = Math.min(file.sourceLines.length, symbol.endLine);
    const sourceSlice = file.sourceLines.slice(startIdx, endIdx).join('\n');

    const kindLabel = symbol.parent
      ? `${symbol.kind} ${symbol.parent}.${symbol.name}`
      : `${symbol.kind} ${symbol.name}`;

    const lineRange = `lines ${symbol.startLine}-${symbol.endLine}`;

    symbolSections.push(
      `${SYMBOL_HEADER_PREFIX}${kindLabel} (${lineRange})\n\`\`\`${ext}\n${sourceSlice}\n\`\`\``,
    );
  }

  if (symbolSections.length === 0) return undefined;

  return `${FILE_HEADER_PREFIX}${file.filePath}\n\n${symbolSections.join('\n\n')}`;
}

/**
 * Infer the code fence language hint from a file path.
 */
function inferCodeFenceLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const MAP: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
  };
  return MAP[ext] ?? ext;
}
