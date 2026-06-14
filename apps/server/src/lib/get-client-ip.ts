/**
 * Extract the client IP from a Hono request context.
 *
 * When behind a reverse proxy (e.g. Render), the `X-Forwarded-For` header
 * may contain a chain of IPs: `<client>, <proxy1>, <proxy2>`.
 * The **last** entry is the one appended by the trusted reverse proxy and is
 * therefore the most reliable — earlier entries can be spoofed by the client.
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
    // Behind a reverse proxy (Render), the LAST IP is the one added by the proxy
    // and is the most trustworthy. Earlier IPs can be spoofed by the client.
    const ips = xff.split(',').map((ip) => ip.trim());
    return ips[ips.length - 1] || 'unknown';
  }
  // A present-but-empty (or whitespace-only) X-Real-IP must coalesce to
  // 'unknown', matching the X-Forwarded-For branch above (?? would leak '').
  const realIp = c.req.header('x-real-ip')?.trim();
  return realIp || 'unknown';
}
