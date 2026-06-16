/**
 * Unit tests for the static-only verdict scoping (scope-static-findings fix).
 *
 * The static-analysis pipeline scans the WHOLE repo, so a 1-file change can
 * surface pre-existing findings from unrelated files. These must NOT drive the
 * verdict to FAILED. Only findings within the changed/affected (blast-radius)
 * file set — PLUS dependency/SCA findings (Trivy), which live in lockfiles not
 * in the diff — may flip the verdict.
 *
 * createStaticOnlyResult is the deterministic verdict path (AI disabled or AI
 * failed). It is the place the task pins as driving `status`.
 */

import { describe, expect, it } from 'vitest';
import type { ReviewFinding, StaticAnalysisResult } from '../types.js';
import { createStaticOnlyResult } from './results.js';

function semgrepFinding(file: string, severity: ReviewFinding['severity'] = 'high'): ReviewFinding {
  return {
    severity,
    category: 'security',
    file,
    line: 5,
    message: `static finding in ${file}`,
    source: 'semgrep',
  };
}

function trivyFinding(file: string): ReviewFinding {
  return {
    severity: 'critical',
    category: 'dependency-vulnerability',
    file,
    line: 1,
    message: `CVE in ${file}`,
    source: 'trivy',
  };
}

function staticWith(findings: ReviewFinding[]): StaticAnalysisResult {
  return {
    semgrep: {
      status: 'success',
      findings: findings.filter((f) => f.source === 'semgrep'),
      executionTimeMs: 1,
    },
    trivy: {
      status: 'success',
      findings: findings.filter((f) => f.source === 'trivy'),
      executionTimeMs: 1,
    },
    cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
  };
}

describe('createStaticOnlyResult — verdict scoping', () => {
  it('(a) out-of-scope static finding does NOT flip the verdict to FAILED', () => {
    const staticResult = staticWith([semgrepFinding('src/unrelated.ts', 'high')]);
    const result = createStaticOnlyResult(staticResult, 'simple', 0, ['src/changed.ts']);
    expect(result.status).toBe('PASSED');
    // ...but the finding is still VISIBLE (merged informational), not deleted here.
    // (merge into result.findings happens in enrich; here findings starts empty)
  });

  it('(b) in-scope static finding DOES drive the verdict to FAILED', () => {
    const staticResult = staticWith([semgrepFinding('src/changed.ts', 'high')]);
    const result = createStaticOnlyResult(staticResult, 'simple', 0, ['src/changed.ts']);
    expect(result.status).toBe('FAILED');
  });

  it('(c) Trivy/SCA finding OUTSIDE the changed set STILL drives the verdict (exemption)', () => {
    // Lockfile not in the diff — but a dependency CVE must still count.
    const staticResult = staticWith([trivyFinding('package-lock.json')]);
    const result = createStaticOnlyResult(staticResult, 'simple', 0, ['src/changed.ts']);
    expect(result.status).toBe('FAILED');
  });

  it('(d) blast-radius: a finding in an affected (not directly changed) file counts', () => {
    // affectedFiles = changed + dependents (blast radius). A finding in a
    // dependent file is in-scope.
    const staticResult = staticWith([semgrepFinding('src/dependent.ts', 'critical')]);
    const result = createStaticOnlyResult(staticResult, 'simple', 0, [
      'src/changed.ts',
      'src/dependent.ts',
    ]);
    expect(result.status).toBe('FAILED');
  });

  it('mixed: out-of-scope non-SCA ignored, out-of-scope SCA kept, in-scope kept', () => {
    const staticResult = staticWith([
      semgrepFinding('src/unrelated.ts', 'critical'), // out-of-scope non-SCA → ignored
    ]);
    const passing = createStaticOnlyResult(staticResult, 'simple', 0, ['src/changed.ts']);
    expect(passing.status).toBe('PASSED');

    const withSca = staticWith([
      semgrepFinding('src/unrelated.ts', 'critical'),
      trivyFinding('package-lock.json'),
    ]);
    const failing = createStaticOnlyResult(withSca, 'simple', 0, ['src/changed.ts']);
    expect(failing.status).toBe('FAILED');
  });

  it('empty affected set falls back to no-scope-filter behavior (all findings count)', () => {
    // Defensive: if the affected set is empty/undefined, do NOT silently pass
    // everything — keep legacy behavior (count all findings).
    const staticResult = staticWith([semgrepFinding('src/anything.ts', 'high')]);
    const result = createStaticOnlyResult(staticResult, 'simple', 0, undefined);
    expect(result.status).toBe('FAILED');
  });
});
