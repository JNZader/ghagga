import { describe, expect, it } from 'vitest';
import type { ReviewFinding, SecurityTrace } from '../types.js';
import { openFindingsStillFail, verifyBeforePublish } from './verify-before-publish.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'critical',
    category: 'security',
    file: 'src/handler.ts',
    line: 10,
    message: 'SQL injection in the query builder',
    suggestion: 'Use a bound parameter',
    source: 'ai',
    securityTrace: trace(),
    ...overrides,
  };
}

function trace(): SecurityTrace {
  return {
    source: { file: 'src/handler.ts', line: 4 },
    path: { file: 'src/handler.ts', line: 8 },
    missingGuard: { file: 'src/handler.ts', line: 9 },
    sink: { file: 'src/db.ts', line: 20 },
  };
}

describe('verifyBeforePublish', () => {
  it('keeps a traced critical security finding open', () => {
    const [result] = verifyBeforePublish([finding()]);
    expect(result?.ledgerStatus).toBeUndefined();
    expect(result?.refuteReason).toBeUndefined();
  });

  it('refutes a critical security finding that has no trace, and does not drop it', () => {
    const input = [finding({ securityTrace: undefined, message: 'Missing bound parameter' })];
    const [result] = verifyBeforePublish(input);
    expect(result?.ledgerStatus).toBe('refuted');
    expect(result?.refuteReason).toBe('missing trace');
    expect(result?.message).toBe('Missing bound parameter');
  });

  it('applies the checklist to critical and high findings', () => {
    const results = verifyBeforePublish([
      finding({ message: 'first', line: 1 }),
      finding({ message: 'first', line: 1, severity: 'high' }),
      finding({
        severity: 'high',
        file: 'src/auth.test.ts',
        line: 3,
        message: 'assert leaks the token',
        category: 'bug',
        securityTrace: undefined,
      }),
      finding({
        severity: 'high',
        reachability: 'unreachable',
        message: 'Handler is unreachable from the router',
        category: 'bug',
        securityTrace: undefined,
        line: 5,
      }),
      finding({
        severity: 'critical',
        message: 'dead code left in the request path',
        category: 'bug',
        securityTrace: undefined,
        line: 6,
      }),
      finding({
        severity: 'high',
        message: 'The value is already sanitized before use',
        suggestion: 'No change',
        category: 'bug',
        securityTrace: undefined,
        line: 7,
      }),
      finding({
        severity: 'high',
        message: 'This might be a problem if the header is attacker controlled',
        category: 'bug',
        securityTrace: undefined,
        line: 8,
      }),
      finding({ severity: 'medium', message: 'possibly noisy but not in scope', line: 9 }),
    ]);

    expect(results.map((item) => item.refuteReason)).toEqual([
      undefined,
      'duplicate',
      'test-only',
      'unreachable',
      'dead code',
      'mitigated',
      'speculative',
      undefined,
    ]);
  });

  it('does not block when every critical finding is refuted', () => {
    const results = verifyBeforePublish([
      finding({ securityTrace: undefined, message: 'No trace' }),
    ]);
    expect(openFindingsStillFail(results)).toBe(false);
  });

  it('still fails when an open critical finding remains', () => {
    const results = verifyBeforePublish([
      finding(),
      finding({ securityTrace: undefined, message: 'No trace', line: 99 }),
    ]);
    expect(openFindingsStillFail(results)).toBe(true);
  });
});
