/**
 * The forge webhook codec port (task 0.5) — INTERFACE SHAPE ONLY.
 *
 * Two-phase design:
 *   1. identify(headers, raw)  → cheap, pre-verification tenant routing. Returns
 *      a {@link TenantHint} (or null) so the host can pick the right secret /
 *      credentials before trusting anything.
 *   2. verify(payload, headers, secret) → authenticate the payload signature.
 *   3. parse(payload, headers) → normalize into a forge-agnostic {@link ForgeEvent}.
 *
 * NEEDS GUARD (P5): the verify-before-parse ordering guarantee is INTENTIONALLY
 * DEFERRED to P5. This interface only declares the shape — it does NOT yet
 * enforce, at the type level or runtime, that `verify` was called (and returned
 * true) before `parse`. P5 will add that guard. Do NOT assume parse is safe to
 * call on unverified input in the meantime.
 */

import type { ForgeEvent, TenantHint } from '../types.js';

/** Decodes and authenticates incoming forge webhooks. */
export interface ForgeWebhookCodec {
  /**
   * Phase 1: extract a tenant-routing hint WITHOUT trusting the payload.
   *
   * Runs before signature verification so the host can select the correct
   * secret/credentials. Returns null when the webhook cannot be routed.
   */
  identify(headers: Record<string, string>, raw: string): TenantHint | null;

  /**
   * Phase 2: verify the payload signature against `secret`.
   *
   * @returns true iff the payload is authentic.
   */
  verify(payload: unknown, headers: Record<string, string>, secret: string): boolean;

  /**
   * Phase 3: normalize a (verified) payload into a forge-agnostic event.
   *
   * NEEDS GUARD (P5): nothing here yet enforces that {@link verify} succeeded
   * first — that guard lands in P5.
   */
  parse(payload: unknown, headers: Record<string, string>): ForgeEvent;
}
