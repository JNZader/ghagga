/**
 * Tests for default checklist dimensions and checks.
 *
 * Validates structure, weights, and completeness of the built-in checklist.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECKLIST, DEFAULT_DIMENSIONS } from '../defaults.js';

// ─── Structure ─────────────────────────────────────────────────

describe('DEFAULT_CHECKLIST', () => {
  it('is enabled by default', () => {
    expect(DEFAULT_CHECKLIST.enabled).toBe(true);
  });

  it('has 4 dimensions', () => {
    expect(DEFAULT_CHECKLIST.dimensions).toHaveLength(4);
  });

  it('has dimensions with unique IDs', () => {
    const ids = DEFAULT_CHECKLIST.dimensions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Dimensions ────────────────────────────────────────────────

describe('DEFAULT_DIMENSIONS', () => {
  it('includes solid dimension', () => {
    const dim = DEFAULT_DIMENSIONS.find((d) => d.id === 'solid');
    expect(dim).toBeDefined();
    expect(dim?.name).toBe('SOLID Principles');
    expect(dim?.enabled).toBe(true);
  });

  it('includes error-handling dimension', () => {
    const dim = DEFAULT_DIMENSIONS.find((d) => d.id === 'error-handling');
    expect(dim).toBeDefined();
    expect(dim?.name).toBe('Error Handling');
  });

  it('includes boundary-conditions dimension', () => {
    const dim = DEFAULT_DIMENSIONS.find((d) => d.id === 'boundary-conditions');
    expect(dim).toBeDefined();
    expect(dim?.name).toBe('Boundary Conditions');
  });

  it('includes security dimension', () => {
    const dim = DEFAULT_DIMENSIONS.find((d) => d.id === 'security');
    expect(dim).toBeDefined();
    expect(dim?.name).toBe('Security');
  });

  it('all dimensions are enabled by default', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      expect(dim.enabled).toBe(true);
    }
  });
});

// ─── Checks ────────────────────────────────────────────────────

describe('dimension checks', () => {
  it('each dimension has at least 4 checks', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      expect(dim.checks.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('all checks are enabled by default', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      for (const check of dim.checks) {
        expect(check.enabled).toBe(true);
      }
    }
  });

  it('all check weights are between 1 and 10', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      for (const check of dim.checks) {
        expect(check.weight).toBeGreaterThanOrEqual(1);
        expect(check.weight).toBeLessThanOrEqual(10);
      }
    }
  });

  it('all checks have non-empty descriptions', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      for (const check of dim.checks) {
        expect(check.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('all checks have unique IDs within their dimension', () => {
    for (const dim of DEFAULT_DIMENSIONS) {
      const ids = dim.checks.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('SOLID dimension has 5 checks (S, O, L, I, D)', () => {
    const solid = DEFAULT_DIMENSIONS.find((d) => d.id === 'solid');
    expect(solid?.checks).toHaveLength(5);
    const ids = solid?.checks.map((c) => c.id);
    expect(ids).toContain('single-responsibility');
    expect(ids).toContain('open-closed');
    expect(ids).toContain('liskov-substitution');
    expect(ids).toContain('interface-segregation');
    expect(ids).toContain('dependency-inversion');
  });

  it('security dimension has high-weight checks for injection and sensitive data', () => {
    const sec = DEFAULT_DIMENSIONS.find((d) => d.id === 'security');
    const injection = sec?.checks.find((c) => c.id === 'injection-prevention');
    const sensitive = sec?.checks.find((c) => c.id === 'sensitive-data');
    expect(injection?.weight).toBe(10);
    expect(sensitive?.weight).toBe(10);
  });
});
