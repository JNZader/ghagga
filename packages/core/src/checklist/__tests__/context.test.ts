/**
 * Tests for checklist context builder.
 *
 * Validates prompt generation, truncation, and active check counting.
 */

import { describe, expect, it } from 'vitest';
import { buildChecklistContext, countActiveChecks } from '../context.js';
import { DEFAULT_CHECKLIST } from '../defaults.js';
import type { ChecklistConfig, ChecklistDimension } from '../types.js';

// ─── buildChecklistContext ─────────────────────────────────────

describe('buildChecklistContext', () => {
  it('returns non-empty string for default config', () => {
    const result = buildChecklistContext(DEFAULT_CHECKLIST);
    expect(result.length).toBeGreaterThan(0);
  });

  it('starts with review checklist header', () => {
    const result = buildChecklistContext(DEFAULT_CHECKLIST);
    expect(result).toContain('## Review Checklist');
  });

  it('includes dimension names as headers', () => {
    const result = buildChecklistContext(DEFAULT_CHECKLIST);
    expect(result).toContain('### SOLID Principles');
    expect(result).toContain('### Error Handling');
    expect(result).toContain('### Boundary Conditions');
    expect(result).toContain('### Security');
  });

  it('includes check descriptions with weights', () => {
    const result = buildChecklistContext(DEFAULT_CHECKLIST);
    expect(result).toMatch(/\[w:\d+\]/);
    expect(result).toContain('Does each class/function have exactly one reason to change?');
  });

  it('returns empty string when all dimensions are disabled', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: DEFAULT_CHECKLIST.dimensions.map((d) => ({ ...d, enabled: false })),
    };
    expect(buildChecklistContext(config)).toBe('');
  });

  it('returns empty string when all checks within enabled dimensions are disabled', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'solid',
          name: 'SOLID',
          enabled: true,
          checks: [{ id: 'srp', description: 'test', weight: 5, enabled: false }],
        },
      ],
    };
    expect(buildChecklistContext(config)).toBe('');
  });

  it('excludes disabled dimensions', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        { ...DEFAULT_CHECKLIST.dimensions[0]!, enabled: true },
        { ...DEFAULT_CHECKLIST.dimensions[1]!, enabled: false },
        { ...DEFAULT_CHECKLIST.dimensions[2]!, enabled: true },
        { ...DEFAULT_CHECKLIST.dimensions[3]!, enabled: false },
      ],
    };
    const result = buildChecklistContext(config);
    expect(result).toContain('### SOLID Principles');
    expect(result).not.toContain('### Error Handling');
    expect(result).toContain('### Boundary Conditions');
    expect(result).not.toContain('### Security');
  });

  it('excludes disabled checks within enabled dimensions', () => {
    const solidDim = DEFAULT_CHECKLIST.dimensions.find((d) => d.id === 'solid')!;
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          ...solidDim,
          checks: solidDim.checks.map((c) =>
            c.id === 'liskov-substitution' ? { ...c, enabled: false } : c,
          ),
        },
      ],
    };
    const result = buildChecklistContext(config);
    expect(result).not.toContain('substituted for their base types');
    expect(result).toContain('one reason to change');
  });

  it('includes weight hint footer', () => {
    const result = buildChecklistContext(DEFAULT_CHECKLIST);
    expect(result).toContain('Weight indicates importance');
  });

  it('truncates to high-priority checks when context exceeds budget', () => {
    // Create a config with many verbose dimensions to exceed 2400 chars
    const verboseDimensions: ChecklistDimension[] = Array.from({ length: 10 }, (_, i) => ({
      id: `dim-${i}`,
      name: `Dimension ${i} With A Very Long Name For Testing Purposes`,
      enabled: true,
      checks: Array.from({ length: 10 }, (_, j) => ({
        id: `check-${i}-${j}`,
        description: `This is a very detailed and verbose check description number ${j} in dimension ${i} that takes up many characters to ensure we exceed the token budget limit for testing the truncation logic properly`,
        weight: j < 3 ? 8 : 3, // First 3 checks are high-weight
        enabled: true,
      })),
    }));

    const config: ChecklistConfig = { enabled: true, dimensions: verboseDimensions };
    const result = buildChecklistContext(config);
    // Should have been truncated — only high-weight checks
    expect(result).toContain('high-priority checks only');
  });
});

// ─── countActiveChecks ────────────────────────────────────────

describe('countActiveChecks', () => {
  it('counts all checks in default config', () => {
    const count = countActiveChecks(DEFAULT_CHECKLIST);
    // 4 dimensions * 5 checks each = 20
    expect(count).toBe(20);
  });

  it('returns 0 when all dimensions are disabled', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: DEFAULT_CHECKLIST.dimensions.map((d) => ({ ...d, enabled: false })),
    };
    expect(countActiveChecks(config)).toBe(0);
  });

  it('excludes disabled checks', () => {
    const solidDim = DEFAULT_CHECKLIST.dimensions.find((d) => d.id === 'solid')!;
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          ...solidDim,
          checks: solidDim.checks.map((c, i) => ({ ...c, enabled: i < 3 })),
        },
      ],
    };
    expect(countActiveChecks(config)).toBe(3);
  });

  it('excludes checks in disabled dimensions', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'test',
          name: 'Test',
          enabled: false,
          checks: [
            { id: 'c1', description: 'check 1', weight: 5, enabled: true },
            { id: 'c2', description: 'check 2', weight: 5, enabled: true },
          ],
        },
      ],
    };
    expect(countActiveChecks(config)).toBe(0);
  });
});
