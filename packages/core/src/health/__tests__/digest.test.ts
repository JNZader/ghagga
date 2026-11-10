/**
 * Digest aggregation unit tests (nightly-health-digest S1).
 *
 * aggregateHealth: DB-sourced stored-findings aggregation with watermark
 * windowing and malformed-row tolerance. rankFileRisk: deterministic per-file
 * risk ranking (severity weight x recency, blast-radius + path tiebreaks).
 *
 * All tests are pure: no forge, no HTTP, no filesystem, no LLM calls.
 */

import { describe, expect, it } from 'vitest';

import type { FindingSeverity, ReviewFinding } from '../../types.js';
import { aggregateHealth, type DigestInputs, type ReviewRow, rankFileRisk } from '../digest.js';
import { generateRecommendations } from '../recommendations.js';
import { computeHealthScore } from '../score.js';

// ─── Helpers ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function mockFinding(overrides?: Partial<ReviewFinding>): ReviewFinding {
  return {
    file: 'src/app.ts',
    line: 10,
    severity: 'medium',
    category: 'quality',
    message: 'Test finding',
    source: 'semgrep',
    ...overrides,
  };
}

function daysAgo(days: number, from: Date): Date {
  return new Date(from.getTime() - days * DAY_MS);
}

/** Base "now" so recency tiers are stable regardless of wall clock. */
const NOW = new Date('2026-11-10T03:00:00.000Z');

// ─── aggregateHealth ────────────────────────────────────────────

describe('aggregateHealth: aggregation window since watermark', () => {
  it.each([
    {
      name: 'R1 yesterday 1 high + R2 today 2 low counted, R0 last-week 5 critical excluded',
      rows: (): ReviewRow[] => [
        {
          findings: Array.from({ length: 5 }, () => mockFinding({ severity: 'critical' })),
          metadata: null,
          createdAt: daysAgo(8, NOW), // R0: last week, before the watermark
        },
        {
          findings: [mockFinding({ severity: 'high', file: 'src/a.ts' })],
          metadata: null,
          createdAt: daysAgo(1, NOW), // R1: yesterday
        },
        {
          findings: [
            mockFinding({ severity: 'low', file: 'src/b.ts' }),
            mockFinding({ severity: 'low', file: 'src/c.ts' }),
          ],
          metadata: null,
          createdAt: NOW, // R2: today
        },
      ],
      since: (): Date => daysAgo(3, NOW),
      expectHigh: 1,
      expectLow: 2,
      expectCritical: 0,
    },
    {
      name: 'no watermark arg aggregates every row',
      rows: (): ReviewRow[] => [
        {
          findings: [mockFinding({ severity: 'high' })],
          metadata: null,
          createdAt: daysAgo(40, NOW),
        },
      ],
      since: (): Date | undefined => undefined,
      expectHigh: 1,
      expectLow: 0,
      expectCritical: 0,
    },
  ])('$name', ({ rows, since, expectHigh, expectLow, expectCritical }) => {
    const inputs = aggregateHealth(rows(), since());

    expect(inputs.severityCounts.high).toBe(expectHigh);
    expect(inputs.severityCounts.low).toBe(expectLow);
    expect(inputs.severityCounts.critical).toBe(expectCritical);
    expect(inputs.findings).toHaveLength(expectHigh + expectLow + expectCritical);
  });

  it('combined window finding set keeps every well-formed finding from every row', () => {
    const inputs = aggregateHealth(
      [
        {
          findings: [mockFinding({ severity: 'high', file: 'src/a.ts' })],
          metadata: null,
          createdAt: daysAgo(1, NOW),
        },
        {
          findings: [mockFinding({ severity: 'medium', file: 'src/b.ts' })],
          metadata: null,
          createdAt: daysAgo(2, NOW),
        },
      ],
      daysAgo(3, NOW),
    );

    expect(inputs.findings.map((f) => f.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('aggregateHealth: malformed findings rows are tolerated', () => {
  const wellFormed: ReviewFinding[] = [
    mockFinding({ severity: 'high', file: 'src/ok.ts' }),
    mockFinding({ severity: 'medium', file: 'src/ok.ts' }),
  ];

  it.each([
    { name: 'findings: null', findings: null },
    { name: 'findings: {} (non-array)', findings: {} },
    { name: 'findings: [not-a-finding]', findings: [{ not: 'a finding' }] },
    { name: 'findings: [missing severity]', findings: [{ file: 'src/x.ts' }] },
    { name: 'findings: [invalid severity]', findings: [{ file: 'src/x.ts', severity: 'ultra' }] },
    {
      name: 'findings: [finding missing file kept for counts]',
      findings: [{ severity: 'low' }],
    },
  ])(
    '$name — never throws, well-formed rows in the same window aggregate normally',
    ({ findings }) => {
      const inputs = aggregateHealth([
        { findings: null, metadata: null, createdAt: daysAgo(2, NOW) },
        { findings: wellFormed, metadata: null, createdAt: daysAgo(1, NOW) },
        { findings, metadata: null, createdAt: daysAgo(1, NOW) },
      ]);

      // The well-formed row still aggregates normally.
      expect(inputs.severityCounts.high).toBe(1);
      expect(inputs.severityCounts.medium).toBe(1);
      // Well-formed findings are never lost; entries with a valid severity but
      // no file stay too (they only skip ranking — asserted separately below).
      expect(inputs.findings.length).toBeGreaterThanOrEqual(2);
      // Malformed rows are skipped, never fatal.
      expect(inputs.skippedRows).toBeGreaterThanOrEqual(0);
    },
  );

  it('entries missing file stay in severity counts but never enter ranking', () => {
    const inputs = aggregateHealth([
      {
        findings: [{ severity: 'low' } as unknown as ReviewFinding],
        metadata: null,
        createdAt: daysAgo(1, NOW),
      },
    ]);

    expect(inputs.severityCounts.low).toBe(1);
    const risks = rankFileRisk(inputs, NOW);
    expect(risks).toHaveLength(0);
  });

  it('skippedRows counts rows whose findings yield no valid entries', () => {
    const inputs = aggregateHealth([
      { findings: null, metadata: null, createdAt: daysAgo(1, NOW) },
      { findings: {}, metadata: null, createdAt: daysAgo(1, NOW) },
      {
        findings: [{ not: 'a finding' }],
        metadata: null,
        createdAt: daysAgo(1, NOW),
      },
      { findings: [mockFinding()], metadata: null, createdAt: daysAgo(1, NOW) },
    ]);

    expect(inputs.skippedRows).toBe(3);
    expect(inputs.findings).toHaveLength(1);
  });
});

describe('aggregateHealth: stored-findings scoring equivalence', () => {
  // 2 critical + 3 medium — the same shape fed live to the health command.
  const stored: ReviewFinding[] = [
    mockFinding({ severity: 'critical', file: 'src/a.ts' }),
    mockFinding({ severity: 'critical', file: 'src/b.ts' }),
    mockFinding({ severity: 'medium', file: 'src/c.ts' }),
    mockFinding({ severity: 'medium', file: 'src/c.ts' }),
    mockFinding({ severity: 'medium', file: 'src/d.ts' }),
  ];

  const inputs = aggregateHealth([
    { findings: stored.slice(0, 2), metadata: null, createdAt: daysAgo(1, NOW) },
    { findings: stored.slice(2), metadata: null, createdAt: daysAgo(2, NOW) },
  ]);

  it('yields identical score and severity counts to the live path', () => {
    const storedScore = computeHealthScore(inputs.findings);
    const liveScore = computeHealthScore(stored);

    expect(storedScore.score).toBe(liveScore.score);
    expect(storedScore.grade).toBe(liveScore.grade);
    expect(storedScore.findingCounts).toEqual(liveScore.findingCounts);
    expect(storedScore.totalFindings).toBe(liveScore.totalFindings);
  });

  it('yields identical recommendations to the live path', () => {
    expect(generateRecommendations(inputs.findings)).toEqual(generateRecommendations(stored));
  });
});

// ─── rankFileRisk ───────────────────────────────────────────────

describe('rankFileRisk', () => {
  it('a.ts (3 high, recent) ranks above b.ts (1 low, older)', () => {
    const inputs = aggregateHealth([
      {
        findings: Array.from({ length: 3 }, () =>
          mockFinding({ severity: 'high', file: 'src/a.ts' }),
        ),
        metadata: { blastRadius: { blastRadiusFiles: 4 } },
        createdAt: daysAgo(2, NOW),
      },
      {
        findings: [mockFinding({ severity: 'low', file: 'src/b.ts' })],
        metadata: null,
        createdAt: daysAgo(20, NOW),
      },
    ]);

    const risks = rankFileRisk(inputs, NOW);
    expect(risks[0]?.file).toBe('src/a.ts');
    expect(risks[1]?.file).toBe('src/b.ts');
    expect(risks[0]?.score).toBeGreaterThan(risks[1]?.score ?? 0);
  });

  it.each([
    {
      name: 'review age 7d exactly -> x1.0',
      ageDays: 7,
      severity: 'high' as FindingSeverity,
      expectedScore: 10,
    },
    {
      name: 'review age 8d -> x0.5',
      ageDays: 8,
      severity: 'high' as FindingSeverity,
      expectedScore: 5,
    },
    {
      name: 'review age 30d exactly -> still in window at x0.5',
      ageDays: 30,
      severity: 'critical' as FindingSeverity,
      expectedScore: 10, // |−20| x 0.5
    },
    {
      name: 'review age 31d -> excluded from ranking',
      ageDays: 31,
      severity: 'critical' as FindingSeverity,
      expectedScore: 0, // not ranked at all
    },
  ])('recency tier: $name', ({ ageDays, severity, expectedScore }) => {
    const inputs = aggregateHealth([
      {
        findings: [mockFinding({ severity, file: 'src/x.ts' })],
        metadata: null,
        createdAt: daysAgo(ageDays, NOW),
      },
    ]);

    const risks = rankFileRisk(inputs, NOW);
    if (expectedScore === 0) {
      expect(risks).toHaveLength(0);
    } else {
      expect(risks).toHaveLength(1);
      expect(risks[0]?.score).toBe(expectedScore);
    }
  });

  it('reuses SEVERITY_WEIGHTS: info findings contribute zero risk and never rank a file on their own', () => {
    const inputs = aggregateHealth([
      {
        findings: [mockFinding({ severity: 'info', file: 'src/x.ts' })],
        metadata: null,
        createdAt: NOW,
      },
    ]);

    // Counted in the window totals (SEVERITY_WEIGHTS.info === 0 means no
    // deduction), but a zero-risk file is not a "riskiest file".
    expect(inputs.severityCounts.info).toBe(1);
    expect(rankFileRisk(inputs, NOW)).toEqual([]);
  });

  it('tiebreak 1: larger blast-radius dependents from metadata ranks first', () => {
    const inputs = aggregateHealth([
      {
        findings: [mockFinding({ severity: 'medium', file: 'src/flat.ts' })],
        metadata: null,
        createdAt: daysAgo(2, NOW),
      },
      {
        findings: [mockFinding({ severity: 'medium', file: 'src/wide.ts' })],
        metadata: { blastRadius: { blastRadiusFiles: 9 } },
        createdAt: daysAgo(2, NOW),
      },
    ]);

    const risks = rankFileRisk(inputs, NOW);
    expect(risks.map((r) => r.file)).toEqual(['src/wide.ts', 'src/flat.ts']);
    expect(risks[0]?.blastRadius).toBe(9);
    expect(risks[1]?.blastRadius).toBe(0);
  });

  it('tiebreak 2: equal score and blast radius fall back to path asc', () => {
    const inputs = aggregateHealth([
      {
        findings: [
          mockFinding({ severity: 'medium', file: 'src/zeta.ts' }),
          mockFinding({ severity: 'medium', file: 'src/alpha.ts' }),
        ],
        metadata: null,
        createdAt: daysAgo(2, NOW),
      },
    ]);

    const risks = rankFileRisk(inputs, NOW);
    expect(risks.map((r) => r.file)).toEqual(['src/alpha.ts', 'src/zeta.ts']);
  });

  it('caps the ranking at the top 10 files', () => {
    const inputs = aggregateHealth([
      {
        findings: Array.from({ length: 15 }, (_, i) =>
          mockFinding({ severity: 'low', file: `src/f${i}.ts` }),
        ),
        metadata: null,
        createdAt: NOW,
      },
    ]);

    const risks = rankFileRisk(inputs, NOW);
    expect(risks).toHaveLength(10);
  });

  it('determinism: identical inputs produce identical order and per-file scores', () => {
    const mkInputs = (): DigestInputs =>
      aggregateHealth([
        {
          findings: [
            mockFinding({ severity: 'high', file: 'src/b.ts' }),
            mockFinding({ severity: 'low', file: 'src/a.ts' }),
            mockFinding({ severity: 'critical', file: 'src/b.ts' }),
          ],
          metadata: { blastRadius: { blastRadiusFiles: 3 } },
          createdAt: daysAgo(5, NOW),
        },
        {
          findings: [mockFinding({ severity: 'medium', file: 'src/a.ts' })],
          metadata: null,
          createdAt: daysAgo(15, NOW),
        },
      ]);

    const first = rankFileRisk(mkInputs(), NOW);
    const second = rankFileRisk(mkInputs(), NOW);

    expect(first).toEqual(second);
  });

  it('findings without file are excluded from ranking but kept in severity counts', () => {
    const inputs = aggregateHealth([
      {
        findings: [
          mockFinding({ severity: 'high', file: 'src/ranked.ts' }),
          { severity: 'low' } as unknown as ReviewFinding,
        ],
        metadata: null,
        createdAt: NOW,
      },
    ]);

    expect(inputs.severityCounts.low).toBe(1);
    const risks = rankFileRisk(inputs, NOW);
    expect(risks.map((r) => r.file)).toEqual(['src/ranked.ts']);
  });

  it('empty window yields an empty ranking without throwing', () => {
    const risks = rankFileRisk(aggregateHealth([], NOW), NOW);
    expect(risks).toEqual([]);
  });
});
