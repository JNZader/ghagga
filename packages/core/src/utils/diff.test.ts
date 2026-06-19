import { describe, expect, it } from 'vitest';
import { filterIgnoredFiles, parseDiffFiles, truncateDiff } from './diff.js';

// ─── parseDiffFiles ─────────────────────────────────────────────

describe('parseDiffFiles', () => {
  it('parses a single file diff correctly', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      " import { foo } from './foo';",
      "+import { bar } from './bar';",
      ' ',
      ' export function main() {',
      '-  return foo();',
      '+  return bar(foo());',
      ' }',
    ].join('\n');

    const files = parseDiffFiles(diff);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/index.ts');
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.content).toContain('diff --git');
    expect(files[0]?.content).toContain("+import { bar } from './bar';");
  });

  it('parses multiple files in one diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' export { x };',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-const old = true;',
      '+const updated = true;',
    ].join('\n');

    const files = parseDiffFiles(diff);

    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe('src/a.ts');
    expect(files[1]?.path).toBe('src/b.ts');
  });

  it('counts additions and deletions correctly (ignores +++ and --- header lines)', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,4 +1,4 @@',
      ' line1',
      '-removed1',
      '-removed2',
      '+added1',
      '+added2',
      '+added3',
      ' line4',
    ].join('\n');

    const files = parseDiffFiles(diff);

    expect(files).toHaveLength(1);
    // +++ should NOT be counted; only real additions: added1, added2, added3
    expect(files[0]?.additions).toBe(3);
    // --- should NOT be counted; only real deletions: removed1, removed2
    expect(files[0]?.deletions).toBe(2);
  });

  it('returns empty array for empty string', () => {
    expect(parseDiffFiles('')).toEqual([]);
  });

  it('returns empty array for non-diff content', () => {
    const text = 'This is just some plain text\nwith multiple lines\nbut no diff headers.';
    expect(parseDiffFiles(text)).toEqual([]);
  });
});

// ─── filterIgnoredFiles ─────────────────────────────────────────

describe('filterIgnoredFiles', () => {
  const makeFile = (path: string) => ({
    path,
    additions: 1,
    deletions: 0,
    content: `diff for ${path}`,
  });

  it('keeps files that do not match any pattern', () => {
    const files = [makeFile('src/index.ts'), makeFile('src/utils.ts')];
    const result = filterIgnoredFiles(files, ['*.md']);
    expect(result).toHaveLength(2);
  });

  it('filters out files matching *.md pattern', () => {
    const files = [makeFile('src/index.ts'), makeFile('README.md')];
    const result = filterIgnoredFiles(files, ['*.md']);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/index.ts');
  });

  it('filters out files matching *.lock pattern', () => {
    const files = [
      makeFile('src/app.ts'),
      makeFile('pnpm-lock.yaml'),
      makeFile('package-lock.json'),
    ];
    // *.lock won't match pnpm-lock.yaml; need to use the right pattern
    const result = filterIgnoredFiles(files, ['*.lock']);
    // pnpm-lock.yaml and package-lock.json don't end in .lock, so they're kept
    expect(result).toHaveLength(3);

    // Now test with an actual .lock file
    const files2 = [makeFile('src/app.ts'), makeFile('yarn.lock')];
    const result2 = filterIgnoredFiles(files2, ['*.lock']);
    expect(result2).toHaveLength(1);
    expect(result2[0]?.path).toBe('src/app.ts');
  });

  it('supports ** glob patterns', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('dist/index.js'),
      makeFile('dist/utils/helper.js'),
    ];
    const result = filterIgnoredFiles(files, ['dist/**']);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/index.ts');
  });

  it('returns all files when patterns array is empty', () => {
    const files = [makeFile('a.md'), makeFile('b.lock'), makeFile('c.ts')];
    const result = filterIgnoredFiles(files, []);
    expect(result).toHaveLength(3);
  });

  it('handles multiple patterns simultaneously', () => {
    const files = [
      makeFile('src/index.ts'),
      makeFile('README.md'),
      makeFile('CHANGELOG.md'),
      makeFile('yarn.lock'),
      makeFile('dist/bundle.js'),
    ];
    const result = filterIgnoredFiles(files, ['*.md', '*.lock', 'dist/**']);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/index.ts');
  });

  it('filters based on basename matching for ** patterns', () => {
    const files = [makeFile('src/utils/diff.test.ts'), makeFile('src/index.ts')];
    const result = filterIgnoredFiles(files, ['**/*.test.ts']);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/index.ts');
  });
});

// ─── truncateDiff ───────────────────────────────────────────────

describe('truncateDiff', () => {
  it('returns original diff unchanged when within budget', () => {
    const diff = 'short diff content';
    // 1 token ≈ 4 chars; 100 tokens = 400 chars. "short diff content" is well under.
    const result = truncateDiff(diff, 100);
    expect(result.truncated).toBe(diff);
    expect(result.wasTruncated).toBe(false);
  });

  it('truncates long diff at line boundaries', () => {
    // Create a diff with multiple lines
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`);
    const diff = lines.join('\n');
    // Give a small budget to force truncation
    const result = truncateDiff(diff, 50); // 50 tokens = 200 chars
    // Should end at a line boundary (no partial lines)
    expect(result.truncated).not.toMatch(/line \d+: x+[^x\n]/);
    expect(result.wasTruncated).toBe(true);
  });

  it('sets wasTruncated flag correctly', () => {
    const shortDiff = 'abc';
    expect(truncateDiff(shortDiff, 100).wasTruncated).toBe(false);

    const longDiff = 'a'.repeat(1000);
    expect(truncateDiff(longDiff, 10).wasTruncated).toBe(true);
  });

  it('appends truncation notice', () => {
    const longDiff = 'a'.repeat(1000);
    const result = truncateDiff(longDiff, 10); // 10 tokens = 40 chars
    expect(result.truncated).toContain('[... diff truncated to fit token budget ...]');
  });

  it('handles very small budget', () => {
    const diff = 'line1\nline2\nline3';
    // 0 tokens = 0 chars
    const result0 = truncateDiff(diff, 0);
    expect(result0.wasTruncated).toBe(true);
    expect(result0.truncated).toContain('[... diff truncated to fit token budget ...]');

    // 1 token = 4 chars
    const result1 = truncateDiff(diff, 1);
    expect(result1.wasTruncated).toBe(true);
    expect(result1.truncated).toContain('[... diff truncated to fit token budget ...]');
  });

  // ── Mutant killers ──

  it('uses 4 chars per token for budget calculation (kills * → / mutant)', () => {
    // 10 tokens = 40 chars. A 41-char string should be truncated.
    const diff = 'a'.repeat(41);
    const result = truncateDiff(diff, 10);
    expect(result.wasTruncated).toBe(true);

    // 10 tokens = 40 chars. A 40-char string should NOT be truncated.
    const diff2 = 'a'.repeat(40);
    const result2 = truncateDiff(diff2, 10);
    expect(result2.wasTruncated).toBe(false);
  });

  it('does not truncate when diff.length equals maxChars exactly (kills <= to < mutant)', () => {
    // 5 tokens = 20 chars exactly
    const diff = 'a'.repeat(20);
    const result = truncateDiff(diff, 5);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(diff);
  });

  it('cuts at newline boundary, not mid-line (kills cutoff > 0 branch mutants)', () => {
    // Build a diff where a newline exists before maxChars
    const diff = 'first line\nsecond line that is much longer than the budget allows';
    // 5 tokens = 20 chars. lastIndexOf('\n', 20) will find the \n at position 10
    const result = truncateDiff(diff, 5);
    expect(result.wasTruncated).toBe(true);
    // The truncated content should end at the newline (position 10 → "first line")
    expect(result.truncated).toContain('first line');
    expect(result.truncated).not.toContain('second line');
  });

  it('falls back to maxChars when no newline exists before cutoff (kills else branch)', () => {
    // A single long line with no newline characters
    const diff = 'x'.repeat(100);
    // 5 tokens = 20 chars. lastIndexOf('\n', 20) returns -1, so cutoff <= 0
    const result = truncateDiff(diff, 5);
    expect(result.wasTruncated).toBe(true);
    // Should use maxChars (20) as the cutoff point
    const mainContent = result.truncated.split('\n\n[...')[0]!;
    expect(mainContent.length).toBe(20);
  });

  it('joins content lines with newlines in parsed files (kills join separator mutant)', () => {
    const diff = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' export { x };',
    ].join('\n');

    const files = parseDiffFiles(diff);
    // Content should contain newlines between lines, not be concatenated
    expect(files[0]?.content).toContain('\n');
    expect(files[0]?.content.split('\n').length).toBe(7);
  });
});

// ─── parseDiffFiles (mutant killers) ────────────────────────────

describe('parseDiffFiles (mutant killers)', () => {
  it('initializes content as empty before accumulating lines (kills initial content mutant)', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+const x = 1;',
      '+export { x };',
    ].join('\n');

    const files = parseDiffFiles(diff);
    // The content should start with the diff header, not random content
    expect(files[0]?.content).toMatch(/^diff --git/);
  });

  it('only collects lines when inside a file block (kills else if currentFile mutant)', () => {
    // Lines before the first diff header should be ignored
    const diff = [
      'This is some preamble text',
      'that should be ignored',
      'diff --git a/src/a.ts b/src/a.ts',
      '+added line',
    ].join('\n');

    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).not.toContain('preamble');
  });

  it('requires end-of-line anchor in file header regex (kills $ removal mutant)', () => {
    // Without $, the regex could match a line that has extra content after the path
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1 +1 @@', '+hello'].join('\n');

    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
  });

  it('requires start-of-line anchor in file header regex (kills ^ removal mutant)', () => {
    // Without ^, the regex could match mid-line content
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+some content with diff --git a/fake b/fake inside it',
      '+normal line',
    ].join('\n');

    const files = parseDiffFiles(diff);
    // Without ^, the embedded "diff --git" would match and split the file.
    // With ^, it only matches at start of line, so we get 1 file.
    expect(files).toHaveLength(1);
    expect(files[0]?.additions).toBe(2);
  });

  it('parses multiple files and verifies content separation', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+line in a',
      'diff --git a/src/b.ts b/src/b.ts',
      '+line in b',
    ].join('\n');

    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(2);
    expect(files[0]?.content).toContain('line in a');
    expect(files[0]?.content).not.toContain('line in b');
    expect(files[1]?.content).toContain('line in b');
    expect(files[1]?.content).not.toContain('line in a');
  });
});

// ─── filterIgnoredFiles (mutant killers) ─────────────────────────

describe('filterIgnoredFiles (mutant killers)', () => {
  const makeFile = (path: string) => ({
    path,
    additions: 1,
    deletions: 0,
    content: `diff for ${path}`,
  });

  it('returns same reference for empty patterns (kills early return mutant)', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const result = filterIgnoredFiles(files, []);
    expect(result).toBe(files); // Same reference, not a copy
  });

  it('filters dotfiles when dot option is true (kills dot: false mutant)', () => {
    const files = [makeFile('.env'), makeFile('src/app.ts')];
    const result = filterIgnoredFiles(files, ['.*']); // .* matches dotfiles
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('src/app.ts');
  });
});
