/**
 * SARIF builder unit tests.
 *
 * Validates that buildSarif produces spec-compliant SARIF v2.1.0
 * documents from ReviewResult inputs — covering severity mapping,
 * rule deduplication, location handling, and edge cases.
 */

import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewResult } from '../types.js';
import { buildSarif } from './builder.js';

// ─── Helpers ────────────────────────────────────────────────────

function mockResult(findings: ReviewFinding[] = []): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Test summary',
    findings,
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      model: 'gpt-4o-mini',
      provider: 'gateway',
      executionTimeMs: 1000,
      tokensUsed: 100,
      toolsRun: ['semgrep'],
      toolsSkipped: [],
    },
  };
}

// ─── Mock findings ──────────────────────────────────────────────

const semgrepFinding: ReviewFinding = {
  file: 'src/api.ts',
  line: 42,
  severity: 'high',
  category: 'Security',
  message: 'Hardcoded secret detected',
  source: 'semgrep',
};

const trivyFinding: ReviewFinding = {
  file: 'package.json',
  severity: 'medium',
  category: 'Dependency Vulnerability',
  message: 'lodash@4.17.20 has CVE-2021-23337',
  source: 'trivy',
};

// ─── Tests ──────────────────────────────────────────────────────

describe('buildSarif', () => {
  it('zero findings → valid SARIF with empty results', () => {
    const sarif = buildSarif(mockResult(), '1.0.0');

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toBe(
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    );
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(sarif.runs[0]?.tool.driver.rules).toEqual([]);
  });

  it('tool driver info has correct name, version, and informationUri', () => {
    const sarif = buildSarif(mockResult(), '2.5.0');
    const driver = sarif.runs[0]?.tool.driver;

    expect(driver.name).toBe('ghagga');
    expect(driver.version).toBe('2.5.0');
    expect(driver.informationUri).toBe('https://ghagga.dev');
  });

  it('single finding maps correctly to SARIF result', () => {
    const sarif = buildSarif(mockResult([semgrepFinding]), '1.0.0');
    const run = sarif.runs[0]!;

    expect(run.results).toHaveLength(1);

    const result = run.results[0]!;
    expect(result.ruleId).toBe('semgrep/security');
    expect(result.message.text).toBe('Hardcoded secret detected');
    expect(result.level).toBe('error');
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]?.physicalLocation.artifactLocation.uri).toBe('src/api.ts');
    expect(result.locations[0]?.physicalLocation.region?.startLine).toBe(42);
  });

  // ── Severity mapping ──────────────────────────────────────────

  it('severity mapping — critical → error', () => {
    const finding: ReviewFinding = { ...semgrepFinding, severity: 'critical' };
    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    expect(sarif.runs[0]?.results[0]?.level).toBe('error');
  });

  it('severity mapping — high → error', () => {
    const finding: ReviewFinding = { ...semgrepFinding, severity: 'high' };
    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    expect(sarif.runs[0]?.results[0]?.level).toBe('error');
  });

  it('severity mapping — medium → warning', () => {
    const finding: ReviewFinding = { ...semgrepFinding, severity: 'medium' };
    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    expect(sarif.runs[0]?.results[0]?.level).toBe('warning');
  });

  it('severity mapping — low → note', () => {
    const finding: ReviewFinding = { ...semgrepFinding, severity: 'low' };
    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    expect(sarif.runs[0]?.results[0]?.level).toBe('note');
  });

  it('severity mapping — info → note', () => {
    const finding: ReviewFinding = { ...semgrepFinding, severity: 'info' };
    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    expect(sarif.runs[0]?.results[0]?.level).toBe('note');
  });

  // ── Location handling ─────────────────────────────────────────

  it('finding with line number → region with startLine', () => {
    const sarif = buildSarif(mockResult([semgrepFinding]), '1.0.0');
    const location = sarif.runs[0].results[0].locations[0];

    expect(location.physicalLocation.region).toBeDefined();
    expect(location.physicalLocation.region?.startLine).toBe(42);
  });

  it('finding without line → no region property on physicalLocation', () => {
    const sarif = buildSarif(mockResult([trivyFinding]), '1.0.0');
    const location = sarif.runs[0].results[0].locations[0];

    expect(location.physicalLocation.artifactLocation.uri).toBe('package.json');
    expect(location.physicalLocation.region).toBeUndefined();
  });

  // ── Multiple findings & rule deduplication ────────────────────

  it('multiple findings from different tools → correct number of results and rules', () => {
    const sarif = buildSarif(mockResult([semgrepFinding, trivyFinding]), '1.0.0');
    const run = sarif.runs[0]!;

    expect(run.results).toHaveLength(2);
    expect(run.tool.driver.rules).toHaveLength(2);

    const ruleIds = run.tool.driver.rules.map((r) => r.id);
    expect(ruleIds).toContain('semgrep/security');
    expect(ruleIds).toContain('trivy/dependency-vulnerability');
  });

  it('two findings with same source+category → share a single rule entry', () => {
    const finding1: ReviewFinding = {
      file: 'src/a.ts',
      line: 10,
      severity: 'high',
      category: 'Security',
      message: 'First issue',
      source: 'semgrep',
    };

    const finding2: ReviewFinding = {
      file: 'src/b.ts',
      line: 20,
      severity: 'high',
      category: 'Security',
      message: 'Second issue',
      source: 'semgrep',
    };

    const sarif = buildSarif(mockResult([finding1, finding2]), '1.0.0');
    const run = sarif.runs[0]!;

    expect(run.results).toHaveLength(2);
    expect(run.tool.driver.rules).toHaveLength(1);
    expect(run.tool.driver.rules[0]?.id).toBe('semgrep/security');

    // Both results reference the same ruleId
    expect(run.results[0]?.ruleId).toBe('semgrep/security');
    expect(run.results[1]?.ruleId).toBe('semgrep/security');
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('unicode characters in messages → properly preserved in SARIF output', () => {
    const finding: ReviewFinding = {
      file: 'src/i18n.ts',
      line: 5,
      severity: 'low',
      category: 'Internationalization',
      message: 'Unescaped 日本語 string with émojis 🚀 and «special» chars',
      source: 'ai',
    };

    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    const result = sarif.runs[0].results[0];

    expect(result.message.text).toBe('Unescaped 日本語 string with émojis 🚀 and «special» chars');

    // Verify it round-trips through JSON serialization
    const json = JSON.stringify(sarif);
    const parsed = JSON.parse(json);
    expect(parsed.runs[0].results[0].message.text).toBe(
      'Unescaped 日本語 string with émojis 🚀 and «special» chars',
    );
  });

  it('rule ID format is source/category slugified (lowercase, spaces→dashes)', () => {
    const finding: ReviewFinding = {
      file: 'src/api.ts',
      line: 1,
      severity: 'medium',
      category: 'Dependency Vulnerability',
      message: 'Test',
      source: 'trivy',
    };

    const sarif = buildSarif(mockResult([finding]), '1.0.0');
    const ruleId = sarif.runs[0]?.results[0]?.ruleId;

    expect(ruleId).toBe('trivy/dependency-vulnerability');
  });
});
