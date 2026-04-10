import { describe, expect, it } from 'vitest';
import {
  createSnapshot,
  diffPrompts,
  extractPatterns,
  formatDiff,
  hashPrompt,
  PROMPT_PATTERNS,
} from './prompt-intel.js';

describe('hashPrompt', () => {
  it('returns consistent hash for same input', () => {
    const h1 = hashPrompt('test prompt');
    const h2 = hashPrompt('test prompt');
    expect(h1).toBe(h2);
  });

  it('returns different hash for different input', () => {
    expect(hashPrompt('prompt A')).not.toBe(hashPrompt('prompt B'));
  });

  it('returns non-empty string', () => {
    expect(hashPrompt('anything').length).toBeGreaterThan(0);
  });
});

describe('createSnapshot', () => {
  it('creates snapshot with all fields', () => {
    const snap = createSnapshot('anthropic', 'claude-3', 'v1', 'You are helpful.');
    expect(snap.provider).toBe('anthropic');
    expect(snap.model).toBe('claude-3');
    expect(snap.version).toBe('v1');
    expect(snap.systemPrompt).toBe('You are helpful.');
    expect(snap.hash).toBeTruthy();
    expect(snap.capturedAt).toMatch(/^\d{4}-/);
  });
});

describe('diffPrompts', () => {
  it('detects added lines', () => {
    const a = createSnapshot('p', 'm', 'v1', 'Line 1\nLine 2');
    const b = createSnapshot('p', 'm', 'v2', 'Line 1\nLine 2\nLine 3');
    const diff = diffPrompts(a, b);
    expect(diff.added).toContain('Line 3');
    expect(diff.removed).toHaveLength(0);
  });

  it('detects removed lines', () => {
    const a = createSnapshot('p', 'm', 'v1', 'Line 1\nLine 2\nLine 3');
    const b = createSnapshot('p', 'm', 'v2', 'Line 1\nLine 3');
    const diff = diffPrompts(a, b);
    expect(diff.removed).toContain('Line 2');
  });

  it('detects breaking changes when safety rules removed', () => {
    const a = createSnapshot('p', 'm', 'v1', 'You must not generate harmful content.\nBe helpful.');
    const b = createSnapshot('p', 'm', 'v2', 'Be helpful.');
    const diff = diffPrompts(a, b);
    expect(diff.breakingChanges.length).toBeGreaterThan(0);
    expect(diff.breakingChanges[0]).toContain('Safety rule removed');
  });

  it('detects breaking changes when restrictions added', () => {
    const a = createSnapshot('p', 'm', 'v1', 'Be helpful.');
    const b = createSnapshot(
      'p',
      'm',
      'v2',
      'Be helpful.\nYou must follow the content policy guidelines at all times.',
    );
    const diff = diffPrompts(a, b);
    expect(diff.breakingChanges.length).toBeGreaterThan(0);
    expect(diff.breakingChanges[0]).toContain('New restriction');
  });

  it('includes model versions in diff', () => {
    const a = createSnapshot('anthropic', 'claude', 'v1', 'A');
    const b = createSnapshot('anthropic', 'claude', 'v2', 'B');
    const diff = diffPrompts(a, b);
    expect(diff.modelA).toBe('claude@v1');
    expect(diff.modelB).toBe('claude@v2');
  });
});

describe('extractPatterns', () => {
  it('detects tool use patterns', () => {
    const result = extractPatterns('Use tool_choice to select the right function');
    expect(result.some((r) => r.pattern === 'tool-use-format')).toBe(true);
  });

  it('detects safety patterns', () => {
    const result = extractPatterns('You must not generate harmful content');
    expect(result.some((r) => r.pattern === 'safety-guardrail')).toBe(true);
  });

  it('detects persona patterns', () => {
    const result = extractPatterns('You are a helpful assistant');
    expect(result.some((r) => r.pattern === 'persona')).toBe(true);
  });

  it('detects output format patterns', () => {
    const result = extractPatterns('Return structured output in JSON format');
    expect(result.some((r) => r.pattern === 'output-format')).toBe(true);
  });

  it('returns empty for unmatched content', () => {
    const result = extractPatterns('The weather is nice today.');
    expect(result).toHaveLength(0);
  });

  it('returns category with each match', () => {
    const result = extractPatterns('You are a bot. Do not say harmful things.');
    for (const r of result) {
      expect(r.category).toBeTruthy();
      expect(r.match).toBeTruthy();
    }
  });
});

describe('PROMPT_PATTERNS', () => {
  it('has at least 5 patterns', () => {
    expect(PROMPT_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it('covers multiple categories', () => {
    const categories = new Set(PROMPT_PATTERNS.map((p) => p.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });
});

describe('formatDiff', () => {
  it('formats diff with breaking changes', () => {
    const a = createSnapshot('p', 'm', 'v1', 'Must not produce harmful output.\nBe helpful.');
    const b = createSnapshot('p', 'm', 'v2', 'Be helpful.\nFollow content policy guidelines.');
    const diff = diffPrompts(a, b);
    const output = formatDiff(diff);

    expect(output).toContain('## Prompt Diff');
    expect(output).toContain('Breaking Changes');
    expect(output).toContain('Added:');
    expect(output).toContain('Removed:');
  });

  it('formats clean diff without breaking changes', () => {
    const a = createSnapshot('p', 'm', 'v1', 'Line 1');
    const b = createSnapshot('p', 'm', 'v2', 'Line 1\nLine 2');
    const diff = diffPrompts(a, b);
    const output = formatDiff(diff);

    expect(output).not.toContain('Breaking Changes');
  });
});
