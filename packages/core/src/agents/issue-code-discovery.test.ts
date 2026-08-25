import { describe, expect, it } from 'vitest';
import { discoverCodePaths, discoverSearchTerms } from './issue-code-discovery.js';

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

describe('discoverSearchTerms', () => {
  it('is BACKTICK-GATED ONLY — bare prose tokens are ignored', () => {
    expect(discoverSearchTerms('the fetchGraph function is broken')).toEqual([]);
  });

  it('extracts a backtick-quoted identifier, any case', () => {
    expect(discoverSearchTerms('the `fetchGraph` function is broken')).toEqual(['fetchGraph']);
    expect(discoverSearchTerms('see `SEARCH_TERM` and `snake_case` and `foo.bar`')).toEqual([
      'SEARCH_TERM',
      'snake_case',
      'foo.bar',
    ]);
  });

  it('enforces length bounds [3, 64] on each candidate term', () => {
    expect(discoverSearchTerms('`ab` is too short')).toEqual([]);
    const long = 'a'.repeat(65);
    expect(discoverSearchTerms(`\`${long}\` is too long`)).toEqual([]);
    const ok = 'a'.repeat(64);
    expect(discoverSearchTerms(`\`${ok}\` is exactly at the cap`)).toEqual([ok]);
  });

  it('trims trailing punctuation ([._-]+) from a token inside the span', () => {
    expect(discoverSearchTerms('`fetchGraph.` at the end of a sentence')).toEqual(['fetchGraph']);
    expect(discoverSearchTerms('`foo_bar-` trailing dash and underscore')).toEqual(['foo_bar']);
  });

  it('filters TERM_STOP tokens', () => {
    expect(discoverSearchTerms('`const_cast` and `static_cast` are noise')).toEqual([]);
  });

  it('dedupes case-insensitively, keeping first-appearance casing', () => {
    expect(discoverSearchTerms('`fetchGraph` then `FETCHGRAPH` then `fetchgraph`')).toEqual([
      'fetchGraph',
    ]);
  });

  it('honors the limit (default 5)', () => {
    const text = Array.from({ length: 8 }, (_, i) => `\`term${i}\``).join(' ');
    expect(discoverSearchTerms(text)).toEqual(['term0', 'term1', 'term2', 'term3', 'term4']);
    expect(discoverSearchTerms(text, { limit: 2 })).toEqual(['term0', 'term1']);
  });

  it('returns [] for empty/non-string input', () => {
    expect(discoverSearchTerms('')).toEqual([]);
    // @ts-expect-error — defense-in-depth for untyped JS callers
    expect(discoverSearchTerms(null)).toEqual([]);
  });

  it('skips an over-long backtick span (ReDoS belt) and stays linear', () => {
    const hugeSpan = 'a'.repeat(500); // exceeds MAX_TOKEN
    const text = `\`${hugeSpan}\` and \`realTerm\``;
    const start = Date.now();
    expect(discoverSearchTerms(text)).toEqual(['realTerm']);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('bounds a 262KB adversarial blob and stays fast', () => {
    const blob = '`realTerm` ' + `\`${'x'.repeat(300_000)}\` `.repeat(5);
    const start = Date.now();
    const out = discoverSearchTerms(blob);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toContain('realTerm');
  });

  it('CHARSET-SYNC PROPERTY: every emitted term matches the SEARCH_TERM charset regardless of adversarial span content', () => {
    const spans = [
      '`a$b`',
      '`foo()`',
      '`x;y`',
      '`repo:evil/x`',
      '`fóo_bar`',
      '`日本語term`',
      '`a b c`',
      '`--flag--value--`',
      '`a.b.c-d_e`',
    ];
    const out = discoverSearchTerms(spans.join(' '), { limit: 100 });
    for (const term of out) {
      expect(term).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
  });
});
