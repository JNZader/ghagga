/**
 * Tests for TUI-polished review output.
 *
 * Validates formatBoxSummary, formatToolDivider, and formatMarkdownResult
 * from ui/format.ts — the pure functions behind the review command's
 * box summary, tool section dividers, and markdown output.
 *
 * All functions are pure (string in, string out) — no mocking needed.
 */

import type { ReviewResult } from 'ghagga-core';
import { describe, expect, it } from 'vitest';
import { formatBoxSummary, formatMarkdownResult, formatToolDivider } from '../../ui/format.js';

// ─── Helpers ────────────────────────────────────────────────────

function mockResult(overrides?: Partial<ReviewResult>): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'All good',
    findings: [],
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
      executionTimeMs: 2500,
      tokensUsed: 150,
      toolsRun: ['semgrep', 'trivy'],
      toolsSkipped: ['cpd'],
    },
    ...overrides,
  };
}

// ─── formatBoxSummary ───────────────────────────────────────────

describe('formatBoxSummary', () => {
  it('includes status, time, mode, and model', () => {
    const lines = formatBoxSummary(mockResult());
    const text = lines.join('\n');
    expect(text).toContain('PASSED');
    expect(text).toContain('2.5s');
    expect(text).toContain('simple');
    expect(text).toContain('gpt-4o-mini');
  });

  it('shows finding counts by severity', () => {
    const result = mockResult({
      findings: [
        { file: 'a.ts', severity: 'critical', category: 'sec', message: 'bad', source: 'semgrep' },
        { file: 'b.ts', severity: 'high', category: 'sec', message: 'bad', source: 'semgrep' },
        { file: 'c.ts', severity: 'medium', category: 'quality', message: 'meh', source: 'trivy' },
      ],
    });
    const lines = formatBoxSummary(result);
    const text = lines.join('\n');
    expect(text).toContain('3 total');
    expect(text).toContain('critical');
    expect(text).toContain('high');
    expect(text).toContain('medium');
  });

  it('shows clean message when no findings', () => {
    const lines = formatBoxSummary(mockResult());
    const text = lines.join('\n');
    expect(text).toContain('0');
    expect(text).toContain('clean');
  });

  it('lists tools run', () => {
    const lines = formatBoxSummary(mockResult());
    const text = lines.join('\n');
    expect(text).toContain('semgrep');
    expect(text).toContain('trivy');
  });

  it('includes token count', () => {
    const lines = formatBoxSummary(mockResult());
    const text = lines.join('\n');
    expect(text).toContain('150');
  });

  it('does not show tools line when no tools ran', () => {
    const result = mockResult({
      metadata: {
        mode: 'simple',
        model: 'gpt-4o-mini',
        provider: 'gateway',
        executionTimeMs: 1000,
        tokensUsed: 50,
        toolsRun: [],
        toolsSkipped: [],
      },
    });
    const lines = formatBoxSummary(result);
    const text = lines.join('\n');
    expect(text).not.toContain('Tools:');
  });

  it('shows all five severity levels when present', () => {
    const result = mockResult({
      findings: [
        { file: 'a.ts', severity: 'critical', category: 'sec', message: 'x', source: 'ai' },
        { file: 'b.ts', severity: 'high', category: 'sec', message: 'x', source: 'ai' },
        { file: 'c.ts', severity: 'medium', category: 'sec', message: 'x', source: 'ai' },
        { file: 'd.ts', severity: 'low', category: 'sec', message: 'x', source: 'ai' },
        { file: 'e.ts', severity: 'info', category: 'sec', message: 'x', source: 'ai' },
      ],
    });
    const lines = formatBoxSummary(result);
    const text = lines.join('\n');
    expect(text).toContain('5 total');
    expect(text).toContain('critical');
    expect(text).toContain('high');
    expect(text).toContain('medium');
    expect(text).toContain('low');
    expect(text).toContain('info');
  });

  it('formats FAILED status correctly', () => {
    const result = mockResult({ status: 'FAILED' });
    const lines = formatBoxSummary(result);
    const text = lines.join('\n');
    expect(text).toContain('FAILED');
  });
});

// ─── formatToolDivider ──────────────────────────────────────────

describe('formatToolDivider', () => {
  it('contains the label and dash characters', () => {
    const divider = formatToolDivider('Semgrep (3)');
    expect(divider).toContain('Semgrep (3)');
    expect(divider).toContain('─');
  });

  it('has consistent structure with ─── prefix before label', () => {
    const divider = formatToolDivider('Trivy');
    expect(divider).toMatch(/─── Trivy ─+$/);
  });

  it('pads to consistent width with trailing dashes', () => {
    const short = formatToolDivider('A');
    const long = formatToolDivider('A longer label here');

    // Both should contain the ─── prefix pattern
    expect(short).toContain('─── A ');
    expect(long).toContain('─── A longer label here ');

    // Short label gets more trailing dashes
    const shortDashCount = (short.match(/─/g) ?? []).length;
    const longDashCount = (long.match(/─/g) ?? []).length;
    expect(shortDashCount).toBeGreaterThan(longDashCount);
  });

  it('starts with a newline for visual separation', () => {
    const divider = formatToolDivider('Test');
    expect(divider.startsWith('\n')).toBe(true);
  });

  it('handles empty label gracefully', () => {
    const divider = formatToolDivider('');
    expect(divider).toContain('─');
  });
});

// ─── formatMarkdownResult ───────────────────────────────────────

describe('formatMarkdownResult', () => {
  it('contains tool dividers when findings from multiple sources', () => {
    const result = mockResult({
      findings: [
        { file: 'a.ts', severity: 'high', category: 'sec', message: 'issue1', source: 'semgrep' },
        { file: 'b.ts', severity: 'medium', category: 'vuln', message: 'issue2', source: 'trivy' },
      ],
    });
    const output = formatMarkdownResult(result);
    // Uses ─ tool dividers (not markdown ### headings)
    expect(output).toContain('─');
    // Both tool labels should appear
    expect(output).toContain('Semgrep');
    expect(output).toContain('Trivy');
  });

  it('shows no findings message when findings are empty', () => {
    const output = formatMarkdownResult(mockResult());
    expect(output).toContain('No findings');
  });

  it('includes header with status and review branding', () => {
    const output = formatMarkdownResult(mockResult());
    expect(output).toContain('GHAGGA Code Review');
    expect(output).toContain('PASSED');
  });

  it('includes execution metadata', () => {
    const output = formatMarkdownResult(mockResult());
    expect(output).toContain('Mode: simple');
    expect(output).toContain('Model: gpt-4o-mini');
    expect(output).toContain('2.5s');
    expect(output).toContain('150');
  });

  it('renders findings with severity, category, and message', () => {
    const result = mockResult({
      findings: [
        {
          file: 'src/app.ts',
          line: 42,
          severity: 'critical',
          category: 'security',
          message: 'SQL injection vulnerability',
          source: 'semgrep',
        },
      ],
    });
    const output = formatMarkdownResult(result);
    expect(output).toContain('CRITICAL');
    expect(output).toContain('security');
    expect(output).toContain('SQL injection vulnerability');
    expect(output).toContain('src/app.ts:42');
  });

  it('renders suggestions when present', () => {
    const result = mockResult({
      findings: [
        {
          file: 'x.ts',
          severity: 'medium',
          category: 'perf',
          message: 'Slow query',
          suggestion: 'Add an index',
          source: 'ai',
        },
      ],
    });
    const output = formatMarkdownResult(result);
    expect(output).toContain('Add an index');
  });

  it('orders semgrep before trivy before ai findings', () => {
    const result = mockResult({
      findings: [
        { file: 'a.ts', severity: 'high', category: 'sec', message: 'ai issue', source: 'ai' },
        {
          file: 'b.ts',
          severity: 'medium',
          category: 'sec',
          message: 'trivy issue',
          source: 'trivy',
        },
        {
          file: 'c.ts',
          severity: 'low',
          category: 'sec',
          message: 'semgrep issue',
          source: 'semgrep',
        },
      ],
    });
    const output = formatMarkdownResult(result);
    const semgrepIdx = output.indexOf('Semgrep');
    const trivyIdx = output.indexOf('Trivy');
    const aiIdx = output.indexOf('AI Review');
    expect(semgrepIdx).toBeLessThan(trivyIdx);
    expect(trivyIdx).toBeLessThan(aiIdx);
  });

  it('includes static analysis section when tools ran', () => {
    const output = formatMarkdownResult(mockResult());
    expect(output).toContain('Static Analysis');
    expect(output).toContain('semgrep, trivy');
    expect(output).toContain('cpd');
  });

  it('includes the powered-by footer', () => {
    const output = formatMarkdownResult(mockResult());
    expect(output).toContain('Powered by GHAGGA');
  });
});
