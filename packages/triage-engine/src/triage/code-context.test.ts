import { describe, expect, it } from 'vitest';
import { buildCodeContext } from './code-context.js';

describe('buildCodeContext', () => {
  it('returns empty string when there are no context files', () => {
    expect(buildCodeContext([], new Map(), ['threshold'])).toBe('');
  });

  it('renders a fenced section per context file with its relative path as a heading', () => {
    const files = new Map([
      [
        'internal/alerts/threshold.go',
        'package alerts\n\nfunc CheckThreshold() bool { return true }\n',
      ],
    ]);
    const result = buildCodeContext(['internal/alerts/threshold.go'], files, ['threshold']);

    expect(result).toContain('### internal/alerts/threshold.go');
    expect(result).toContain('```');
    expect(result).toContain('CheckThreshold');
  });

  it('renders one section per file, in the given order', () => {
    const files = new Map([
      ['a.go', 'package a\nfunc A() {}\n'],
      ['b.go', 'package b\nfunc B() {}\n'],
    ]);
    const result = buildCodeContext(['a.go', 'b.go'], files, []);
    const aIdx = result.indexOf('### a.go');
    const bIdx = result.indexOf('### b.go');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it('centers the snippet window on the first keyword hit, not always line 1', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[80] = 'the threshold value lives here';
    const files = new Map([['big.go', lines.join('\n')]]);

    const result = buildCodeContext(['big.go'], files, ['threshold'], 40);
    expect(result).toContain('the threshold value lives here');
    // Window is bounded (not the entire 100-line file).
    expect(result).not.toContain('line 0\n');
  });

  it('falls back gracefully when a listed file is missing from the files map', () => {
    const result = buildCodeContext(['missing.go'], new Map(), ['x']);
    expect(result).toContain('### missing.go');
  });

  it('numbers snippet lines starting from the windowed offset, not always 1', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    lines[30] = 'threshold hit here';
    const files = new Map([['f.go', lines.join('\n')]]);
    const result = buildCodeContext(['f.go'], files, ['threshold'], 20);
    // The window starts a few lines before the hit (start = hit - 6 = 24), so
    // line numbering should NOT start at "1:".
    expect(result).not.toMatch(/```\n1: /);
  });
});
