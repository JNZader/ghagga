/**
 * SSRF protection for user-supplied outbound URLs (e.g. gateway URLs).
 *
 * A user-controlled URL that the server fetches is a classic SSRF vector:
 * it can be pointed at loopback services, RFC-1918 internal hosts, or cloud
 * metadata endpoints (169.254.169.254) to scan/exfiltrate from the inside.
 *
 * `validateOutboundUrl()` enforces:
 *   1. The value parses as a URL with protocol http: or https: only.
 *   2. No userinfo (user:pass@host) — credential-smuggling / parser-confusion.
 *   3. The host must not be (or resolve to) a forbidden IP range:
 *      loopback, private (RFC 1918 / ULA), link-local + cloud metadata,
 *      unspecified, or IPv4-mapped IPv6 forms of any of those.
 *      Non-IP hostnames are resolved via dns.lookup and EVERY resolved
 *      address is checked.
 *
 * Escape hatch for self-hosted deployments where the gateway legitimately
 * lives on a private network: set GHAGGA_ALLOW_PRIVATE_GATEWAY=true to skip
 * the IP-range checks (loopback/private/link-local/metadata/unspecified).
 * The protocol and userinfo checks are ALWAYS enforced, even with the
 * escape hatch enabled.
 *
 * SEC-001 (DNS-rebinding TOCTOU): this validator resolves DNS to CHECK the URL,
 * but the returned URL is re-resolved at fetch time — so validation alone cannot
 * stop a rebind between check and connect. The actual connection-time defense
 * (resolve-once + PIN the socket to the approved IP, preserving Host + SNI) lives
 * in `packages/core/src/providers/gateway.ts` (`pinnedFetch`), through which BOTH
 * the discovery and the generation gateway requests flow. This function remains
 * the persist-time / execution-time validation gate (defense in depth); the pin
 * is what closes the TOCTOU at the moment the connection is opened.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { logger } from './logger.js';

export type OutboundUrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

// ─── IPv4 range checks ──────────────────────────────────────────

/** Parse a dotted-quad IPv4 string into 4 octets, or null if malformed. */
function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

/**
 * Return a human-readable reason if the IPv4 address is in a forbidden
 * range, or null if it is acceptable for outbound requests.
 */
function forbiddenIPv4Reason(ip: string): string | null {
  const octets = parseIPv4(ip);
  if (!octets) return 'malformed IPv4 address';
  const [a, b] = octets as [number, number, number, number];

  // 0.0.0.0/8 — unspecified ("this network"); 0.0.0.0 routes to localhost on Linux
  if (a === 0) return 'unspecified address (0.0.0.0/8)';
  // 127.0.0.0/8 — loopback
  if (a === 127) return 'loopback address (127.0.0.0/8)';
  // 10.0.0.0/8 — private
  if (a === 10) return 'private address (10.0.0.0/8)';
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return 'private address (172.16.0.0/12)';
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return 'private address (192.168.0.0/16)';
  // 169.254.0.0/16 — link-local, includes cloud metadata (169.254.169.254)
  if (a === 169 && b === 254) return 'link-local/metadata address (169.254.0.0/16)';
  // 100.64.0.0/10 — CGNAT (RFC 6598); a real SSRF entry on EKS/GCP internal ranges
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT address (100.64.0.0/10)';
  // 192.0.0.0/24 — IETF protocol assignments (includes 192.0.0.192)
  if (a === 192 && b === 0 && octets[2] === 0) return 'IETF protocol assignment (192.0.0.0/24)';
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return 'multicast address (224.0.0.0/4)';
  // 240.0.0.0/4 — reserved (future use)
  if (a >= 240) return 'reserved address (240.0.0.0/4)';

  return null;
}

// ─── IPv6 range checks ──────────────────────────────────────────

/**
 * Expand an IPv6 string into 8 hextets (numbers). Handles `::` compression
 * and a trailing embedded dotted IPv4 (e.g. ::ffff:127.0.0.1).
 * Returns null if the address is malformed.
 */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();

  // Strip zone index (fe80::1%eth0)
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  // Convert trailing dotted IPv4 into two hextets
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;

  const toHextets = (s: string): number[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      nums.push(parseInt(g, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 2) {
    const [headPart, tailPart] = doubleColonParts as [string, string];
    const head = toHextets(headPart);
    const tailHex = toHextets(tailPart);
    if (!head || !tailHex) return null;
    const fill = 8 - head.length - tailHex.length;
    if (fill < 1) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tailHex];
  }

  const full = toHextets(addr);
  if (full?.length !== 8) return null;
  return full;
}

/**
 * Return a human-readable reason if the IPv6 address is in a forbidden
 * range, or null if it is acceptable for outbound requests.
 */
function forbiddenIPv6Reason(ip: string): string | null {
  const hextets = expandIPv6(ip);
  if (!hextets) return 'malformed IPv6 address';

  const allZeroExceptLast = hextets.slice(0, 7).every((h) => h === 0);

  // :: — unspecified
  if (allZeroExceptLast && hextets[7] === 0) return 'unspecified address (::)';
  // ::1 — loopback
  if (allZeroExceptLast && hextets[7] === 1) return 'loopback address (::1)';

  // ::ffff:a.b.c.d — IPv4-mapped: re-check the embedded IPv4
  const isV4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (isV4Mapped) {
    const [h6, h7] = [hextets[6], hextets[7]] as [number, number];
    const v4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    const reason = forbiddenIPv4Reason(v4);
    return reason ? `IPv4-mapped ${reason}` : null;
  }

  const h0 = hextets[0] as number;
  // fe80::/10 — link-local
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local address (fe80::/10)';
  // fc00::/7 — unique local (the IPv6 analogue of RFC 1918 private space)
  if ((h0 & 0xfe00) === 0xfc00) return 'private address (fc00::/7)';

  return null;
}

// ─── Public API ─────────────────────────────────────────────────

/** Reason an IP literal (v4 or v6) is forbidden, or null if acceptable. */
function forbiddenIpReason(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return forbiddenIPv4Reason(ip);
  if (version === 6) return forbiddenIPv6Reason(ip);
  return 'not an IP address';
}

/**
 * Whether the private-IP escape hatch is enabled.
 *
 * When enabled, the first time the bypass is actually TAKEN we emit a single
 * WARN so operators have an audit trail that SSRF IP-range protection is off —
 * without spamming one line per request. The protocol and userinfo checks are
 * still enforced even under the escape hatch (see validateOutboundUrl).
 */
let escapeHatchWarned = false;

function privateGatewayAllowed(): boolean {
  if (process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY === 'true') {
    if (!escapeHatchWarned) {
      escapeHatchWarned = true;
      logger.warn(
        'GHAGGA_ALLOW_PRIVATE_GATEWAY=true — SSRF private-IP range checks are DISABLED for gateway URLs (protocol/userinfo checks still enforced)',
      );
    }
    return true;
  }
  return false;
}

/**
 * Validate a user-supplied URL before the server fetches it.
 *
 * Never throws — always returns a discriminated result. The `reason` is
 * meant for server-side logs only; return a GENERIC message to clients.
 */
export async function validateOutboundUrl(raw: string): Promise<OutboundUrlValidation> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a parseable URL' };
  }

  // Protocol allowlist — ALWAYS enforced (no escape hatch).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `protocol not allowed: ${url.protocol}` };
  }

  // Userinfo (user:pass@host) — ALWAYS rejected (no escape hatch).
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo in URL not allowed' };
  }

  // Self-hosted escape hatch: skip the IP-range checks entirely.
  if (privateGatewayAllowed()) {
    return { ok: true, url };
  }

  // URL.hostname wraps IPv6 literals in brackets — strip them for isIP().
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname) !== 0) {
    // IP literal: check directly.
    const reason = forbiddenIpReason(hostname);
    if (reason) return { ok: false, reason };
    return { ok: true, url };
  }

  // Hostname: resolve ALL addresses and check every one. A single forbidden
  // record fails the whole URL (attacker-controlled DNS may mix public and
  // internal records).
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    // SECURITY: never echo the hostname — it IS the SSRF target. The rejection
    // category alone is enough for a server-side audit trail.
    return { ok: false, reason: 'DNS resolution failed' };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'DNS resolution returned no addresses' };
  }

  for (const { address } of addresses) {
    const reason = forbiddenIpReason(address);
    if (reason) {
      // SECURITY: never echo the hostname or its resolved address — both leak
      // the SSRF target. The forbidden-range category is the only thing logged.
      return { ok: false, reason: `hostname resolves to ${reason}` };
    }
  }

  return { ok: true, url };
}
