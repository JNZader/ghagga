/**
 * Gateway discovery — query what the bridge actually exposes.
 *
 * The bridge advertises its live providers and models via GET /v1/providers
 * and GET /v1/models. `validateProviderChain` can check a provider chain
 * against them so a misconfigured voice (unknown/unavailable provider, or a
 * model that provider doesn't serve) is caught up front.
 *
 * STATUS: this is an available capability, NOT yet wired into the review
 * pipeline — callers must invoke validateProviderChain themselves. Until that
 * wiring lands the chain is sent unvalidated (tracked as a follow-up).
 *
 * SECURITY: the fetch helpers take a raw gatewayUrl and attach the bearer
 * token. They route through `pinnedFetch` (gateway.ts) — the SAME SSRF /
 * DNS-rebinding-pinning policy as the generation path (SEC-001): the hostname
 * is resolved ONCE, every A/AAAA answer is validated, and the socket is pinned
 * to an approved IP with Host header + TLS SNI preserved. Discovery and generate
 * therefore share one pinning policy; a rebound host can never receive the token.
 */

import type { ProviderChainEntry } from '../types.js';
import { pinnedFetch } from './gateway.js';

// ─── Bridge response shapes ─────────────────────────────────────

/** One entry from GET /v1/models (`data[]`). */
export interface GatewayModelEntry {
  id: string;
  name?: string;
  provider?: string;
  max_tokens?: number;
}

/** One entry from GET /v1/providers (`providers[]`). */
export interface GatewayProviderStatus {
  id: string;
  name: string;
  type: string;
  available: boolean;
}

// ─── Fetch helpers ──────────────────────────────────────────────

async function gatewayGet(
  gatewayUrl: string,
  gatewayToken: string,
  path: string,
): Promise<unknown> {
  if (!gatewayUrl) {
    throw new Error('Gateway URL not configured — set it in the dashboard provider chain settings');
  }
  if (!gatewayToken) {
    throw new Error(
      'Gateway token not configured — set the API key in the dashboard provider chain settings',
    );
  }

  // SSRF: pinnedFetch resolves once, validates every DNS answer, and pins the
  // socket to a non-forbidden IP (same policy as generateViaGateway). Node's
  // http/https client never follows a 3xx, so a redirect surfaces as a non-ok
  // response below and can never chase a Location to an unvalidated host.
  const response = await pinnedFetch(`${gatewayUrl}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${gatewayToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => 'unknown error');
    throw new Error(`Gateway error (${response.status}): ${error}`);
  }

  return response.json();
}

/** Fetch the bridge's advertised models (GET /v1/models). */
export async function fetchGatewayModels(
  gatewayUrl: string,
  gatewayToken: string,
): Promise<GatewayModelEntry[]> {
  const body = await gatewayGet(gatewayUrl, gatewayToken, '/v1/models');
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  // Only trust entries that actually carry a string id — a malformed payload
  // must not coerce into typed garbage that skews validation.
  return data.filter(
    (m): m is GatewayModelEntry => typeof (m as GatewayModelEntry)?.id === 'string',
  );
}

/** Fetch the bridge's provider statuses (GET /v1/providers). */
export async function fetchGatewayProviders(
  gatewayUrl: string,
  gatewayToken: string,
): Promise<GatewayProviderStatus[]> {
  const body = await gatewayGet(gatewayUrl, gatewayToken, '/v1/providers');
  const providers = (body as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers.filter(
    (p): p is GatewayProviderStatus =>
      typeof (p as GatewayProviderStatus)?.id === 'string' &&
      typeof (p as GatewayProviderStatus)?.available === 'boolean',
  );
}

// ─── Validation ─────────────────────────────────────────────────

export interface ChainValidationResult {
  /** Entries safe to send. */
  valid: ProviderChainEntry[];
  /** Entries that should NOT be sent, with a human-readable reason. */
  invalid: Array<{ entry: ProviderChainEntry; reason: string }>;
}

/**
 * Validate gateway provider-chain entries against what the bridge actually
 * exposes — so ghagga never sends a voice it only ASSUMES exists.
 *
 * Checks, per `provider === 'gateway'` entry:
 * - `targetProvider` (if set) is a known, available bridge provider;
 * - `model` (if not 'auto') is advertised — by that targetProvider when set,
 *   otherwise by any provider.
 *
 * Non-gateway entries pass through unchecked (they don't go to the bridge).
 */
export function validateProviderChain(
  chain: ProviderChainEntry[],
  models: GatewayModelEntry[],
  providers: GatewayProviderStatus[],
): ChainValidationResult {
  const result: ChainValidationResult = { valid: [], invalid: [] };

  for (const entry of chain) {
    if (entry.provider !== 'gateway') {
      result.valid.push(entry);
      continue;
    }

    const reason = validateGatewayEntry(entry, models, providers);
    if (reason) {
      result.invalid.push({ entry, reason });
    } else {
      result.valid.push(entry);
    }
  }

  return result;
}

function validateGatewayEntry(
  entry: ProviderChainEntry,
  models: GatewayModelEntry[],
  providers: GatewayProviderStatus[],
): string | null {
  // Fail-open per dimension: an EMPTY discovery list means "couldn't discover"
  // (bridge unreachable / transient), not "nothing exists" — so we skip that
  // check rather than nuke an otherwise-valid chain on a blip.
  if (entry.targetProvider && providers.length > 0) {
    const status = providers.find((p) => p.id === entry.targetProvider);
    if (!status) {
      return `unknown bridge provider '${entry.targetProvider}'`;
    }
    if (!status.available) {
      return `bridge provider '${entry.targetProvider}' is unavailable`;
    }
  }

  // 'auto' lets the bridge choose — nothing to validate.
  if (entry.model && entry.model !== 'auto' && models.length > 0) {
    // The bridge always attributes a model's provider (GET /v1/models), so when
    // targetProvider is set we require an exact provider match — no lenient
    // "missing provider matches anything" escape hatch.
    const known = models.some(
      (m) => m.id === entry.model && (!entry.targetProvider || m.provider === entry.targetProvider),
    );
    if (!known) {
      return entry.targetProvider
        ? `model '${entry.model}' not advertised by provider '${entry.targetProvider}'`
        : `model '${entry.model}' not advertised by the bridge`;
    }
  }

  return null;
}
