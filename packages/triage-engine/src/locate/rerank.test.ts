import type { GenerateTextFn } from 'ghagga-core';
import { describe, expect, it, vi } from 'vitest';
import { firstHitLine, rerankSeed } from './rerank.js';

function mockGenerateFn(text: string): GenerateTextFn {
  return vi.fn().mockResolvedValue({ text, tokensUsed: 0, provider: 'mock', model: 'mock' });
}

describe('firstHitLine', () => {
  it('returns the first line matching a keyword', () => {
    const content = 'line one\nthreshold check here\nline three';
    expect(firstHitLine(content, ['threshold'])).toBe('threshold check here');
  });

  it('falls back to the first function-looking line when no keyword matches', () => {
    const content = 'package x\n\nfunc DoThing() {}\n';
    expect(firstHitLine(content, ['nomatch'])).toBe('func DoThing() {}');
  });

  it('falls back to the first line when nothing matches', () => {
    const content = 'just some text\nmore text';
    expect(firstHitLine(content, ['nomatch'])).toBe('just some text');
  });
});

describe('rerankSeed', () => {
  const issue = { title: 'threshold broken', body: 'the ph threshold is wrong' };
  const files = new Map([
    ['a.go', 'threshold logic'],
    ['b.go', 'unrelated'],
    ['c.go', 'threshold too'],
    ['d.go', 'nothing'],
  ]);
  const pool = ['a.go', 'b.go', 'c.go', 'd.go'];

  it('returns the pool unchanged when pool.length <= 3', async () => {
    const generateFn = mockGenerateFn('1');
    const result = await rerankSeed(issue, ['a.go', 'b.go'], files, ['threshold'], generateFn);
    expect(result).toEqual(['a.go', 'b.go']);
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('parses numeric picks from the model reply', async () => {
    const generateFn = mockGenerateFn('3, 1');
    const result = await rerankSeed(issue, pool, files, ['threshold'], generateFn);
    expect(result).toEqual(['c.go', 'a.go']);
  });

  it('deduplicates and caps at 3 picks', async () => {
    const generateFn = mockGenerateFn('1, 1, 2, 3, 4');
    const result = await rerankSeed(issue, pool, files, ['threshold'], generateFn);
    expect(result).toHaveLength(3);
    expect(result).toEqual(['a.go', 'b.go', 'c.go']);
  });

  it('falls back to top-3 of pool on garbage reply (no parseable numbers)', async () => {
    const generateFn = mockGenerateFn('no idea sorry');
    const result = await rerankSeed(issue, pool, files, ['threshold'], generateFn);
    expect(result).toEqual(['a.go', 'b.go', 'c.go']);
  });

  it('falls back to top-3 of pool when generateFn throws', async () => {
    const generateFn: GenerateTextFn = vi.fn().mockRejectedValue(new Error('cli failed'));
    const result = await rerankSeed(issue, pool, files, ['threshold'], generateFn);
    expect(result).toEqual(['a.go', 'b.go', 'c.go']);
  });

  it('ignores out-of-range indices from the model reply', async () => {
    const generateFn = mockGenerateFn('99, 1');
    const result = await rerankSeed(issue, pool, files, ['threshold'], generateFn);
    expect(result).toEqual(['a.go']);
  });
});
