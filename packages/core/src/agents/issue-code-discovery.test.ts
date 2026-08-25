import { describe, expect, it } from 'vitest';
import { discoverCodePaths } from './issue-code-discovery.js';

describe('discoverCodePaths', () => {
  it('extracts a path-shaped token (dir/file.ext)', () => {
    expect(discoverCodePaths('The bug is in src/retry.ts somewhere.')).toEqual(['src/retry.ts']);
  });

  it('strips surrounding markdown/quote/punctuation without touching the interior', () => {
    const text = 'see `src/a.ts`, (src/b.ts) and "src/c.ts". Also src/d.ts.';
    expect(discoverCodePaths(text)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('requires BOTH a slash and an extension (rejects bare filenames and bare dirs)', () => {
    expect(discoverCodePaths('retry.ts is the file in the src directory')).toEqual([]);
    expect(discoverCodePaths('look in src/utils for it')).toEqual([]);
  });

  it('rejects URLs wholesale (no path fished out of a link)', () => {
    expect(discoverCodePaths('docs at https://example.com/a/b.ts explain it')).toEqual([]);
  });

  it('rejects absolute paths and `.`/`..` traversal', () => {
    expect(discoverCodePaths('/etc/passwd.txt is absolute')).toEqual([]);
    expect(discoverCodePaths('../../secret/key.pem and a/../b/c.ts')).toEqual([]);
  });

  it('dedupes (first-appearance order) and honors the limit', () => {
    expect(discoverCodePaths('src/a.ts then src/a.ts again then src/b.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`).join(' ');
    expect(discoverCodePaths(many, { limit: 3 })).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts']);
  });

  it('returns [] for empty/non-string/limit<=0 input', () => {
    expect(discoverCodePaths('')).toEqual([]);
    expect(discoverCodePaths('src/a.ts', { limit: 0 })).toEqual([]);
    // @ts-expect-error — defense-in-depth for untyped JS callers
    expect(discoverCodePaths(null)).toEqual([]);
  });

  it('skips an over-long no-whitespace blob (ReDoS belt) and stays linear', () => {
    const blob = `${'a/'.repeat(5000)}b.ts`; // one 10k+ token, no whitespace
    const start = Date.now();
    expect(discoverCodePaths(`prefix ${blob} src/real.ts`)).toEqual(['src/real.ts']);
    expect(Date.now() - start).toBeLessThan(1000); // linear, not quadratic
  });

  it('handles nested paths and mixed extensions', () => {
    expect(discoverCodePaths('packages/core/src/agents/issue-triage.ts and a/b/c/d.tsx')).toEqual([
      'packages/core/src/agents/issue-triage.ts',
      'a/b/c/d.tsx',
    ]);
  });
});
