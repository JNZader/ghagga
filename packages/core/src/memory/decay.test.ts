import { describe, expect, it } from 'vitest';
import type { DecayConfig } from '../types.js';
import { computeStrength, decayPhase } from './decay.js';

// ─── Helpers ────────────────────────────────────────────────────

const BASE_DATE = new Date('2026-03-31T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(BASE_DATE.getTime() - days * 24 * 60 * 60 * 1000);
}

const defaultConfig: DecayConfig = {
  dormancyDays: 7,
  decayDays: 30,
  clearanceDays: 90,
  minStrength: 0.1,
};

// ─── computeStrength ────────────────────────────────────────────

describe('computeStrength()', () => {
  const cases: Array<{
    name: string;
    daysElapsed: number;
    expected: number;
    config?: DecayConfig;
  }> = [
    { name: 'just accessed (0 days)', daysElapsed: 0, expected: 1.0 },
    { name: 'within dormancy (3 days)', daysElapsed: 3, expected: 1.0 },
    { name: 'at dormancy boundary (7 days)', daysElapsed: 7, expected: 1.0 },
    { name: 'halfway through decay window', daysElapsed: 48.5, expected: 0.5 },
    { name: 'near end of decay window (80 days)', daysElapsed: 80, expected: 0.12048192771084337 },
    { name: 'at clearance boundary (90 days)', daysElapsed: 90, expected: 0.0 },
    { name: 'past clearance (120 days)', daysElapsed: 120, expected: 0.0 },
    {
      name: 'custom config — tight window',
      daysElapsed: 5,
      expected: 0.5,
      config: { dormancyDays: 0, decayDays: 10, clearanceDays: 10, minStrength: 0 },
    },
    {
      name: 'custom config — zero decay window',
      daysElapsed: 1,
      expected: 0.0,
      config: { dormancyDays: 0, decayDays: 0, clearanceDays: 0, minStrength: 0 },
    },
  ];

  for (const { name, daysElapsed, expected, config } of cases) {
    it(name, () => {
      const lastAccessed = daysAgo(daysElapsed);
      const strength = computeStrength(lastAccessed, BASE_DATE, config ?? defaultConfig);
      expect(strength).toBeCloseTo(expected, 5);
    });
  }

  it('returns value clamped between 0 and 1', () => {
    // Future date should still be 1.0
    const futureDate = new Date(BASE_DATE.getTime() + 1000);
    expect(computeStrength(futureDate, BASE_DATE, defaultConfig)).toBe(1.0);
  });

  it('uses default config when none provided', () => {
    const strength = computeStrength(BASE_DATE, BASE_DATE);
    expect(strength).toBe(1.0);
  });
});

// ─── decayPhase ─────────────────────────────────────────────────

describe('decayPhase()', () => {
  const cases: Array<{ strength: number; expected: string }> = [
    { strength: 1.0, expected: 'active' },
    { strength: 0.85, expected: 'dormant' },
    { strength: 0.7, expected: 'dormant' },
    { strength: 0.5, expected: 'decaying' },
    { strength: 0.1, expected: 'decaying' },
    { strength: 0.0, expected: 'cleared' },
  ];

  for (const { strength, expected } of cases) {
    it(`strength ${strength} → ${expected}`, () => {
      expect(decayPhase(strength)).toBe(expected);
    });
  }
});
