/**
 * Memory search — retrieves relevant past observations for prompt injection.
 *
 * Builds a search query from the file paths in the current diff,
 * then uses the MemoryStorage interface to find observations from
 * past reviews of the same project.
 */

import type { MemoryStorage } from '../types.js';
import { formatMemoryContext } from './context.js';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of search terms to include in a query. */
export const MAX_SEARCH_TERMS = 10;

/** Minimum length for a path segment to be considered a useful search term. */
const MIN_TERM_LENGTH = 3;

/**
 * Default set of path segments to ignore when building search queries.
 * These are common directory names that carry no semantic value.
 */
export const DEFAULT_IGNORED_SEGMENTS = new Set([
  'src',
  'lib',
  'dist',
  'build',
  'out',
  'output',
  'node_modules',
  'vendor',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '__fixtures__',
  '__snapshots__',
  '.git',
  '.github',
  '.vscode',
  'coverage',
  'tmp',
  'temp',
]);

/**
 * Regex that strips all file extensions from a filename,
 * including multi-part extensions like `.test.ts`, `.spec.tsx`, `.d.ts`.
 *
 * Matches one or more consecutive `.ext` groups at the end of the string
 * where each extension part is alphanumeric (1-10 chars).
 */
const EXTENSIONS_RE = /(?:\.[a-zA-Z0-9]{1,10})+$/;

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Build a search query from file paths.
 *
 * Extracts meaningful segments from file paths (directory names,
 * file names without extensions) to use as search terms.
 *
 * @param fileList - List of file paths to extract terms from.
 * @param ignoredSegments - Optional set of path segments to ignore.
 *   Defaults to {@link DEFAULT_IGNORED_SEGMENTS}.
 *
 * @example
 *   ["src/auth/login.ts", "lib/db/pool.ts"]
 *   → "auth login pool"
 *
 * @example
 *   ["src/auth/login.test.ts"]
 *   → "auth login"   // multi-part extension fully stripped
 */
export function buildSearchQuery(
  fileList: string[],
  ignoredSegments: Set<string> = DEFAULT_IGNORED_SEGMENTS,
): string {
  const terms = new Set<string>();

  for (const filePath of fileList) {
    // Split path into segments
    const segments = filePath.split('/').filter(Boolean);

    for (const segment of segments) {
      // Skip uninformative directories
      if (ignoredSegments.has(segment)) {
        continue;
      }

      // Remove all file extensions (handles .test.ts, .spec.tsx, .d.ts, etc.)
      const name = segment.replace(EXTENSIONS_RE, '');
      if (name.length >= MIN_TERM_LENGTH) {
        terms.add(name);
      }
    }
  }

  return [...terms].slice(0, MAX_SEARCH_TERMS).join(' ');
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Search past review observations for context relevant to the current diff.
 *
 * Returns a formatted string suitable for injection into agent prompts,
 * or null if no relevant observations are found (or if storage is unavailable).
 *
 * @param storage - Memory storage backend (SQLite or PostgreSQL)
 * @param project - Project identifier (e.g., "owner/repo")
 * @param fileList - List of file paths in the current diff
 * @returns Formatted memory context string, or null
 */
export async function searchMemoryForContext(
  storage: MemoryStorage,
  project: string,
  fileList: string[],
): Promise<string | null> {
  try {
    if (!storage) return null;

    const query = buildSearchQuery(fileList);
    if (!query) return null;

    // Search with a reasonable limit — we don't want to flood the prompt
    const observations = await storage.searchObservations(project, query, { limit: 3 });

    if (!observations || observations.length === 0) return null;

    // Format observations for prompt injection
    return formatMemoryContext(
      observations.map((obs) => ({
        type: obs.type,
        title: obs.title,
        content: obs.content,
        strength: obs.strength,
      })),
    );
  } catch (error) {
    // Memory is optional — never let it break the review pipeline
    console.warn(
      '[ghagga] Memory search failed (degrading gracefully):',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
