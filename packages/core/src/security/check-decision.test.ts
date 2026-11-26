import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../types.js';
import {
  DEFAULT_SECURITY_CHECK_THRESHOLD,
  decideSecurityCheck,
  securityFindingsAtThreshold,
  shouldUpdateSecurityCheck,
} from './check-decision.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'critical',
    category: 'security',
    file: 'src/a.ts',
    line: 3,
    message: 'SQL injection',
    source: 'ai',
    ...overrides,
  };
}

describe('security check decision', () => {
  it('defaults the threshold to critical', () => {
    expect(DEFAULT_SECURITY_CHECK_THRESHOLD).toBe('critical');
    const decision = decideSecurityCheck([
      finding({ severity: 'high', message: 'below the default' }),
    ]);
    expect(decision.conclusion).toBe('success');
  });

  it('fails on a critical security finding and ignores a refuted one', () => {
    const decision = decideSecurityCheck([
      finding({ ledgerStatus: 'refuted', message: 'already answered' }),
      finding({ severity: 'low', category: 'style', source: 'ai', message: 'nit' }),
      finding(),
    ]);
    expect(decision.conclusion).toBe('failure');
    expect(decision.findings).toHaveLength(1);
    expect(decision.title).toContain('1 security finding');
  });

  it('treats a Trivy label as a security finding and honors a high threshold', () => {
    const findings = [
      finding({
        severity: 'high',
        category: 'dependency-vulnerability',
        source: 'trivy',
        message: 'CVE',
      }),
    ];
    expect(securityFindingsAtThreshold(findings, 'critical')).toHaveLength(0);
    expect(decideSecurityCheck(findings, 'high').conclusion).toBe('failure');
  });

  it('passes once the finding is gone', () => {
    expect(decideSecurityCheck([], 'critical').conclusion).toBe('success');
  });

  it('does not update the check for a skipped review', () => {
    expect(shouldUpdateSecurityCheck('SKIPPED')).toBe(false);
    expect(shouldUpdateSecurityCheck('FAILED')).toBe(true);
  });

  it('falls back to critical for an unknown threshold', () => {
    expect(decideSecurityCheck([finding({ severity: 'high' })], 'nope').conclusion).toBe('success');
  });
});
