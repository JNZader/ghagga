/**
 * Memory search — retrieves relevant past observations for prompt injection.
 *
 * Builds a search query from the file paths in the current diff,
 * then uses the MemoryStorage interface to find observations from
 * past reviews of the same project.
 */

import type { MemoryObservationRow, MemoryStorage } from '../types.js';
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

// ─── Issue Dedup (Phase 3) ──────────────────────────────────────
//
// The PR review path keys memory search off FILE-PATH segments
// (`buildSearchQuery` above). GitHub ISSUES carry no file paths, so the
// triage agent needs a different query builder: one that mines meaningful
// KEYWORDS out of the issue title + body. The two builders are deliberately
// kept separate (design D4) — issues are prose, diffs are paths.
//
// SCOPE NOTE (carried from Phase 2 review): the dedup query here consumes ONLY
// the issue TITLE + BODY, so there is no comment-count fan-out to cap on this
// surface. The DoS concern (capping the NUMBER of comments fetched) belongs to
// the Phase 3 FETCH side / Phase 4 ingestion worker, which must bound how many
// comments it pulls before handing them to the agent — NOT here.

/** Maximum number of keyword terms to include in an issue dedup query. */
export const MAX_ISSUE_SEARCH_TERMS = 12;

/** Minimum length for an issue keyword to be considered useful. */
const MIN_ISSUE_TERM_LENGTH = 3;

/**
 * Conservative dedup score threshold. A candidate is treated as a hard
 * DUPLICATE only when the TOP match's score (decay `strength`, 0..1) is at
 * or above this value. Weak matches are still surfaced as candidates (they
 * become `memoryContext` for the agent + `dedupMatches` on the draft) but they
 * MUST NOT block: false-positive dedup would silently bury a legitimate new
 * issue. Default is intentionally high; tune with real issues (design D4 /
 * spec "never blocks on weak matches").
 */
export const DEDUP_SCORE_THRESHOLD = 0.6;

/**
 * Common English stopwords plus issue-tracker boilerplate. Dropped from issue
 * dedup queries because they carry no discriminating signal. Kept small and
 * lowercase — this is a heuristic, not an NLP pipeline.
 */
const ISSUE_STOPWORDS = new Set([
  // articles / conjunctions / prepositions
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'any',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'him',
  'his',
  'how',
  'its',
  'who',
  'did',
  'yes',
  'get',
  'with',
  'this',
  'that',
  'from',
  'they',
  'will',
  'would',
  'there',
  'their',
  'what',
  'when',
  'where',
  'which',
  'while',
  'have',
  'been',
  'were',
  'into',
  'than',
  'then',
  'them',
  'some',
  'such',
  'only',
  'also',
  'over',
  'after',
  'before',
  'about',
  'because',
  'should',
  'could',
  'does',
  // issue-tracker boilerplate
  'issue',
  'bug',
  'error',
  'problem',
  'please',
  'thanks',
  'repro',
  'steps',
  'expected',
  'actual',
  'behavior',
  'behaviour',
]);

/**
 * Strip markdown code fences and inline code from issue text. Code blocks are
 * the #1 source of noise tokens (variable names, language keywords) that would
 * pollute a keyword query, so they are removed BEFORE tokenization.
 */
function stripCode(text: string): string {
  return (
    text
      // Fenced blocks: ```lang\n...\n``` (and ~~~ fences). Non-greedy, multiline.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      // Inline code: `token`
      .replace(/`[^`]*`/g, ' ')
  );
}

/**
 * Build a keyword search query from an issue's title + body.
 *
 * Pipeline: strip code → lowercase → split on non-word chars → drop stopwords
 * and short tokens → dedupe (preserving first-seen order) → cap at
 * {@link MAX_ISSUE_SEARCH_TERMS}. Title terms come first so the most salient
 * keywords survive the cap.
 *
 * @param issueTitle - The issue title (untrusted prose).
 * @param issueBody  - The issue body (untrusted markdown prose).
 * @returns A space-joined keyword query, or '' when no useful terms remain.
 *
 * @example
 *   buildIssueSearchQuery('Login button throws TypeError on Safari', '…')
 *   → "login button throws typeerror safari …"
 */
export function buildIssueSearchQuery(issueTitle: string, issueBody: string): string {
  // Title first → its keywords rank ahead of the body's under the term cap.
  const raw = `${issueTitle ?? ''}\n${issueBody ?? ''}`;
  const cleaned = stripCode(raw).toLowerCase();

  const terms = new Set<string>();
  for (const token of cleaned.split(/[^a-z0-9]+/)) {
    if (token.length < MIN_ISSUE_TERM_LENGTH) continue;
    if (ISSUE_STOPWORDS.has(token)) continue;
    terms.add(token);
    if (terms.size >= MAX_ISSUE_SEARCH_TERMS) break;
  }

  return [...terms].join(' ');
}

/**
 * A candidate duplicate surfaced by issue dedup.
 *
 * NOTE: structurally identical to `IssueDedupMatch` in the db package
 * (`ghagga-db` schema.ts:189). We do NOT import that type — `packages/core`
 * has no dependency on the db package, and adding one for a 3-field shape would
 * introduce a new core→db coupling edge (mirrors the Phase 2 `IssueTriageSource`
 * decision). TypeScript's structural typing makes `IssueDedupMatch[]` here
 * assignable to the db `IssueDedupMatch[]` at the Phase 4 worker boundary.
 */
export interface IssueDedupMatch {
  /** Matched memory observation id. */
  observationId: number;
  /** Matched observation title (for the draft's "likely duplicate" citation). */
  title: string;
  /** Match score in [0,1] (decay `strength`; 0 when strength is absent). */
  score: number;
}

/** Result of an issue dedup pass. */
export interface IssueDedupResult {
  /** The keyword query that was searched ('' when issue text was degenerate). */
  query: string;
  /** Candidate matches, ordered by score descending. May be empty. */
  matches: IssueDedupMatch[];
  /**
   * True ONLY when the top match's score ≥ {@link DEDUP_SCORE_THRESHOLD}.
   * Weak matches are still returned in `matches` but never set this flag — the
   * worker uses this to decide a DUPLICATE draft vs. continuing to full analysis.
   */
  isDuplicate: boolean;
}

/** Map a raw observation row to a dedup match (score = decay strength, default 0). */
function toDedupMatch(row: MemoryObservationRow): IssueDedupMatch {
  return {
    observationId: row.id,
    title: row.title,
    score: row.strength ?? 0,
  };
}

/**
 * Search memory for issues similar to the given one, using a keyword query
 * built from the issue title + body.
 *
 * Conservative by design: it NEVER hard-blocks on weak similarity. It returns
 * all candidate matches (so the agent can cite them as context), but only flags
 * `isDuplicate` when the strongest match clears {@link DEDUP_SCORE_THRESHOLD}.
 * Like {@link searchMemoryForContext}, it degrades gracefully — storage errors
 * or a missing backend yield an empty, non-duplicate result rather than throwing
 * (the triage pipeline must never crash on optional memory).
 *
 * @param storage - Memory storage backend (may be null/undefined → empty result).
 * @param project - Project identifier (e.g., "owner/repo").
 * @param issueTitle - Issue title (untrusted).
 * @param issueBody  - Issue body (untrusted).
 */
export async function findIssueDuplicates(
  storage: MemoryStorage,
  project: string,
  issueTitle: string,
  issueBody: string,
): Promise<IssueDedupResult> {
  const empty: IssueDedupResult = { query: '', matches: [], isDuplicate: false };

  try {
    if (!storage) return empty;

    const query = buildIssueSearchQuery(issueTitle, issueBody);
    if (!query) return empty;

    const observations = await storage.searchObservations(project, query, { limit: 5 });
    if (!observations || observations.length === 0) {
      return { query, matches: [], isDuplicate: false };
    }

    const matches = observations.map(toDedupMatch).sort((a, b) => b.score - a.score);

    // Conservative: only the TOP (highest-scoring) match gates the duplicate flag.
    const isDuplicate = matches.length > 0 && matches[0].score >= DEDUP_SCORE_THRESHOLD;

    return { query, matches, isDuplicate };
  } catch (error) {
    // Memory is optional — never let dedup break the triage pipeline.
    console.warn(
      '[ghagga] Issue dedup search failed (degrading gracefully):',
      error instanceof Error ? error.message : String(error),
    );
    return empty;
  }
}
