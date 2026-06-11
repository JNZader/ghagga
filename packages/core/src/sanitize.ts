/**
 * Sanitization for LLM/tool-derived content before it is posted to GitHub.
 *
 * Review output (summary, finding messages, file paths, model labels, ...)
 * is ultimately derived from attacker-controlled PR diffs, so a malicious PR
 * can steer the LLM into emitting payloads that the bot would then post
 * verbatim under its own identity:
 *
 *   - "@org/everyone" mention spam (notification bombing)
 *   - hidden HTML comments (prompt-injection payloads for OTHER bots
 *     reading the thread)
 *   - raw HTML (<script>, <img>, hidden text)
 *   - table-breaking pipes/newlines that smuggle content outside its cell
 *   - megabyte-scale output (comment flooding)
 *
 * These helpers neutralize untrusted VARIABLES only. Trusted markdown
 * literals produced by the formatters themselves (headers, table syntax,
 * the ghagga comment marker) must NOT be passed through these functions.
 */

// ─── Constants ──────────────────────────────────────────────────

/** Zero-width space — breaks GitHub @-mention linkification invisibly. */
const ZERO_WIDTH_SPACE = '\u200b';

/** Default cap for free-form markdown text (e.g. review summary). */
export const SANITIZE_DEFAULT_TEXT_MAX = 2000;

/** Default cap for a single markdown table cell. */
export const SANITIZE_DEFAULT_CELL_MAX = 500;

// ─── Sanitizers ─────────────────────────────────────────────────

/**
 * Sanitize untrusted text for inclusion in a GitHub markdown comment.
 *
 * - strips HTML comments (`<!-- ... -->`, including unterminated openers)
 * - escapes `<` as `&lt;` (blocks raw HTML / hidden payloads)
 * - inserts a zero-width space after every `@` (neutralizes mentions
 *   without visibly altering the text)
 * - collapses control characters (except \n and \t) to spaces
 * - enforces a maximum length, appending an ellipsis when truncated
 */
export function sanitizeMarkdownText(
  input: string,
  maxLength: number = SANITIZE_DEFAULT_TEXT_MAX,
): string {
  let s = input;

  // HTML comments can carry hidden instructions for other bots/agents
  // reading the thread. Strip closed comments, then any unterminated opener.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!--/g, '');

  // Escape raw HTML. This also neutralizes any comment-like remnants.
  s = s.replace(/</g, '&lt;');

  // Neutralize @-mentions: a zero-width space after '@' prevents GitHub
  // from linkifying/notifying while keeping the text readable.
  s = s.replace(/@/g, `@${ZERO_WIDTH_SPACE}`);

  // Collapse control chars (C0 except \t, \n, \r — plus DEL) to spaces;
  // carriage returns are normalized to plain newlines.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-char filter
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
  s = s.replace(/\r\n?/g, '\n');

  if (s.length > maxLength) {
    let truncated = s.slice(0, maxLength);
    // s.slice operates on UTF-16 code units, so the cut can land in the
    // MIDDLE of a surrogate pair (e.g. an emoji like 😀 = U+1F600), leaving a
    // lone high surrogate at the end. A lone surrogate renders as � and can
    // corrupt downstream consumers. If the last code unit is a high surrogate
    // (0xD800–0xDBFF) with no matching low surrogate following, drop it before
    // appending the ellipsis.
    const lastUnit = truncated.charCodeAt(truncated.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      truncated = truncated.slice(0, -1);
    }
    s = `${truncated}…`;
  }

  return s;
}

/**
 * Sanitize untrusted text for a single GitHub markdown table cell.
 *
 * Applies `sanitizeMarkdownText` and additionally escapes pipes and
 * replaces newlines with spaces so the content cannot break out of its
 * cell (or out of the table entirely).
 */
export function sanitizeTableCell(
  input: string,
  maxLength: number = SANITIZE_DEFAULT_CELL_MAX,
): string {
  return sanitizeMarkdownText(input, maxLength).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Validate a GitHub login (username) before @-mentioning it.
 *
 * GitHub rules: 1-39 chars, alphanumeric or single hyphens, may not start
 * or end with a hyphen. Anything else (e.g. "org/everyone", "x[bot]") is
 * rejected — callers should OMIT the mention rather than escape it.
 */
export function isValidGithubLogin(login: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(login);
}
