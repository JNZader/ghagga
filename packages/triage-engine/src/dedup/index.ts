/**
 * Issue DEDUP helpers — the local-engine mirror of the SERVER worker's dedup
 * stage (apps/server/src/queues/issue-analysis.ts `processIssueAnalysis`).
 *
 * The engine (engine.ts) runs `findIssueDuplicates` from `ghagga-core` BEFORE
 * the expensive LLM triage. On a confident hit it builds a DUPLICATE-kind draft
 * (skipping the analysis LLM call, exactly like the server) using
 * {@link buildDuplicateReport} / {@link buildDuplicateReply}. On a MISS it
 * persists the issue to memory via {@link buildObservationContent} so future
 * issues dedup against it.
 *
 * SELF-MATCH GUARD: memory is keyed by a STABLE observation title derived from
 * the issue's iid (+repo), NOT its mutable human title ({@link
 * issueObservationTitle}). On a RE-triage the issue's OWN prior observation
 * would otherwise be returned as a "duplicate of itself" — the server sidesteps
 * this with its Stage-0 open-draft short-circuit; locally {@link
 * excludeSelfMatch} drops the self row (matched by that stable id, so a title
 * edit between triages can't break it) and re-derives `isDuplicate`.
 */

import {
  DEDUP_SCORE_THRESHOLD,
  formatMemoryContext,
  ISSUE_TRIAGE_OBSERVATION_TYPE,
  type IssueComment,
  type IssueDedupMatch,
  type IssueDedupResult,
} from 'ghagga-core';

/**
 * Per-comment body cap when folding comments into the saved observation.
 * Mirrors the server's OBSERVATION_COMMENT_BODY_CAP — a second-line defense
 * against context blowup from an attacker-controlled comment.
 */
export const OBSERVATION_COMMENT_BODY_CAP = 500;

/**
 * Hard cap on the stored issue body. The QUERY side already caps untrusted
 * issue text at `MAX_ISSUE_TEXT_LENGTH = 10000` (ghagga-core memory/search),
 * so the STORED side matches that order of magnitude — dedup only needs the
 * keyword signal, and truncation past this bound never changes an overlap
 * decision while bounding row size against an attacker-controlled body.
 */
export const OBSERVATION_ISSUE_BODY_CAP = 10000;

/**
 * Max number of comments folded into the stored observation. Mirrors the
 * server worker's `MAX_ISSUE_COMMENTS = 20` (apps/server issue-analysis) so a
 * pathological comment count can't blow up a stored row; the per-comment body
 * is additionally capped at {@link OBSERVATION_COMMENT_BODY_CAP}.
 */
export const OBSERVATION_MAX_COMMENTS = 20;

/**
 * Deterministic, STABLE observation title for a triaged issue — the SINGLE
 * SOURCE OF TRUTH used both when PERSISTING the observation and when EXCLUDING
 * the issue's own row from its later dedup result. The two MUST agree or the
 * self-match guard silently breaks.
 *
 * It is derived ONLY from the issue's stable identity (its `iid`, scoped by
 * `repoSlug` when available) — NEVER the human-editable issue title. A
 * maintainer editing the title between first-triage and re-triage must not
 * break self-exclusion (which would flag the issue as a duplicate of itself).
 * The real title's keyword signal is preserved separately by folding it into
 * the observation CONTENT — see {@link buildObservationContent}.
 */
export function issueObservationTitle(iid: string | number, repoSlug?: string): string {
  return repoSlug ? `${repoSlug}#${iid}` : `issue #${iid}`;
}

/**
 * Build the saved observation's content for future dedup. `findIssueDuplicates`
 * builds its keyword query from the stored title + content; because the stored
 * TITLE is now a bare stable id ({@link issueObservationTitle}), the real human
 * `issueTitle` is folded in as the FIRST line so its distinguishing terms still
 * drive keyword overlap. Labels + comments (both already fetched) are folded in
 * too so a later issue whose distinguishing terms live only in a comment or
 * label can still match — mirrors the server's `buildObservationContent`.
 */
export function buildObservationContent(input: {
  issueTitle: string;
  issueBody: string;
  classification: string;
  labels: string[];
  comments?: IssueComment[];
}): string {
  const cappedBody = input.issueBody.slice(0, OBSERVATION_ISSUE_BODY_CAP);
  const parts = [input.issueTitle, cappedBody, `\nClassification: ${input.classification}`];
  if (input.labels.length > 0) {
    parts.push(`\nLabels: ${input.labels.join(', ')}`);
  }
  const comments = (input.comments ?? []).slice(0, OBSERVATION_MAX_COMMENTS);
  if (comments.length > 0) {
    const rendered = comments
      .map(
        (comment) => `- ${comment.author}: ${comment.body.slice(0, OBSERVATION_COMMENT_BODY_CAP)}`,
      )
      .join('\n');
    parts.push(`\nComments:\n${rendered}`);
  }
  return parts.join('\n');
}

/**
 * Drop the issue's OWN prior observation (matched by its deterministic title)
 * from a dedup result and re-derive `isDuplicate`.
 *
 * Preserves the source result's short-query floor: the incoming
 * `dedup.isDuplicate` was only ever true when the query carried enough
 * distinctive terms (MIN_DEDUP_QUERY_TERMS, enforced inside
 * `findIssueDuplicates`). We keep that AND require a REMAINING real match to
 * still clear {@link DEDUP_SCORE_THRESHOLD} — so removing a self row that was
 * the sole driver correctly flips the decision back to "not a duplicate".
 */
export function excludeSelfMatch(dedup: IssueDedupResult, selfTitle: string): IssueDedupResult {
  const matches = dedup.matches.filter((match) => match.title !== selfTitle);
  const isDuplicate =
    dedup.isDuplicate && matches.length > 0 && (matches[0]?.score ?? 0) >= DEDUP_SCORE_THRESHOLD;
  return { query: dedup.query, matches, isDuplicate };
}

/**
 * INTERNAL technical note (NEVER posted) for a DUPLICATE-kind draft. Records
 * that full analysis was skipped and cites the matched prior issues.
 */
export function buildDuplicateReport(matches: IssueDedupMatch[]): string {
  const links = matches
    .map(
      (match) =>
        `- ${match.title} (observation #${match.observationId}, overlap ${match.score.toFixed(2)})`,
    )
    .join('\n');
  return `## Possible duplicate\n\nMemory dedup flagged this issue as similar to prior tracked issue(s):\n\n${links}\n\nFull technical analysis was SKIPPED (token-cost saving) — a human should confirm before closing as a duplicate.`;
}

/**
 * Client-facing reply for a DUPLICATE-kind draft, in the configured client
 * language ('es' default; English when the language starts with 'en'). This is
 * a fixed template — NOT an LLM call — so the DUPLICATE path stays cheap.
 */
export function buildDuplicateReply(matches: IssueDedupMatch[], language: string): string {
  const list = matches.map((match) => `- ${match.title}`).join('\n');
  if (language.toLowerCase().startsWith('en')) {
    return `Thanks for the report. This looks like it may already be tracked in:\n\n${list}\n\nWe'll confirm and follow up there to avoid duplicating the discussion.`;
  }
  return `Gracias por el reporte. Esto parece estar ya registrado en:\n\n${list}\n\nLo vamos a confirmar y darle seguimiento ahí para no duplicar la conversación.`;
}

/**
 * Build a `memoryContext` string from dedup matches so the analysis agent can
 * cite prior issues as situational background on the NON-duplicate path —
 * mirrors the server's `buildMemoryContextFromDedup`. Empty matches → null.
 */
export function buildDedupMemoryContext(matches: IssueDedupMatch[]): string | null {
  if (matches.length === 0) return null;
  const observations = matches.map((match) => ({
    type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    title: match.title,
    content: `Prior issue observation #${match.observationId} (overlap ${match.score.toFixed(2)}).`,
  }));
  return formatMemoryContext(observations) || null;
}
