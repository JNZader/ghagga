/**
 * Circuit Breaker — Loop Detection for Recursive Review
 *
 * Detects when the same findings are appearing across iterations
 * by fingerprinting finding sets and tracking consecutive matches.
 */

import { createHash } from 'node:crypto';
import type { ReviewFinding } from '../types.js';

// ─── Types ─────────────────────────────────────────────────────

export interface CircuitBreakerState {
  previousFingerprints: string[];
  consecutiveSimilarCount: number;
  threshold: number; // default 2
}

export interface CircuitBreakerResult {
  shouldBreak: boolean;
  reason?: string;
}

// ─── Fingerprinting ────────────────────────────────────────────

/**
 * Compute a deterministic fingerprint for a set of findings.
 * Sorts by (file, line, category) before hashing to be order-independent.
 */
export function fingerprintFindings(findings: ReviewFinding[]): string {
  const keys = findings
    .map((f) => `${f.file ?? ''}:${f.line ?? 0}:${f.category ?? ''}`)
    .sort()
    .join('|');
  return createHash('sha256').update(keys).digest('hex').slice(0, 16);
}

// ─── Circuit Breaker Logic ─────────────────────────────────────

/**
 * Check if the current findings trigger the circuit breaker.
 * Returns shouldBreak=true if the same fingerprint has appeared
 * `threshold` times consecutively.
 */
export function checkCircuitBreaker(
  findings: ReviewFinding[],
  state: CircuitBreakerState,
): CircuitBreakerResult {
  const fingerprint = fingerprintFindings(findings);
  const lastFingerprint = state.previousFingerprints[state.previousFingerprints.length - 1];

  if (fingerprint === lastFingerprint) {
    const newCount = state.consecutiveSimilarCount + 1;
    if (newCount >= state.threshold) {
      return {
        shouldBreak: true,
        reason: `circuit-break: identical findings (fingerprint ${fingerprint}) in ${newCount} consecutive iterations`,
      };
    }
  }

  return { shouldBreak: false };
}

/**
 * Update circuit breaker state after an iteration.
 */
export function updateCircuitBreakerState(
  findings: ReviewFinding[],
  state: CircuitBreakerState,
): CircuitBreakerState {
  const fingerprint = fingerprintFindings(findings);
  const lastFingerprint = state.previousFingerprints[state.previousFingerprints.length - 1];

  return {
    previousFingerprints: [...state.previousFingerprints, fingerprint],
    consecutiveSimilarCount:
      fingerprint === lastFingerprint ? state.consecutiveSimilarCount + 1 : 0,
    threshold: state.threshold,
  };
}

/**
 * Create initial circuit breaker state.
 */
export function createCircuitBreakerState(threshold = 2): CircuitBreakerState {
  return {
    previousFingerprints: [],
    consecutiveSimilarCount: 0,
    threshold,
  };
}
