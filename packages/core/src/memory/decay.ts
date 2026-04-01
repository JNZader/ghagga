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

/**
 * Determine the decay phase label for display purposes.
 */
export function decayPhase(strength: number): 'active' | 'dormant' | 'decaying' | 'cleared' {
  if (strength >= 1.0) return 'active';
  if (strength <= 0.0) return 'cleared';
  if (strength >= 0.7) return 'dormant';
  return 'decaying';
}
