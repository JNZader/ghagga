/**
 * Digest issue body formatter tests (nightly-health-digest T4.1).
 *
 * Pure byte-level assertions: marker header first line, per-severity window
 * counts, ranked files in ranking order with scores, trend present on update /
 * cleanly omitted on first digest, byte-identical determinism, empty inputs
 * never throw.
 */

import { describe, expect, it } from 'vitest';
import { DIGEST_ISSUE_MARKER, formatDigestIssue } from './format-digest.js';
import type { DigestInputs, FileRisk } from './health/digest.js';
import type { HealthTrend } from './health/trends.js';

// ─── Helpers ────────────────────────────────────────────────────

function inputsWith(counts: Partial<Record<string, number>>): DigestInputs {
  return {
    findings: [],
    severityCounts: {
      critical: counts.critical ?? 0,
      high: counts.high ?? 0,
      medium: counts.medium ?? 0,
      low: counts.low ?? 0,
      info: counts.info ?? 0,
    },
    reviews: [],
    fileBlastRadius: {},
    skippedRows: 0,
  };
}

const RANKED: FileRisk[] = [
  { file: 'src/auth.ts', score: 87, blastRadius: 4 },
  { file: 'src/db.ts', score: 41, blastRadius: 0 },
];

// ─── Tests ──────────────────────────────────────────────────────

describe('formatDigestIssue', () => {
  it('starts with the digest marker header as the first line', () => {
    const body = formatDigestIssue(inputsWith({ high: 1 }), undefined, []);
    expect(body.split('\n')[0]).toBe(DIGEST_ISSUE_MARKER);
    expect(DIGEST_ISSUE_MARKER).toBe('<!-- ghagga-digest -->');
  });

  it('is byte-identical for identical inputs (determinism)', () => {
    const trend: HealthTrend = { previous: 72, delta: -7, direction: 'down' };
    const a = formatDigestIssue(inputsWith({ critical: 1, high: 4, medium: 9 }), trend, RANKED);
    const b = formatDigestIssue(inputsWith({ critical: 1, high: 4, medium: 9 }), trend, RANKED);
    expect(a).toBe(b);
  });

  it('renders per-severity window counts and ranked files in ranking order with scores', () => {
    const body = formatDigestIssue(
      inputsWith({ critical: 1, high: 4, medium: 9 }),
      undefined,
      RANKED,
    );

    // Summary counts: every severity row is present with its count.
    expect(body).toContain('| Critical | 1 |');
    expect(body).toContain('| High | 4 |');
    expect(body).toContain('| Medium | 9 |');
    expect(body).toContain('| Low | 0 |');
    expect(body).toContain('| Info | 0 |');

    // Ranked files appear in ranking order, highest first.
    const authIndex = body.indexOf('src/auth.ts');
    const dbIndex = body.indexOf('src/db.ts');
    expect(authIndex).toBeGreaterThan(-1);
    expect(dbIndex).toBeGreaterThan(authIndex);
    expect(body).toContain('`src/auth.ts` | 87 |');
    expect(body).toContain('`src/db.ts` | 41 |');
  });

  it('renders a trend line with delta on update (-7, worsening at 65 vs 72)', () => {
    const trend: HealthTrend = { previous: 72, delta: -7, direction: 'down' };
    const body = formatDigestIssue(inputsWith({}), trend, []);
    expect(body).toContain('65 vs previous 72 (-7, worsening)');
  });

  it('omits the trend line cleanly on the first digest (no previous)', () => {
    const firstRun: HealthTrend = { previous: null, delta: null, direction: null };
    for (const trend of [undefined, firstRun]) {
      const body = formatDigestIssue(inputsWith({ high: 2 }), trend, []);
      expect(body).not.toContain('Trend');
      expect(() => formatDigestIssue(inputsWith({ high: 2 }), trend, [])).not.toThrow();
    }
  });

  it('omits the ranked-files section cleanly for an empty ranked list', () => {
    const body = formatDigestIssue(inputsWith({ low: 3 }), undefined, []);
    expect(body).not.toContain('Riskiest files');
    // Still valid GFM: the counts table closes cleanly.
    expect(body.trimEnd().endsWith('| Info | 0 |')).toBe(true);
  });

  it('sanitizes attacker-controlled file paths inside inline-code spans', () => {
    const evil: FileRisk[] = [
      { file: 'x\n# PWNED\n| t |', score: 1, blastRadius: 0 },
      { file: 'src/`breakout`.ts', score: 2, blastRadius: 0 },
    ];
    const body = formatDigestIssue(inputsWith({}), undefined, evil);
    // No newline survives → the injected "# PWNED" heading can never start a
    // line (newlines flatten to spaces); pipes are escaped; backticks are
    // stripped so the inline-code span cannot be closed early.
    const bodyLines = body.split('\n');
    expect(bodyLines.some((line) => line.startsWith('# PWNED'))).toBe(false);
    expect(bodyLines.some((line) => line.includes('| t |') && !line.includes('\\|'))).toBe(false);
    expect(body).toContain('`x # PWNED \\| t \\|`');
    expect(body).toContain('`src/breakout.ts`');
  });

  it('renders a +delta as improving and 0 as unchanged (wording from delta sign)', () => {
    expect(
      formatDigestIssue(inputsWith({}), { previous: 60, delta: 5, direction: 'up' }, []),
    ).toContain('65 vs previous 60 (+5, improving)');
    expect(
      formatDigestIssue(inputsWith({}), { previous: 60, delta: 0, direction: 'unchanged' }, []),
    ).toContain('60 vs previous 60 (0, unchanged)');
  });
});
