/**
 * Extract the client IP from a Hono request context.
 *
 * The `X-Forwarded-For` header may contain a chain of IPs:
 * `<client>, <proxy1>, <proxy2>`. We take the **last** (rightmost) entry.
 *
 * TRUST-BOUNDARY CONTRACT — VALIDATE AT DEPLOY TIME (ticket #239):
 * NOTE: ghagga has no live deployment as of 2026-06-15 (the old Coolify/Hetzner
 * box was torn down; only other projects run on that infra). The conditions
 * below are NOT verified against a running ghagga — they MUST be confirmed
 * whenever ghagga is actually deployed. Do not treat this as verified fact.
 *
 * "Last" is the correct, secure pick ONLY when BOTH hold:
 *   1. There is EXACTLY ONE trusted proxy that appends to XFF. That proxy adds
 *      the real peer IP at the end, so the rightmost entry is the client IP as
 *      the proxy observed it, and earlier (client-supplied) entries are ignored.
 *   2. The app port is firewalled so the Node server is unreachable except via
 *      that proxy — otherwise a client can hit the app directly and forge the
 *      rightmost entry.
 *
 * WHAT BREAKS THIS (revisit before any of these at deploy time):
 *   - Two or more trusted hops → "last" returns the inner proxy's IP, not the
 *     client; switch to Nth-from-right (N = trusted-hop count).
 *   - A CDN/proxy like Cloudflare in orange-cloud (proxied) mode → prefer its
 *     canonical client header (e.g. `CF-Connecting-IP`).
 *   - The app port exposed directly → "last" becomes fully client-controlled.
 * Consumers today are rate-limit keys only (api/oauth/webhook), so a spoof would
 * mean a rate-limit bypass — no auth/logging/DB impact.
 *
 * Falls back to `X-Real-IP` when `X-Forwarded-For` is absent or blank, then to
 * `'unknown'` as a final fallback.
 */

import type { Context } from 'hono';

export function getClientIp(c: Context): string {
  // Trim so a whitespace-only X-Forwarded-For is treated as absent and falls
  // through to X-Real-IP, mirroring the blank-value handling below.
  const xff = c.req.header('x-forwarded-for')?.trim();
  if (xff) {
    // LAST IP = appended by the single trusted proxy; earlier entries are
    // client-supplied and ignored. See the trust-boundary contract above.
    const ips = xff.split(',').map((ip) => ip.trim());
    return ips[ips.length - 1] || 'unknown';
  }
  // A present-but-empty (or whitespace-only) X-Real-IP must coalesce to
  // 'unknown', matching the X-Forwarded-For branch above (?? would leak '').
  const realIp = c.req.header('x-real-ip')?.trim();
  return realIp || 'unknown';
}
