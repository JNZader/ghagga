/**
 * Graph Neighborhood Context Formatter (graph-context-retrieval Slice 2)
 *
 * Formats `FileNeighborhood[]` into a budgeted markdown block for the
 * per-voice "Graph Neighborhood" prompt section. Budget mechanics mirror
 * the code-intel precedent (`code-intel/context.ts`): accumulate sections
 * at CHARS_PER_TOKEN=4, append a truncation notice and stop once the cap
 * is exceeded.
 *
 * Freshness tiers (design decision 4):
 * - 'exact'      — full detail: importer/importee paths, exported symbols,
 *                  symbol-named-import note for symbol-dense files.
 * - 'file-level' — paths and counts ONLY, under an explicit "may be from
 *                  an older commit" header. NO symbol names: symbol claims
 *                  fail closed when the graph is not exact-commit-fresh
 *                  (same pillar as `narrowBySymbols`).
 *
 * Symbol-sparse files (regex Python/Rust — no `importSymbols`) render
 * imports/exports only; no placeholder symbol text is ever emitted.
 */

import type { FileNeighborhood } from './neighbors.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default max tokens for the graph-neighborhood context sidecar. */
export const DEFAULT_GRAPH_CONTEXT_MAX_TOKENS = 1_200;

/** Approximate characters per token for budget estimation. */
const CHARS_PER_TOKEN = 4;

// ─── Types ──────────────────────────────────────────────────────

export interface FormatGraphNeighborhoodOptions {
  /** Maximum tokens for the formatted output. Clamped to >= 0. */
  maxTokens: number;
  /** 'exact' renders symbols; 'file-level' renders paths and counts only. */
  freshness: 'exact' | 'file-level';
}

/** Formatter outcome with the counts the gather step reports as metadata. */
export interface GraphNeighborhoodFormatResult {
  /** The formatted context ('' when nothing fits or nothing to render). */
  context: string;
  /** How many neighborhood entries were rendered into the context. */
  renderedFiles: number;
}

// ─── Formatter ──────────────────────────────────────────────────

/**
 * Format neighborhoods into a budgeted context string (design contract).
 * See `formatGraphNeighborhood` for the stats-carrying variant used by
 * the gather step.
 */
export function formatGraphNeighborhoodContext(
  neighborhoods: FileNeighborhood[],
  opts: FormatGraphNeighborhoodOptions,
): string {
  return formatGraphNeighborhood(neighborhoods, opts).context;
}

/**
 * Budgeted formatter returning render counts for `graphContextMetadata`
 * (`filesCovered` / `truncatedFiles` — budget-dropped files are the
 * "Budget overflow" row of the degradation ladder).
 */
export function formatGraphNeighborhood(
  neighborhoods: FileNeighborhood[],
  opts: FormatGraphNeighborhoodOptions,
): GraphNeighborhoodFormatResult {
  if (neighborhoods.length === 0) return { context: '', renderedFiles: 0 };

  const maxTokens = Math.max(0, opts.maxTokens);
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const fileLevel = opts.freshness === 'file-level';

  const header = fileLevel
    ? 'Graph neighborhood (file-level; symbol detail omitted — this data may be from an older commit):'
    : 'Graph neighborhood (exact-commit graph):';
  // The header is always rendered when there is anything to show. Join
  // newlines count against the budget so rendered bytes never exceed it.
  let totalChars = header.length;
  const entries: string[] = [];
  let renderedFiles = 0;

  for (const hood of neighborhoods) {
    const entry = fileLevel ? formatFileLevelEntry(hood) : formatExactEntry(hood);
    const joinChars = 1; // '\n' between parts
    if (totalChars + joinChars + entry.length > maxChars) continue;
    entries.push(entry);
    totalChars += joinChars + entry.length;
    renderedFiles += 1;
  }

  if (entries.length === 0) return { context: '', renderedFiles: 0 };

  const parts = [header, ...entries];
  if (renderedFiles < neighborhoods.length) {
    parts.push(
      `_(graph neighborhood truncated to fit ${maxTokens}-token budget; ${renderedFiles} of ${neighborhoods.length} file(s) shown)_`,
    );
  }

  return { context: parts.join('\n'), renderedFiles };
}

// ─── Per-file Entry Formatting ──────────────────────────────────

function formatExactEntry(hood: FileNeighborhood): string {
  const lines: string[] = [`- ${hood.file}${hood.isTest ? ' (test file)' : ''}`];

  if (hood.importers.length > 0) {
    lines.push(`  imported by: ${hood.importers.join(', ')}`);
  }
  if (hood.importees.length > 0) {
    lines.push(`  imports: ${hood.importees.join(', ')}`);
  }
  if (hood.exportedSymbols.length > 0) {
    lines.push(`  exports: ${hood.exportedSymbols.join(', ')}`);
  }
  // Symbol note ONLY for symbol-dense files — a symbol-sparse file
  // (regex Python/Rust extractor) degrades to imports/exports above and
  // never sees placeholder symbol text.
  if ((hood.importedSymbolEdges ?? 0) > 0) {
    lines.push(`  symbol-named imports from ${hood.importedSymbolEdges} dependency file(s)`);
  }
  if (hood.truncated) {
    lines.push('  (per-file lists truncated to caps)');
  }

  return lines.join('\n');
}

function formatFileLevelEntry(hood: FileNeighborhood): string {
  // Paths and counts ONLY — no symbol names (freshness fail-closed).
  const testMark = hood.isTest ? ' (test file)' : '';
  return `- ${hood.file}${testMark}: ${hood.importers.length} importer(s), ${hood.importees.length} import(s)`;
}
