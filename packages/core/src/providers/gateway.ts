/**
 * LLM Gateway provider — delegates LLM calls to a centralized gateway service.
 *
 * The gateway URL and token are configured per-installation via the dashboard
 * (stored in the provider chain entry). No environment variables needed.
 *
 * API contract:
 *   POST /v1/generate
 *   Request:  { prompt, system, provider?, model?, project? }
 *   Response: { text, provider, model, tokensUsed }
 *
 * When `provider` is set, the bridge short-circuits its model-based routing
 * and selects that provider directly (the model is passed through verbatim).
 *
 * This provider bypasses the AI SDK entirely — the gateway handles model
 * selection, provider routing, and token management internally.
 *
 * ─── SSRF / DNS-rebinding defense (SEC-001) ─────────────────────────────────
 *
 * The gateway URL is user-supplied (dashboard provider chain). A naive
 * `fetch(url)` re-resolves the hostname at connection time, so an attacker who
 * controls the hostname's DNS can pass a persist-time/validation-time check
 * (resolving to a public IP) and then rebind the record to loopback, cloud
 * metadata (169.254.169.254), or an RFC-1918 host before the actual request.
 *
 * `pinnedFetch` (below) closes that TOCTOU: it resolves the hostname EXACTLY
 * ONCE, validates EVERY A/AAAA answer against the forbidden ranges, rejects
 * mixed public/private answer sets, picks one approved IP, and PINS the socket
 * to that IP via a custom `lookup` fed to Node's built-in http/https client —
 * while preserving the original Host header and TLS SNI (servername). Both the
 * generation path (this file) AND the discovery path (gateway-discovery.ts)
 * route through the SAME `pinnedFetch`, so they share one pinning policy.
 *
 * Node's http/https client never auto-follows redirects, so a 3xx surfaces as a
 * non-ok response (the old `redirect: 'manual'` posture) and can never chase a
 * Location header to an unvalidated address.
 *
 * Self-hosted escape hatch: `GHAGGA_ALLOW_PRIVATE_GATEWAY=true` skips the
 * IP-range checks (for gateways that legitimately live on a private network) —
 * the connection is STILL pinned to the resolved address, and the protocol /
 * userinfo checks are always enforced.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

// ─── Types ──────────────────────────────────────────────────────

export interface GatewayOptions {
  /** Gateway base URL (e.g., "https://llm-gateway.javierzader.com") */
  gatewayUrl: string;
  /** Bearer token for gateway authentication */
  gatewayToken: string;
  /**
   * Bridge-side provider id to route to (e.g. 'codex-cli'). When set, the
   * bridge selects this provider directly and skips model-based routing.
   */
  provider?: string;
  /** Model to request (optional — gateway can auto-select) */
  model?: string;
  /** Project identifier for gateway tracking/routing */
  project?: string;
}

export interface GatewayResponse {
  text: string;
  provider: string;
  model: string;
  tokensUsed?: number;
}

// ─── SSRF IP-range validation (self-contained) ──────────────────
//
// core cannot import the server's safe-url module (wrong dependency
// direction), so the forbidden-range logic lives here as the single source of
// truth for the pinned client. It mirrors apps/server/src/lib/safe-url.ts.

/** Parse a dotted-quad IPv4 string into 4 octets, or null if malformed. */
function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

/** Reason an IPv4 address is in a forbidden range, or null if acceptable. */
function forbiddenIPv4Reason(ip: string): string | null {
  const octets = parseIPv4(ip);
  if (!octets) return 'malformed IPv4 address';
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return 'unspecified address (0.0.0.0/8)';
  if (a === 127) return 'loopback address (127.0.0.0/8)';
  if (a === 10) return 'private address (10.0.0.0/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'private address (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private address (192.168.0.0/16)';
  if (a === 169 && b === 254) return 'link-local/metadata address (169.254.0.0/16)';
  // 100.64.0.0/10 — CGNAT (RFC 6598); a real SSRF entry on EKS/GCP internal ranges.
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT address (100.64.0.0/10)';
  // 192.0.0.0/24 — IETF protocol assignments (includes 192.0.0.192).
  if (a === 192 && b === 0 && octets[2] === 0) return 'IETF protocol assignment (192.0.0.0/24)';
  // 224.0.0.0/4 — multicast.
  if (a >= 224 && a <= 239) return 'multicast address (224.0.0.0/4)';
  // 240.0.0.0/4 — reserved (future use).
  if (a >= 240) return 'reserved address (240.0.0.0/4)';

  return null;
}

/**
 * Expand an IPv6 string into 8 hextets. Handles `::` compression and a trailing
 * embedded dotted IPv4 (e.g. ::ffff:127.0.0.1). Returns null if malformed.
 */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();

  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

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

/** Reason an IPv6 address is in a forbidden range, or null if acceptable. */
function forbiddenIPv6Reason(ip: string): string | null {
  const hextets = expandIPv6(ip);
  if (!hextets) return 'malformed IPv6 address';

  const allZeroExceptLast = hextets.slice(0, 7).every((h) => h === 0);

  if (allZeroExceptLast && hextets[7] === 0) return 'unspecified address (::)';
  if (allZeroExceptLast && hextets[7] === 1) return 'loopback address (::1)';

  const isV4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (isV4Mapped) {
    const [h6, h7] = [hextets[6], hextets[7]] as [number, number];
    const v4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    const reason = forbiddenIPv4Reason(v4);
    return reason ? `IPv4-mapped ${reason}` : null;
  }

  const h0 = hextets[0] as number;
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local address (fe80::/10)';
  if ((h0 & 0xfe00) === 0xfc00) return 'private address (fc00::/7)';

  return null;
}

/** Reason an IP literal (v4 or v6) is forbidden, or null if acceptable. */
function forbiddenIpReason(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return forbiddenIPv4Reason(ip);
  if (version === 6) return forbiddenIPv6Reason(ip);
  return 'not an IP address';
}

function privateGatewayAllowed(): boolean {
  return process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY === 'true';
}

// ─── Pinned host resolution ─────────────────────────────────────

/** A hostname resolved and validated to a single approved, pinned address. */
export interface PinnedHost {
  /** Parsed, protocol-checked URL. */
  url: URL;
  /** Hostname (brackets stripped for IPv6) — used for Host header + SNI. */
  hostname: string;
  /** The approved IP the socket is pinned to. */
  ip: string;
  /** IP family of the pinned address (4 or 6). */
  family: 4 | 6;
  /** Effective port. */
  port: number;
}

/** An address record returned by DNS lookup. */
interface LookupAddress {
  address: string;
  family: number;
}

/** DNS resolver signature — injectable for tests. */
export type ResolveAllFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolveAll: ResolveAllFn = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Bounded wait for the DNS resolution phase. `dns/promises.lookup` accepts no
 * AbortSignal natively, so we race the resolver promise against BOTH the
 * caller's `signal` (its deadline) and a dedicated DNS timeout. A hanging
 * resolver therefore rejects promptly instead of stalling a queue worker past
 * the caller's budget (SEC-001 follow-up). The underlying lookup is not
 * cancelled — it is simply abandoned — but the operation no longer blocks.
 */
const DNS_RESOLUTION_TIMEOUT_MS = 10_000;

function resolveWithDeadline(
  work: Promise<LookupAddress[]>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LookupAddress[]> {
  return new Promise<LookupAddress[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('gateway host DNS resolution aborted'));
      return;
    }

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('gateway host DNS resolution aborted'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('gateway host DNS resolution timed out'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    work.then(
      (addresses) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(addresses);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Resolve a user-supplied gateway URL to exactly ONE approved, pinned IP.
 *
 * SECURITY: never echoes the hostname/address in thrown messages — the URL IS
 * the SSRF target. Callers log the category only.
 *
 * @throws {Error} with a generic reason if the URL is unusable or forbidden.
 */
export async function resolveAndPinHost(
  rawUrl: string,
  resolveAll: ResolveAllFn = defaultResolveAll,
  opts?: { signal?: AbortSignal; dnsTimeoutMs?: number },
): Promise<PinnedHost> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('gateway URL is not parseable');
  }

  // Protocol allowlist — ALWAYS enforced (no escape hatch).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`gateway URL protocol not allowed: ${url.protocol}`);
  }

  // Userinfo (user:pass@host) — ALWAYS rejected (no escape hatch).
  if (url.username !== '' || url.password !== '') {
    throw new Error('gateway URL must not contain userinfo');
  }

  // URL.hostname wraps IPv6 literals in brackets — strip them for isIP().
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isHttps = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('gateway URL has an invalid port');
  }

  const allowPrivate = privateGatewayAllowed();

  // IP literal — validate directly and pin to it.
  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    if (!allowPrivate) {
      const reason = forbiddenIpReason(hostname);
      if (reason) throw new Error(`gateway URL host is a ${reason}`);
    }
    return { url, hostname, ip: hostname, family: literalVersion as 4 | 6, port };
  }

  // Hostname — resolve ONCE and validate EVERY answer. The resolution phase is
  // bounded by the caller's signal AND a DNS timeout so a hanging resolver can
  // never blow past the caller's budget (SEC-001 follow-up).
  let addresses: LookupAddress[];
  try {
    addresses = await resolveWithDeadline(
      resolveAll(hostname),
      opts?.signal,
      opts?.dnsTimeoutMs ?? DNS_RESOLUTION_TIMEOUT_MS,
    );
  } catch (err) {
    // Preserve explicit deadline/abort reasons; collapse everything else to a
    // generic message (never echo the hostname — it IS the SSRF target).
    if (
      err instanceof Error &&
      (err.message.includes('timed out') || err.message.includes('aborted'))
    ) {
      throw err;
    }
    throw new Error('gateway host DNS resolution failed');
  }

  if (addresses.length === 0) {
    throw new Error('gateway host DNS resolution returned no addresses');
  }

  if (!allowPrivate) {
    // A SINGLE forbidden record fails the whole URL. This rejects a mixed
    // public/private answer set (the classic rebind payload that returns both
    // a public and an internal address).
    for (const { address } of addresses) {
      const reason = forbiddenIpReason(address);
      if (reason) throw new Error(`gateway host resolves to a ${reason}`);
    }
  }

  // Every answer is approved — pin to the first one.
  const [chosen] = addresses;
  if (!chosen) throw new Error('gateway host resolved to no addresses');
  const family = (isIP(chosen.address) as 4 | 6) || 4;
  return { url, hostname, ip: chosen.address, family, port };
}

// ─── Pinned HTTP client ─────────────────────────────────────────

/** Minimal fetch-like response returned by pinnedFetch. */
export interface PinnedResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface PinnedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Abort signal (e.g. AbortSignal.timeout(...)). */
  signal?: AbortSignal;
  /** Injectable resolver for tests. */
  resolveAll?: ResolveAllFn;
}

/**
 * Perform an HTTP(S) request to a user-supplied gateway URL with the connection
 * PINNED to a validated, non-forbidden IP (SEC-001). See the module header.
 *
 * Both the generation and discovery paths call this, so they share one policy.
 *
 * ERROR SHAPE: on failure this rejects with a PLAIN `Error` (e.g. 'request
 * aborted', 'request timed out', 'gateway host DNS resolution timed out'), NOT a
 * fetch-shaped `TypeError`/`AbortError`. Callers must not branch on error type
 * (`err.name === 'AbortError'`); inspect the message or treat any rejection as a
 * failed request.
 */
export async function pinnedFetch(
  rawUrl: string,
  init: PinnedRequestInit,
): Promise<PinnedResponse> {
  const pin = await resolveAndPinHost(rawUrl, init.resolveAll ?? defaultResolveAll, {
    signal: init.signal,
  });
  const isHttps = pin.url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  // Header parity with a normal client: sensible defaults that any explicitly
  // provided header overrides. Accept-Encoding is pinned to `identity` on
  // purpose — this client reads the body raw and does NOT decompress, so we must
  // not advertise gzip/deflate or a compressing gateway would hand back bytes we
  // cannot parse.
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    'User-Agent': 'ghagga-gateway-client',
    ...init.headers,
  };
  // Send the body with a known Content-Length (single shot) instead of letting
  // Node fall back to Transfer-Encoding: chunked — strict gateways / WAFs that
  // require Content-Length would otherwise reject the POST.
  if (init.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(init.body));
  }

  // Pin the socket to the pre-validated IP. Node calls this instead of its own
  // DNS resolver, so no second resolution (and no rebind) can occur.
  const pinnedLookup = (
    _hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as typeof callback;
    const opts = (typeof options === 'function' ? {} : options) as { all?: boolean } | undefined;
    if (opts?.all) {
      cb(null, [{ address: pin.ip, family: pin.family }]);
    } else {
      cb(null, pin.ip, pin.family);
    }
  };

  const requestOptions: RequestOptions = {
    method: init.method,
    // host = hostname → Host header + SNI stay the ORIGINAL host, not the IP.
    host: pin.hostname,
    port: pin.port,
    path: `${pin.url.pathname}${pin.url.search}`,
    headers,
    // biome-ignore lint/suspicious/noExplicitAny: net LookupFunction typing is loose across http/https.
    lookup: pinnedLookup as any,
    // Preserve TLS SNI explicitly (https only; ignored for http).
    servername: isHttps ? pin.hostname : undefined,
  };

  return new Promise<PinnedResponse>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new Error('request aborted'));
      return;
    }

    const req = requestFn(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);

    if (init.signal) {
      const onAbort = () => req.destroy(new Error('request timed out'));
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    }

    // Single-shot send: with Content-Length set above this avoids chunked
    // encoding. `req.end(undefined)` is a no-op body when there is nothing to send.
    req.end(init.body);
  });
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Generate text via the LLM Gateway.
 *
 * @param prompt - User prompt (typically includes the diff)
 * @param systemPrompt - System prompt (review instructions, context, etc.)
 * @param options - Gateway connection options (URL, token, model, project)
 * @returns Gateway response with generated text and metadata
 */
export async function generateViaGateway(
  prompt: string,
  systemPrompt?: string,
  options?: GatewayOptions,
): Promise<GatewayResponse> {
  const { gatewayUrl, gatewayToken, provider, model, project } = options ?? {};

  if (!gatewayUrl) {
    throw new Error('Gateway URL not configured — set it in the dashboard provider chain settings');
  }
  if (!gatewayToken) {
    throw new Error(
      'Gateway token not configured — set the API key in the dashboard provider chain settings',
    );
  }

  // SSRF: pinnedFetch resolves once, validates every answer, and pins the socket
  // to a non-forbidden IP (see module header). Node's client never follows a
  // 3xx, so a redirect surfaces below as a failed generation.
  const response = await pinnedFetch(`${gatewayUrl}/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      prompt,
      system: systemPrompt,
      provider,
      model,
      project,
    }),
    signal: AbortSignal.timeout(180_000), // 3 min timeout (matches CLI bridge)
  });

  // Non-2xx (including a refused 3xx redirect) is a failed generation.
  if (!response.ok) {
    const error = await response.text().catch(() => 'unknown error');
    throw new Error(`Gateway error (${response.status}): ${error}`);
  }

  return response.json() as Promise<GatewayResponse>;
}
