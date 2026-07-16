/**
 * Invisible correlation marker for posted issue-draft comments.
 *
 * When the approve route posts a draft body to a GitHub issue, it appends an
 * HTML comment marker carrying the draft's internal id:
 *
 *   <!-- ghagga-issue-draft:123 -->
 *
 * The marker is invisible in rendered Markdown (an HTML comment), but lets the
 * stuck-APPROVED REAPER (queues/issue-draft-reaper.ts) match a live GitHub
 * comment back to the exact draft that produced it — so a crash between
 * postComment succeeding and the DB recording POSTED can be recovered WITHOUT
 * double-posting. Only the POSTED comment carries the marker; the stored
 * draft.body stays clean.
 *
 * This mirrors the review path's `<!-- ghagga-review -->` marker convention
 * (github/client.ts findExistingComment), but is per-draft (carries the id) so
 * the reaper can disambiguate one draft's comment from another's.
 */

/**
 * Build the per-draft marker string: `<!-- ghagga-issue-draft:${draftId} -->`.
 */
export function buildIssueDraftMarker(draftId: number): string {
  return `<!-- ghagga-issue-draft:${draftId} -->`;
}

/**
 * Append this draft's marker to a comment body. The marker goes on its own
 * trailing line (separated by a blank line) so it never interferes with the
 * rendered body. Returns a NEW string — the input body is not mutated.
 */
export function appendIssueDraftMarker(body: string, draftId: number): string {
  return `${body}\n\n${buildIssueDraftMarker(draftId)}`;
}

/**
 * True iff `commentBody` contains THIS draft's marker exactly. Uses a substring
 * match on the full marker (which embeds the id), so draft 12's marker never
 * matches draft 1's or draft 123's — the trailing ` -->` bounds the id.
 */
export function commentHasIssueDraftMarker(commentBody: string, draftId: number): boolean {
  return commentBody.includes(buildIssueDraftMarker(draftId));
}
