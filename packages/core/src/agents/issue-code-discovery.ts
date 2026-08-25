/**
 * Deterministic discovery of the repository paths an issue references.
 *
 * The complement to code-in-evidence: instead of a human naming files, extract
 * candidate repo-relative paths from the issue's own text so that (server-side,
 * checkout-less) triage can fetch the code the issue actually talks about.
 *
 * DETERMINISTIC — no model. It finds path-shaped tokens (a slash + a file
 * extension), strips surrounding markdown/punctuation, and dedupes them in
 * first-appearance order. It never fetches: the caller fetches each best-effort
 * (a mentioned path may be missing or renamed) and skips the misses. Ported from
 * the evidence-review-engine (ERE) `collectors/issue-code-discovery.ts`.
 *
 * ReDoS-hardened for attacker-authored input (an issue is openable by ANYONE):
 * `PATH_TOKEN` is ANCHORED to a whole whitespace-delimited token and matched PER
 * token (never a global scan over the full text), and over-long no-whitespace
 * blobs are skipped — so no pathological run of `.`/`-`/`/` can drive quadratic
 * backtracking, and a URL like `https://host/a/b.ts` fails the `://` reject.
 */

/** A path-shaped token: `dir/.../file.ext` — segments of `[\w.-]`, ending in `.ext`. */
const PATH_TOKEN = /^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]+$/;
const DEFAULT_LIMIT = 10;
/** Cap the scanned text (defensive belt) — the attacker controls issue/comment bodies. */
const MAX_TEXT = 262_144;
/** A real repo path is short; a longer no-whitespace token is skipped (kills ReDoS). */
const MAX_TOKEN = 400;

/**
 * Extract candidate repo-relative code paths from free issue text (title + body
 * + comments, joined by the caller). Rejects absolute paths, `.`/`..` traversal,
 * and URL fragments. Returns at most `limit` distinct paths in first-appearance
 * order. Never throws.
 *
 * @param text  the issue's combined title/body/comments text
 * @param opts.limit  max paths to return (default 10)
 */
export function discoverCodePaths(text: string, opts?: { readonly limit?: number }): string[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  if (typeof text !== 'string' || text.length === 0 || limit <= 0) return [];
  const scanned = text.slice(0, MAX_TEXT);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of scanned.split(/\s+/)) {
    // Skip empties and over-long no-whitespace blobs (the ReDoS belt).
    if (rawToken.length === 0 || rawToken.length > MAX_TOKEN) continue;
    // A URL is not a repo-relative path — reject the whole token.
    if (rawToken.includes('://')) continue;
    // Strip surrounding markdown/quote/punctuation the token may carry, e.g.
    // `src/x.ts`, (src/x.ts), "src/x.ts", src/x.ts. — WITHOUT touching the interior.
    const path = rawToken.replace(/^[([`'"]+/, '').replace(/[)\].,:;'"`]+$/, '');
    // Absolute paths are not repo-relative; re-check the length after stripping.
    if (path.length === 0 || path.length > MAX_TOKEN || path.startsWith('/')) continue;
    if (!PATH_TOKEN.test(path)) continue;
    // Reject `.`/`..` segments (traversal) even though the fetch layer guards too.
    if (path.split('/').some((seg) => seg === '.' || seg === '..')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}
