/**
 * Fulfilled-response sanity validation for multi-voice review modes.
 *
 * A voice (specialist / stance vote / lens) whose generateFn FULFILLS can
 * still be a dead voice: some gateways return HTTP 200 whose "text" is a
 * raw CLI error envelope instead of a review. Live example (Claude CLI via
 * the cli-bridge gateway):
 *
 *   {"type":"result","subtype":"error_max_turns","is_error":true,...}
 *
 * Without validation such a voice is counted as a success and its error
 * JSON pollutes the synthesis/vote/merge step. This module provides a
 * narrow, cheap heuristic so all multi-voice modes (workflow, consensus,
 * fan-out) can route these responses into their existing failure paths.
 *
 * The heuristic is deliberately conservative: only the WHOLE trimmed text
 * parsing as a JSON object with error-envelope markers (or being empty)
 * counts. A legitimate review that merely CONTAINS the word "error" — or
 * even embeds an error JSON snippet inside prose — is never rejected.
 */

/**
 * Inspect a fulfilled voice response and return a failure reason when the
 * text is unusable, or `null` when the response looks like a real review.
 *
 * Treated as dead:
 * - empty / whitespace-only text
 * - text that is entirely a JSON object with `is_error === true`
 * - text that is entirely a JSON object with `type === 'result'` and a
 *   `subtype` string starting with `error` (Claude CLI error envelope)
 *
 * Never throws.
 */
export function getDeadVoiceReason(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return 'voice returned empty response text';
  }

  // Cheap gate: only a full-body JSON object can be an error envelope.
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not valid JSON — treat as normal review text.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.is_error === true) {
    return 'voice returned an error envelope instead of a review (is_error: true)';
  }

  if (
    envelope.type === 'result' &&
    typeof envelope.subtype === 'string' &&
    envelope.subtype.startsWith('error')
  ) {
    return `voice returned an error envelope instead of a review (subtype: ${envelope.subtype})`;
  }

  return null;
}
