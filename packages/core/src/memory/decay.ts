/**
 * Memory strength decay computation.
 *
 * Observations that haven't been re-accessed lose relevance over time.
 * Strength follows a three-phase lifecycle:
 *
 *   1. Active   (0 .. dormancyDays):           strength = 1.0
 *   2. Decaying (dormancyDays .. clearanceDays): strength linearly drops 1.0 → 0.0
 *   3. Cleared  (>= clearanceDays):             strength = 0.0
 */

import { DEFAULT_DECAY_CONFIG, type DecayConfig } from '../types.js';

/**
 * Compute the strength score for an observation based on how long ago it was last accessed.
 *
 * @param lastAccessedAt - When the observation was last returned in a search
 * @param now            - Current timestamp (injectable for testing)
 * @param config         - Decay thresholds
 * @returns A number between 0.0 and 1.0
 */
export function computeStrength(
  lastAccessedAt: Date,
  now: Date = new Date(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const elapsedMs = now.getTime() - lastAccessedAt.getTime();
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

  // Phase 1: Active — still fresh
  if (elapsedDays <= config.dormancyDays) {
    return 1.0;
  }

  // Phase 3: Cleared — too old
  if (elapsedDays >= config.clearanceDays) {
    return 0.0;
  }

  // Phase 2: Decaying — linear interpolation from 1.0 to 0.0
  const decayWindow = config.clearanceDays - config.dormancyDays;
  if (decayWindow <= 0) return 0.0;

  const daysSinceDormancy = elapsedDays - config.dormancyDays;
  const strength = 1.0 - daysSinceDormancy / decayWindow;

  return Math.max(0, Math.min(1, strength));
}

// ─── Relevance normalization (keyword ranking → [0,1]) ──────────
//
// These map a backend's NATIVE keyword-ranking score into a bounded [0,1]
// RELEVANCE signal for the `relevanceScore` field on MemoryObservationRow.
// They are SATURATING / monotonic — they deliberately do NOT use per-query
// normalization (which would force the top candidate to 1.0 and is the
// false-positive trap for dedup). This score is telemetry/observability only;
// issue dedup gates on a separate backend-agnostic keyword overlap.

/**
 * Normalize an FTS5 `bm25()` score into [0,1] relevance.
 *
 * SQLite's `bm25()` returns MORE-NEGATIVE = BETTER match (typically ~ -0.5 to
 * -15 for real matches, 0 for non-matches). We negate to get a positive
 * "goodness" magnitude, then apply a saturating map `m/(m+k)`:
 *   - non-match (bm25 ≈ 0)      → ~0.0
 *   - weak match (bm25 ≈ -1)    → 1/(1+k)
 *   - strong match (bm25 ≪ 0)   → → 1.0 (saturates, never exceeds 1)
 *
 * Monotonic in match quality and bounded — a single absolute threshold is
 * therefore meaningful, unlike a per-query min/max rescale.
 *
 * @param bm25 - Raw `bm25(memory_observations_fts)` value (≤ 0 for matches).
 * @param k     - Saturation constant. Default 4: bm25 ≈ -4 → 0.5.
 */
export function normalizeBm25Relevance(bm25: number, k = 4): number {
  const magnitude = Math.max(0, -bm25); // negate; non-matches/positive → 0
  if (magnitude === 0) return 0;
  return magnitude / (magnitude + k);
}

/**
 * Normalize a 0-based positional rank (0 = best keyword match) into [0,1]
 * relevance via a saturating decay `k/(rank+k)`:
 *   - rank 0 (top)  → 1.0
 *   - rank k        → 0.5
 *   - rank → ∞      → → 0.0
 *
 * Used by the Postgres adapter, whose `searchObservations` returns rows already
 * ordered by `ts_rank` DESC but does not expose the raw rank value. Position is
 * a stable, bounded proxy that is COMPARABLE to the SQLite bm25 mapping for the
 * purpose of a shared `relevanceScore` field (both saturate, both monotonic).
 *
 * NOTE: position 0 maps to 1.0 here, but this is NOT the per-query-top trap —
 * relevanceScore is observability only and is NOT the dedup gate (see
 * findIssueDuplicates, which gates on backend-agnostic keyword overlap).
 *
 * @param rank0 - Zero-based position in the relevance-ordered result set.
 * @param k     - Decay constant. Default 4: rank 4 → 0.5.
 */
export function normalizeRankRelevance(rank0: number, k = 4): number {
  if (rank0 <= 0) return 1;
  return k / (rank0 + k);
}

/**
 * Determine the decay phase label for display purposes.
 */
export function decayPhase(strength: number): 'active' | 'dormant' | 'decaying' | 'cleared' {
  if (strength >= 1.0) return 'active';
  if (strength <= 0.0) return 'cleared';
  if (strength >= 0.7) return 'dormant';
  return 'decaying';
}
