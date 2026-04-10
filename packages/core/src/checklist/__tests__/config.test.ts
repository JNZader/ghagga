/**
 * Tests for checklist config resolution (merge logic).
 *
 * Validates that user overrides merge correctly with defaults,
 * custom dimensions are preserved, and edge cases are handled.
 */

import { describe, expect, it } from 'vitest';
import { resolveChecklistConfig } from '../config.js';
import { DEFAULT_CHECKLIST } from '../defaults.js';
import type { ChecklistConfig, ChecklistDimension } from '../types.js';

// ─── Null / Disabled ──────────────────────────────────────────

describe('resolveChecklistConfig', () => {
  it('returns null when userConfig is undefined', () => {
    expect(resolveChecklistConfig(undefined)).toBeNull();
  });

  it('returns null when master switch is off', () => {
    const config: ChecklistConfig = { enabled: false, dimensions: [] };
    expect(resolveChecklistConfig(config)).toBeNull();
  });

  // ─── Defaults ─────────────────────────────────────────────

  it('returns all defaults when enabled with no dimensions', () => {
    const config: ChecklistConfig = { enabled: true, dimensions: [] };
    const result = resolveChecklistConfig(config);
    expect(result).not.toBeNull();
    expect(result?.dimensions).toHaveLength(DEFAULT_CHECKLIST.dimensions.length);
  });

  it('returns all defaults when enabled with undefined dimensions', () => {
    const config = { enabled: true } as ChecklistConfig;
    const result = resolveChecklistConfig(config);
    expect(result).not.toBeNull();
    expect(result?.dimensions).toHaveLength(DEFAULT_CHECKLIST.dimensions.length);
  });

  // ─── Dimension Merging ────────────────────────────────────

  it('merges user dimension enabled toggle with defaults', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [{ id: 'solid', name: 'SOLID Principles', enabled: false, checks: [] }],
    };
    const result = resolveChecklistConfig(config)!;
    const solid = result.dimensions.find((d) => d.id === 'solid');
    expect(solid?.enabled).toBe(false);
    // Other dimensions should remain enabled
    const errorHandling = result.dimensions.find((d) => d.id === 'error-handling');
    expect(errorHandling?.enabled).toBe(true);
  });

  it('preserves default checks when user dimension has no checks', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [{ id: 'security', name: 'Security', enabled: true, checks: [] }],
    };
    const result = resolveChecklistConfig(config)!;
    const sec = result.dimensions.find((d) => d.id === 'security');
    expect(sec?.checks.length).toBeGreaterThanOrEqual(4);
  });

  // ─── Check Merging ────────────────────────────────────────

  it('overrides individual check weight', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'solid',
          name: 'SOLID Principles',
          enabled: true,
          checks: [{ id: 'single-responsibility', description: '', weight: 3, enabled: true }],
        },
      ],
    };
    const result = resolveChecklistConfig(config)!;
    const solid = result.dimensions.find((d) => d.id === 'solid');
    const srp = solid?.checks.find((c) => c.id === 'single-responsibility');
    expect(srp?.weight).toBe(3);
  });

  it('disables individual check via override', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'solid',
          name: 'SOLID Principles',
          enabled: true,
          checks: [{ id: 'liskov-substitution', description: '', weight: 7, enabled: false }],
        },
      ],
    };
    const result = resolveChecklistConfig(config)!;
    const solid = result.dimensions.find((d) => d.id === 'solid');
    const lsp = solid?.checks.find((c) => c.id === 'liskov-substitution');
    expect(lsp?.enabled).toBe(false);
  });

  it('overrides check description', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'solid',
          name: 'SOLID Principles',
          enabled: true,
          checks: [
            {
              id: 'single-responsibility',
              description: 'Custom question',
              weight: 8,
              enabled: true,
            },
          ],
        },
      ],
    };
    const result = resolveChecklistConfig(config)!;
    const solid = result.dimensions.find((d) => d.id === 'solid');
    const srp = solid?.checks.find((c) => c.id === 'single-responsibility');
    expect(srp?.description).toBe('Custom question');
  });

  // ─── Custom Dimensions ────────────────────────────────────

  it('includes custom dimensions not in defaults', () => {
    const customDim: ChecklistDimension = {
      id: 'performance',
      name: 'Performance',
      enabled: true,
      checks: [{ id: 'n-plus-one', description: 'No N+1 queries', weight: 8, enabled: true }],
    };
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [customDim],
    };
    const result = resolveChecklistConfig(config)!;
    const perf = result.dimensions.find((d) => d.id === 'performance');
    expect(perf).toBeDefined();
    expect(perf?.checks).toHaveLength(1);
    // Default dimensions should also be present
    expect(result.dimensions.length).toBe(DEFAULT_CHECKLIST.dimensions.length + 1);
  });

  // ─── Custom Checks Within Existing Dimensions ─────────────

  it('includes custom checks within existing dimensions', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'security',
          name: 'Security',
          enabled: true,
          checks: [
            { id: 'rate-limiting', description: 'Rate limiting present', weight: 7, enabled: true },
          ],
        },
      ],
    };
    const result = resolveChecklistConfig(config)!;
    const sec = result.dimensions.find((d) => d.id === 'security');
    const rateLimiting = sec?.checks.find((c) => c.id === 'rate-limiting');
    expect(rateLimiting).toBeDefined();
    // Default checks should also be present
    const injection = sec?.checks.find((c) => c.id === 'injection-prevention');
    expect(injection).toBeDefined();
  });

  it('overrides dimension name', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [{ id: 'solid', name: 'SOLID (Custom)', enabled: true, checks: [] }],
    };
    const result = resolveChecklistConfig(config)!;
    const solid = result.dimensions.find((d) => d.id === 'solid');
    expect(solid?.name).toBe('SOLID (Custom)');
  });
});
