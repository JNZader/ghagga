/**
 * Tests for checklist scoring engine.
 *
 * Validates finding-to-check matching, weight calculation,
 * severity multipliers, and edge cases.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECKLIST } from '../defaults.js';
import type { ScorableFinding } from '../scorer.js';
import { scoreFindings } from '../scorer.js';
import type { ChecklistConfig } from '../types.js';
import { SEVERITY_MULTIPLIER } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeFinding(overrides: Partial<ScorableFinding> = {}): ScorableFinding {
  return {
    severity: 'medium',
    category: 'bug',
    message: 'something is wrong',
    ...overrides,
  };
}

// ─── Empty / Disabled ─────────────────────────────────────────

describe('scoreFindings', () => {
  it('returns zero score for empty findings array', () => {
    const result = scoreFindings([], DEFAULT_CHECKLIST);
    expect(result.totalScore).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.dimensionScores).toHaveLength(0);
  });

  it('returns zero score when all dimensions are disabled', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: DEFAULT_CHECKLIST.dimensions.map((d) => ({ ...d, enabled: false })),
    };
    const findings = [makeFinding({ category: 'security', message: 'sql injection found' })];
    const result = scoreFindings(findings, config);
    expect(result.totalScore).toBe(0);
  });

  // ─── Dimension Matching ───────────────────────────────────

  it('matches security findings to security dimension', () => {
    const findings = [
      makeFinding({ category: 'security', message: 'SQL injection vulnerability' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('security');
  });

  it('matches error handling findings', () => {
    const findings = [
      makeFinding({ category: 'bug', message: 'empty catch block swallows errors' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('error-handling');
  });

  it('matches boundary condition findings', () => {
    const findings = [
      makeFinding({ category: 'bug', message: 'null pointer dereference when input is undefined' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('boundary-conditions');
  });

  it('matches SOLID findings', () => {
    const findings = [
      makeFinding({
        category: 'design',
        message: 'god class with too many responsibilities (SRP violation)',
      }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('solid');
  });

  // ─── Check-Level Matching ─────────────────────────────────

  it('matches specific check IDs when keywords match', () => {
    const findings = [
      makeFinding({
        category: 'security',
        message: 'SQL injection vulnerability detected in query builder',
      }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings[0]?.checkId).toBe('injection-prevention');
  });

  it('uses check weight when matched to specific check', () => {
    const findings = [
      makeFinding({ severity: 'critical', category: 'security', message: 'SQL injection found' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    // injection-prevention weight = 10, critical multiplier = 5
    expect(result.findings[0]?.checkWeight).toBe(10);
    expect(result.findings[0]?.score).toBe(10 * SEVERITY_MULTIPLIER.critical!);
  });

  it('falls back to dimension-level match when no check matches', () => {
    const findings = [
      makeFinding({
        category: 'security',
        message: 'a general security concern about the codebase',
      }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.dimensionId).toBe('security');
    // Dimension-level match uses average weight, no specific check
    expect(result.findings[0]?.checkId).toBeNull();
  });

  // ─── Severity Multipliers ─────────────────────────────────

  it('applies correct severity multipliers', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
    for (const severity of severities) {
      const findings = [makeFinding({ severity, category: 'security', message: 'XSS injection' })];
      const result = scoreFindings(findings, DEFAULT_CHECKLIST);
      const expected = result.findings[0]?.checkWeight * SEVERITY_MULTIPLIER[severity]!;
      expect(result.findings[0]?.score).toBe(expected);
    }
  });

  // ─── Sorting ──────────────────────────────────────────────

  it('sorts findings by score descending', () => {
    const findings: ScorableFinding[] = [
      makeFinding({
        severity: 'low',
        category: 'security',
        message: 'minor credential issue with sensitive data',
      }),
      makeFinding({
        severity: 'critical',
        category: 'security',
        message: 'SQL injection vulnerability',
      }),
      makeFinding({
        severity: 'medium',
        category: 'bug',
        message: 'empty catch block swallows error',
      }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    for (let i = 1; i < result.findings.length; i++) {
      expect(result.findings[i - 1]?.score).toBeGreaterThanOrEqual(result.findings[i]?.score);
    }
  });

  // ─── Dimension Scores ─────────────────────────────────────

  it('aggregates dimension scores correctly', () => {
    const findings: ScorableFinding[] = [
      makeFinding({ severity: 'high', category: 'security', message: 'SQL injection' }),
      makeFinding({
        severity: 'medium',
        category: 'security',
        message: 'XSS injection in template',
      }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    const secDim = result.dimensionScores.find((d) => d.dimensionId === 'security');
    expect(secDim).toBeDefined();
    expect(secDim?.findingCount).toBe(2);
    expect(secDim?.totalScore).toBe(
      result.findings
        .filter((f) => f.dimensionId === 'security')
        .reduce((sum, f) => sum + f.score, 0),
    );
  });

  it('only includes dimensions with findings in dimensionScores', () => {
    const findings = [
      makeFinding({ severity: 'high', category: 'security', message: 'SQL injection' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.dimensionScores).toHaveLength(1);
    expect(result.dimensionScores[0]?.dimensionId).toBe('security');
  });

  it('sorts dimension scores by total score descending', () => {
    const findings: ScorableFinding[] = [
      makeFinding({ severity: 'low', category: 'design', message: 'SRP violation' }),
      makeFinding({ severity: 'critical', category: 'security', message: 'SQL injection' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    if (result.dimensionScores.length > 1) {
      expect(result.dimensionScores[0]?.totalScore).toBeGreaterThanOrEqual(
        result.dimensionScores[1]?.totalScore,
      );
    }
  });

  // ─── Total Score ──────────────────────────────────────────

  it('total score equals sum of all finding scores', () => {
    const findings: ScorableFinding[] = [
      makeFinding({
        severity: 'critical',
        category: 'security',
        message: 'injection vulnerability',
      }),
      makeFinding({
        severity: 'high',
        category: 'bug',
        message: 'null reference crash when undefined',
      }),
      makeFinding({ severity: 'medium', category: 'design', message: 'SRP violation in module' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    const expectedTotal = result.findings.reduce((sum, f) => sum + f.score, 0);
    expect(result.totalScore).toBe(expectedTotal);
  });

  // ─── Unmatched Findings ───────────────────────────────────

  it('excludes findings that match no dimension', () => {
    const findings = [
      makeFinding({ category: 'style', message: 'trailing whitespace on line 42' }),
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    expect(result.findings).toHaveLength(0);
    expect(result.totalScore).toBe(0);
  });

  // ─── findingIndex ─────────────────────────────────────────

  it('preserves original finding index', () => {
    const findings: ScorableFinding[] = [
      makeFinding({ category: 'style', message: 'whitespace issue' }), // index 0, no match
      makeFinding({ severity: 'high', category: 'security', message: 'injection found' }), // index 1
      makeFinding({ category: 'style', message: 'naming convention' }), // index 2, no match
      makeFinding({ severity: 'low', category: 'bug', message: 'null check missing' }), // index 3
    ];
    const result = scoreFindings(findings, DEFAULT_CHECKLIST);
    const indices = result.findings.map((f) => f.findingIndex);
    expect(indices).toContain(1);
    expect(indices).toContain(3);
    expect(indices).not.toContain(0);
    expect(indices).not.toContain(2);
  });

  // ─── Disabled Checks ──────────────────────────────────────

  it('skips disabled checks during matching', () => {
    const config: ChecklistConfig = {
      enabled: true,
      dimensions: [
        {
          id: 'security',
          name: 'Security',
          enabled: true,
          checks: [
            { id: 'injection-prevention', description: 'test', weight: 10, enabled: false },
            { id: 'auth-checks', description: 'test', weight: 9, enabled: true },
          ],
        },
      ],
    };
    // This would match injection-prevention if it were enabled
    const findings = [makeFinding({ category: 'security', message: 'XSS injection found' })];
    const result = scoreFindings(findings, config);
    // Should not match injection-prevention (disabled), but may match dimension-level
    if (result.findings.length > 0) {
      expect(result.findings[0]?.checkId).not.toBe('injection-prevention');
    }
  });
});
