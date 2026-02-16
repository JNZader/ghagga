/**
 * Tests for memory-related functions in pull_request handler
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { extractFindingsFromResult } from '../pull_request.ts';

describe('extractFindingsFromResult', () => {
  it('should extract a single info finding from string result', () => {
    const result = 'The code looks good overall. Minor style issues found.';
    const findings = extractFindingsFromResult(result);

    assertEquals(findings.length, 1);
    assertEquals(findings[0].severity, 'info');
    assertEquals(findings[0].category, 'review');
    assertEquals(findings[0].message, result.slice(0, 500));
  });

  it('should truncate long string results to 500 chars', () => {
    const result = 'A'.repeat(1000);
    const findings = extractFindingsFromResult(result);

    assertEquals(findings[0].message.length, 500);
  });

  it('should extract findings from workflow result', () => {
    const workflowResult = {
      status: 'completed',
      synthesis: { findings: 'Overall good' },
      findings: [
        { stepName: 'security', findings: 'No security issues found' },
        { stepName: 'quality', findings: 'Code quality is high' },
      ],
      totalDuration_ms: 1000,
    };

    const findings = extractFindingsFromResult(workflowResult);

    assertEquals(findings.length, 2);
    assertEquals(findings[0].category, 'security');
    assertEquals(findings[0].severity, 'info');
    assertEquals(findings[0].message, 'No security issues found');
    assertEquals(findings[1].category, 'quality');
  });

  it('should extract finding from consensus result with approve', () => {
    const consensusResult = {
      recommendation: { action: 'approve', confidence: 0.9 },
      synthesis: 'Code is well-written and follows best practices',
    };

    const findings = extractFindingsFromResult(consensusResult);

    assertEquals(findings.length, 1);
    assertEquals(findings[0].severity, 'info');
    assertEquals(findings[0].category, 'consensus');
    assertEquals(findings[0].message, 'Code is well-written and follows best practices');
  });

  it('should extract error finding from consensus result with reject', () => {
    const consensusResult = {
      recommendation: { action: 'reject', confidence: 0.8 },
      synthesis: 'Critical security vulnerability found',
    };

    const findings = extractFindingsFromResult(consensusResult);

    assertEquals(findings.length, 1);
    assertEquals(findings[0].severity, 'error');
    assertEquals(findings[0].category, 'consensus');
  });

  it('should handle empty workflow findings', () => {
    const workflowResult = {
      status: 'completed',
      synthesis: { findings: '' },
      findings: [],
      totalDuration_ms: 500,
    };

    const findings = extractFindingsFromResult(workflowResult);
    assertEquals(findings.length, 0);
  });
});
