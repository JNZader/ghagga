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
 * Hard cap on the length of untrusted issue text fed into keyword extraction.
 *
 * Issue title+body is attacker-controlled (anyone can open an issue) and enters
 * {@link stripCode} / {@link extractIssueTerms} / {@link tokenizeIssueText} with
 * no natural bound. Keyword extraction only needs a small prefix to find salient
 * terms, so we truncate before ANY scanning runs — this is a defense-in-depth
 * DoS guard (paired with the linear-time fence stripper) so no pathological
 * input can pin the event loop. 10k chars is far more than enough signal for a
 * keyword query; the excess is dropped.
 */
export const MAX_ISSUE_TEXT_LENGTH = 10000;

/**
 * Observation type under which triaged issues are persisted in memory.
 *
 * SHARED CONSTANT — dedup scopes its memory search to THIS type so it only
 * matches prior issue-origin observations, not arbitrary memory (patterns,
 * bugfixes, PR notes). Phase 4's save-path MUST persist every triaged issue
 * under EXACTLY this `type`, or dedup will find nothing.
 *
 * CARRY-FORWARD NOTE (Phase 4): when the ingestion worker saves a triaged issue
 * via `storage.saveObservation`, set `type: ISSUE_TRIAGE_OBSERVATION_TYPE`.
 * Until that save-path lands, `findIssueDuplicates` will correctly return an
 * empty, non-duplicate result (there is nothing of this type to match) — that
 * is EXPECTED, not a bug.
 */
export const ISSUE_TRIAGE_OBSERVATION_TYPE = 'issue-triage';

/**
 * Conservative dedup similarity threshold, in [0,1].
 *
 * A candidate is treated as a hard DUPLICATE only when its KEYWORD-OVERLAP
 * similarity to the issue (see {@link issueOverlapScore}) is at or above this
 * value. Weak matches are still surfaced as candidates (they become
 * `memoryContext` for the agent + `dedupMatches` on the draft) but MUST NOT
 * block: a false-positive dedup would silently bury a legitimate new issue.
 *
 * WHY KEYWORD OVERLAP (not the adapter's bm25/ts_rank `relevanceScore`):
 * the three storage backends expose incomparable native signals — SQLite bm25
 * (unbounded), Postgres ts_rank (small positive), and Engram NONE at all
 * (its REST search returns no score). Gating on `relevanceScore` would give a
 * single threshold three different meanings and silently DISABLE dedup on
 * Engram. Instead we gate on a backend-AGNOSTIC Jaccard overlap of the dedup
 * query terms against the candidate's title+content — identical math for all
 * three backends, so one absolute threshold is genuinely meaningful and
 * comparable. (The adapter `relevanceScore` is still surfaced on rows as
 * telemetry and could graduate to the gate if Engram ever exposes scores.)
 *
 * 0.6 = "≥60% of the issue's distinctive keywords also appear in the prior
 * observation". This is intentionally conservative: it prefers FALSE NEGATIVES
 * (miss a dup → the agent/human still sees the candidate as context) over
 * FALSE POSITIVES (wrongly suppress analysis of a real new issue). Tune with
 * real issues. NOTE: re-picked from the old 0.6-on-decay-`strength` value,
 * which gated on pure recency and was meaningless as relevance.
 *
 * SHORT-QUERY DEGRADATION (known v1 limitation): the overlap score is a COARSE
 * step function when the query has few distinctive terms. With a 1-term query a
 * single shared token yields score 1.0 (a guaranteed false-positive on the
 * gate); with 2 terms the only scores possible are 0 / 0.5 / 1.0, so 0.6
 * collapses to "share both terms". To avoid auto-suppressing a real issue on too
 * little signal, {@link findIssueDuplicates} additionally requires the query to
 * carry at least {@link MIN_DEDUP_QUERY_TERMS} distinctive terms before it will
 * EVER set `isDuplicate`. A 1-term query therefore never auto-flags — it still
 * SURFACES candidates (they appear in `matches` as context for the agent/human),
 * it just never hard-blocks. (The proper fix is IDF/semantic similarity in a
 * later phase; the term-count floor is the conservative v1 guard.)
 */
export const DEDUP_SCORE_THRESHOLD = 0.6;

/**
 * Minimum number of distinctive query terms required before issue dedup will set
 * `isDuplicate` (hard-block). Below this floor the keyword-overlap score carries
 * too little signal — a 1-term query flags on a single shared token (1.0) — so
 * dedup only SURFACES candidates as context and never auto-suppresses. See the
 * SHORT-QUERY DEGRADATION note on {@link DEDUP_SCORE_THRESHOLD}.
 */
export const MIN_DEDUP_QUERY_TERMS = 2;

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
  'using',
  'via',
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
 * Strip fenced code blocks delimited by a run of `fence` chars, in LINEAR time.
 *
 * Contract (matches the previous backreference regex for normal inputs): an
 * opening run of N (≥3) fence chars is closed by the next run of the SAME N
 * chars found via `indexOf` (linear scan). A longer opening fence (e.g. a 4-tick
 * ````md block) therefore swallows any shorter ``` fences nested inside it,
 * because a shorter inner run can never match the N-char closing token. An
 * unterminated fence is left as literal text.
 *
 * This replaces the old `/(`{3,})[\s\S]*?\1/g` backreference regex, whose
 * catastrophic backtracking was an empirically verified ReDoS on attacker-
 * controlled issue text. `indexOf` cannot backtrack, so this is O(n).
 */
function stripFencedBlocks(text: string, fence: string): string {
  const n = text.length;
  let out = '';
  let last = 0; // start of the pending literal span not yet flushed to `out`
  let i = 0;
  while (i < n) {
    if (text[i] !== fence) {
      i++;
      continue;
    }
    // Measure the run of fence chars starting at i.
    let j = i + 1;
    while (j < n && text[j] === fence) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      const closeIdx = text.indexOf(fence.repeat(runLen), j);
      if (closeIdx !== -1) {
        // Flush the literal span before this fence, then collapse the block.
        out += `${text.slice(last, i)} `;
        i = closeIdx + runLen;
        last = i;
        continue;
      }
    }
    // Run < 3, or unterminated fence → treat as literal and keep scanning.
    i = j;
  }
  out += text.slice(last);
  return out;
}

/**
 * Strip markdown code fences and inline code from issue text. Code blocks are
 * the #1 source of noise tokens (variable names, language keywords) that would
 * pollute a keyword query, so they are removed BEFORE tokenization.
 *
 * Untrusted issue text is hard-capped at {@link MAX_ISSUE_TEXT_LENGTH} before
 * any scanning — a defensive DoS guard so no pathological input can pin the
 * event loop during keyword extraction.
 */
function stripCode(text: string): string {
  const capped = text.length > MAX_ISSUE_TEXT_LENGTH ? text.slice(0, MAX_ISSUE_TEXT_LENGTH) : text;
  return (
    // Backtick fences first, then tilde fences (same contract), then inline code.
    stripFencedBlocks(stripFencedBlocks(capped, '`'), '~')
      // Inline code: `token` (linear — no backreference).
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
  // SINGLE SOURCE OF TRUTH: share the exact tokenization pipeline with
  // `tokenizeIssueText` (strip code → lowercase → split → drop stopwords +
  // short tokens). Here we additionally cap at MAX_ISSUE_SEARCH_TERMS so the
  // most salient (title-first) keywords survive.
  const terms = extractIssueTerms(raw, MAX_ISSUE_SEARCH_TERMS);
  return [...terms].join(' ');
}

/**
 * Tokenize arbitrary issue/observation text into the SAME bag of meaningful
 * keyword terms `buildIssueSearchQuery` uses (strip code → lowercase → split on
 * non-word chars → drop stopwords + short tokens), WITHOUT the term cap.
 *
 * Used to score keyword overlap between an issue and a candidate observation.
 * Sharing the {@link extractIssueTerms} pipeline guarantees the overlap math
 * compares like-for-like tokens on both sides.
 */
function tokenizeIssueText(text: string): Set<string> {
  return extractIssueTerms(text);
}

/**
 * Shared tokenization pipeline — the SINGLE SOURCE OF TRUTH for turning issue /
 * observation prose into a deduped bag of meaningful keyword terms:
 * strip code → lowercase → split on non-word chars → drop stopwords + tokens
 * shorter than {@link MIN_ISSUE_TERM_LENGTH}, preserving first-seen order.
 *
 * Both {@link buildIssueSearchQuery} (capped) and {@link tokenizeIssueText}
 * (uncapped) delegate here so the QUERY side and the CANDIDATE side are always
 * tokenized identically — a prerequisite for the overlap score to be meaningful.
 *
 * @param text - Raw text to tokenize (may be null/undefined → empty set).
 * @param cap  - Optional max number of terms (stops early once reached).
 *   Undefined ⇒ uncapped. See the asymmetric-cap note on {@link issueOverlapScore}.
 */
function extractIssueTerms(text: string, cap?: number): Set<string> {
  const cleaned = stripCode(text ?? '').toLowerCase();
  const terms = new Set<string>();
  for (const token of cleaned.split(/[^a-z0-9]+/)) {
    if (token.length < MIN_ISSUE_TERM_LENGTH) continue;
    if (ISSUE_STOPWORDS.has(token)) continue;
    terms.add(token);
    if (cap !== undefined && terms.size >= cap) break;
  }
  return terms;
}

/**
 * Backend-AGNOSTIC keyword-overlap similarity in [0,1] between an issue's dedup
 * query terms and a candidate observation's text.
 *
 * Score = |queryTerms ∩ candidateTerms| / |queryTerms|  (overlap coefficient,
 * normalized by the QUERY side). Bounded, monotonic in shared keywords, and —
 * crucially — identical math for EVERY backend, so {@link DEDUP_SCORE_THRESHOLD}
 * means the same thing whether the candidate came from SQLite, Postgres, or the
 * score-less Engram. This is NOT per-query-top normalization: a candidate that
 * shares 1 of 8 query terms scores 0.125, not 1.0 — only a candidate echoing
 * MOST of the issue's distinctive keywords clears the bar.
 *
 * KNOWN v1 LIMITATIONS (accepted trade-offs — dedup FLAGS, never hard-blocks,
 * and semantic similarity is the Phase-N upgrade):
 *   (a) IDF-BLIND + ASYMMETRIC TERM CAP. Every shared term counts equally — a
 *       boilerplate term weighs the same as a rare distinctive one (no inverse
 *       document frequency). Compounding this, the QUERY side is capped at
 *       {@link MAX_ISSUE_SEARCH_TERMS} (via buildIssueSearchQuery) while the
 *       CANDIDATE side ({@link tokenizeIssueText}) is UNCAPPED. Since the score
 *       normalizes by the (capped) query term set, a verbose candidate that
 *       happens to echo the query's capped terms can score high — a directional
 *       bias toward verbose candidates. Accepted for v1: the gate flags, a human
 *       still adjudicates.
 *
 * @param queryTerms - The deduped issue keyword terms (from the dedup query).
 * @param candidateText - The candidate observation's title + content.
 */
function issueOverlapScore(queryTerms: Set<string>, candidateText: string): number {
  if (queryTerms.size === 0) return 0;
  const candidateTerms = tokenizeIssueText(candidateText);
  if (candidateTerms.size === 0) return 0;

  let shared = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) shared++;
  }
  return shared / queryTerms.size;
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
  /**
   * Match score in [0,1] — the backend-AGNOSTIC keyword-overlap similarity
   * between the issue's dedup query terms and this observation's title+content
   * (see {@link issueOverlapScore}). This is the signal {@link DEDUP_SCORE_THRESHOLD}
   * gates on. It is NOT the adapter's `relevanceScore` (bm25/ts_rank), which is
   * incomparable across backends and absent on Engram.
   */
  score: number;
  /**
   * The adapter's native keyword RELEVANCE for this row (saturating bm25/ts_rank
   * → [0,1]), passed through for observability/telemetry. Undefined on backends
   * that expose no relevance score (Engram). NOT used by the dedup gate.
   */
  relevanceScore?: number;
}

/** Result of an issue dedup pass. */
export interface IssueDedupResult {
  /** The keyword query that was searched ('' when issue text was degenerate). */
  query: string;
  /** Candidate matches, ordered by score descending. May be empty. */
  matches: IssueDedupMatch[];
  /**
   * True ONLY when the top match's keyword-overlap score ≥
   * {@link DEDUP_SCORE_THRESHOLD} AND the query carried at least
   * {@link MIN_DEDUP_QUERY_TERMS} distinctive terms (the short-query guard — a
   * 1-term query never auto-flags). Weak/under-signalled matches are still
   * returned in `matches` but never set this flag — the worker uses this to
   * decide a DUPLICATE draft vs. continuing to full analysis.
   */
  isDuplicate: boolean;
}

/**
 * Map a raw observation row to a dedup match. `score` is the backend-agnostic
 * keyword-OVERLAP similarity (the gate signal); the adapter's native
 * `relevanceScore` is passed through for observability only.
 */
function toDedupMatch(row: MemoryObservationRow, queryTerms: Set<string>): IssueDedupMatch {
  return {
    observationId: row.id,
    title: row.title,
    score: issueOverlapScore(queryTerms, `${row.title}\n${row.content}`),
    relevanceScore: row.relevanceScore,
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

    // Scope to issue-origin observations ONLY (shared type constant) so dedup
    // never matches arbitrary memory (patterns, bugfixes, PR notes).
    //
    // KNOWN v1 LIMITATION (b) — STEMMING MISMATCH (accepted trade-off): on
    // Postgres, RETRIEVAL uses `to_tsquery('english', …)` which stems terms
    // (throw/throws/throwing collapse to one root), but the overlap SCORER below
    // ({@link issueOverlapScore} / {@link tokenizeIssueText}) does exact-token
    // matching with NO stemming. So Postgres may RETRIEVE a morphological variant
    // that the scorer then fails to credit (throw vs throws → counted as
    // non-overlapping) → morphological FALSE NEGATIVES. Acceptable for v1: dedup
    // is conservative-by-design (prefers misses over false suppressions); a
    // stemmed/semantic scorer is the Phase-N upgrade.
    const observations = await storage.searchObservations(project, query, {
      limit: 5,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    if (!observations || observations.length === 0) {
      return { query, matches: [], isDuplicate: false };
    }

    // Gate on backend-agnostic keyword overlap (see DEDUP_SCORE_THRESHOLD docs):
    // measure each candidate's overlap with the SAME deduped query terms.
    const queryTerms = new Set(query.split(/\s+/).filter(Boolean));
    const matches = observations
      .map((row) => toDedupMatch(row, queryTerms))
      .sort((a, b) => b.score - a.score);

    // Conservative gate: only the TOP (highest-overlap) match can flag a dup, AND
    // ONLY when the query carries enough distinctive terms for the overlap score
    // to be meaningful. Below MIN_DEDUP_QUERY_TERMS the score is a coarse step
    // function (a 1-term query scores 1.0 on a single shared token), so we never
    // auto-suppress — candidates are still surfaced in `matches` as context, they
    // just don't hard-block. See SHORT-QUERY DEGRADATION on DEDUP_SCORE_THRESHOLD.
    const isDuplicate =
      queryTerms.size >= MIN_DEDUP_QUERY_TERMS &&
      matches.length > 0 &&
      matches[0].score >= DEDUP_SCORE_THRESHOLD;

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
