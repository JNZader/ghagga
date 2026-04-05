/**
 * Code Intelligence Context Builder
 *
 * Formats structural query results into a context string
 * suitable for injection into agent prompts.
 * Respects a configurable token budget.
 */

import type { CodeIntelResult } from './types.js';

// ─── Constants ─────────────────────────────────────────────────

/** Default max tokens for code intelligence context. */
export const DEFAULT_CODE_INTEL_MAX_TOKENS = 1_500;

/** Approximate characters per token for budget estimation. */
const CHARS_PER_TOKEN = 4;

// ─── Builder ───────────────────────────────────────────────────

/**
 * Build a markdown-formatted context string from code intelligence results.
 *
 * Returns an empty string when there is no meaningful data to include.
 * Truncates to fit within the specified token budget.
 *
 * @param results - Structural data per file from the code intelligence provider
 * @param maxTokens - Maximum tokens for the context string (default: 1500)
 */
export function buildCodeIntelContext(
  results: CodeIntelResult[],
  maxTokens = DEFAULT_CODE_INTEL_MAX_TOKENS,
): string {
  if (results.length === 0) return '';

  // Filter to files that have at least some structural data
  const meaningful = results.filter(
    (r) =>
      r.callers.length > 0 || r.callees.length > 0 || r.imports.length > 0 || r.exports.length > 0,
  );

  if (meaningful.length === 0) return '';

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const sections: string[] = [];
  let totalChars = 0;

  for (const result of meaningful) {
    const section = formatFileSection(result);
    if (totalChars + section.length > maxChars) {
      // Add truncation notice and stop
      sections.push('_(code intelligence context truncated to fit token budget)_');
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return '';

  return sections.join('\n\n');
}

// ─── Formatting Helpers ────────────────────────────────────────

function formatFileSection(result: CodeIntelResult): string {
  const lines: string[] = [`#### \`${result.file}\``];

  if (result.callers.length > 0) {
    lines.push('**Called by:**');
    for (const ref of result.callers) {
      const loc = ref.line != null ? `:${ref.line}` : '';
      lines.push(`- \`${ref.symbol}\` in \`${ref.file}${loc}\``);
    }
  }

  if (result.callees.length > 0) {
    lines.push('**Calls into:**');
    for (const ref of result.callees) {
      const loc = ref.line != null ? `:${ref.line}` : '';
      lines.push(`- \`${ref.symbol}\` in \`${ref.file}${loc}\``);
    }
  }

  if (result.imports.length > 0) {
    lines.push(`**Imports:** ${result.imports.map((i) => `\`${i}\``).join(', ')}`);
  }

  if (result.exports.length > 0) {
    lines.push(`**Exports:** ${result.exports.map((e) => `\`${e}\``).join(', ')}`);
  }

  return lines.join('\n');
}
