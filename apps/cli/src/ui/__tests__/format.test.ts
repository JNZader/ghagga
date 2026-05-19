/**
 * Unit tests for pure formatting functions in format.ts.
 *
 * All functions are pure (string in, string out) — no mocking needed.
 */

import type { ReviewResult } from 'ghagga-core';
import { describe, expect, it } from 'vitest';
import {
  formatId,
  formatKeyValue,
  formatMarkdownResult,
  formatSize,
  formatTable,
  truncate,
} from '../format.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'All good.',
    findings: [],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 1000,
      executionTimeMs: 2000,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

// ─── formatTable ────────────────────────────────────────────────

describe('formatTable', () => {
  it('should format a table with headers, separator, and data rows', () => {
    const result = formatTable(
      ['Name', 'Age'],
      [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
      [10, 5],
    );
    const lines = result.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toBe('Name        Age  ');
    expect(lines[1]).toBe('──────────  ─────');
    expect(lines[2]).toBe('Alice       30   ');
    expect(lines[3]).toBe('Bob         25   ');
  });

  it('should format a table with a single row', () => {
    const result = formatTable(['ID'], [['42']], [4]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3); // header + separator + 1 row
    expect(lines[2]).toBe('42  ');
  });

  it('should format a table with no data rows', () => {
    const result = formatTable(['Col'], [], [6]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2); // header + separator only
    expect(lines[0]).toBe('Col   ');
    expect(lines[1]).toBe('──────');
  });

  it('should pad columns to specified widths', () => {
    const result = formatTable(['A', 'B'], [['x', 'y']], [8, 8]);
    const lines = result.split('\n');
    // Each column is padded to 8 chars
    expect(lines[0]).toBe('A         B       ');
    expect(lines[2]).toBe('x         y       ');
  });
});

// ─── formatSize ─────────────────────────────────────────────────

describe('formatSize', () => {
  it('should format bytes below 1024 as "N bytes"', () => {
    expect(formatSize(0)).toBe('0 bytes');
    expect(formatSize(512)).toBe('512 bytes');
    expect(formatSize(1023)).toBe('1023 bytes');
  });

  it('should format bytes in KB range', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10240)).toBe('10.0 KB');
  });

  it('should format bytes in MB range', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(5242880)).toBe('5.0 MB');
  });

  it('should handle boundary value 1024 as KB', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
  });

  it('should handle boundary value 1048576 as MB', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
  });
});

// ─── formatId ───────────────────────────────────────────────────

describe('formatId', () => {
  it('should zero-pad an ID to 8 characters', () => {
    expect(formatId(42)).toBe('00000042');
  });

  it('should handle a large ID without extra padding', () => {
    expect(formatId(12345678)).toBe('12345678');
  });

  it('should handle ID of 0', () => {
    expect(formatId(0)).toBe('00000000');
  });
});

// ─── truncate ───────────────────────────────────────────────────

describe('truncate', () => {
  it('should return the string unchanged when shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should return the string unchanged when exactly at maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should truncate and append "..." when over maxLen', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should handle an empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

// ─── formatKeyValue ─────────────────────────────────────────────

describe('formatKeyValue', () => {
  it('should format with default indent of 3', () => {
    const result = formatKeyValue('Provider', 'github');
    // 3 spaces indent + 'Provider' padEnd(12) + 2 spaces + 'github'
    expect(result).toBe('   Provider      github');
  });

  it('should format with a custom indent', () => {
    const result = formatKeyValue('Key', 'value', 5);
    expect(result).toBe('     Key           value');
  });

  it('should pad labels to 12 characters', () => {
    const result = formatKeyValue('A', 'B');
    // 3 spaces indent + 'A' padded to 12 + 2 spaces + 'B'
    expect(result).toBe('   A             B');
  });
});

// ─── formatMarkdownResult ───────────────────────────────────────

describe('formatMarkdownResult', () => {
  it('should include the header with status emoji', () => {
    const result = formatMarkdownResult(makeResult());
    expect(result).toContain('GHAGGA Code Review');
    expect(result).toContain('PASSED');
  });

  it('should include mode, model, time, and tokens in metadata line', () => {
    const result = formatMarkdownResult(makeResult());
    expect(result).toContain('Mode: simple');
    expect(result).toContain('Model: claude-sonnet-4-20250514');
    expect(result).toContain('Time: 2.0s');
    expect(result).toContain('Tokens: 1000');
  });

  it('should show summary section', () => {
    const result = formatMarkdownResult(makeResult({ summary: 'Looking great!' }));
    expect(result).toContain('## Summary');
    expect(result).toContain('Looking great!');
  });

  it('should show "Nice work!" when there are no findings', () => {
    const result = formatMarkdownResult(makeResult({ findings: [] }));
    expect(result).toContain('No findings. Nice work!');
  });

  it('should group findings by source in render order', () => {
    const result = formatMarkdownResult(
      makeResult({
        findings: [
          {
            severity: 'high',
            category: 'security',
            file: 'a.ts',
            message: 'AI issue',
            source: 'ai',
          },
          {
            severity: 'medium',
            category: 'style',
            file: 'b.ts',
            message: 'Semgrep issue',
            source: 'semgrep',
          },
        ],
      }),
    );
    const semgrepIdx = result.indexOf('Semgrep');
    const aiIdx = result.indexOf('AI Review');
    // Semgrep should appear before AI
    expect(semgrepIdx).toBeLessThan(aiIdx);
  });

  it('should render finding with line number as file:line', () => {
    const result = formatMarkdownResult(
      makeResult({
        findings: [
          {
            severity: 'high',
            category: 'bug',
            file: 'main.ts',
            line: 42,
            message: 'Bug here',
            source: 'ai',
          },
        ],
      }),
    );
    expect(result).toContain('main.ts:42');
  });

  it('should render finding without line number as just file', () => {
    const result = formatMarkdownResult(
      makeResult({
        findings: [
          { severity: 'low', category: 'style', file: 'index.ts', message: 'Minor', source: 'ai' },
        ],
      }),
    );
    expect(result).toContain('index.ts');
    expect(result).not.toContain('index.ts:');
  });

  it('should render suggestion when present', () => {
    const result = formatMarkdownResult(
      makeResult({
        findings: [
          {
            severity: 'medium',
            category: 'perf',
            file: 'x.ts',
            message: 'Slow',
            suggestion: 'Use cache',
            source: 'ai',
          },
        ],
      }),
    );
    expect(result).toContain('Use cache');
  });

  it('should include static analysis summary when tools ran', () => {
    const result = formatMarkdownResult(
      makeResult({
        metadata: {
          mode: 'simple',
          provider: 'gateway',
          model: 'claude-sonnet-4-20250514',
          tokensUsed: 1000,
          executionTimeMs: 2000,
          toolsRun: ['semgrep', 'trivy'],
          toolsSkipped: ['cpd'],
        },
      }),
    );
    expect(result).toContain('## Static Analysis');
    expect(result).toContain('Tools run: semgrep, trivy');
    expect(result).toContain('Tools skipped: cpd');
  });

  it('should omit static analysis section when no tools ran or skipped', () => {
    const result = formatMarkdownResult(makeResult());
    expect(result).not.toContain('## Static Analysis');
  });

  it('should include the footer', () => {
    const result = formatMarkdownResult(makeResult());
    expect(result).toContain('Powered by GHAGGA');
  });

  it('should render FAILED status emoji', () => {
    const result = formatMarkdownResult(makeResult({ status: 'FAILED' }));
    expect(result).toContain('FAILED');
  });
});
