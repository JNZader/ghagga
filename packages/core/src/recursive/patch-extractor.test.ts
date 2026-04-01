import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../types.js';
import { applyVirtualPatches, buildPatchContext, extractPatches } from './patch-extractor.js';

// ─── extractPatches ────────────────────────────────────────────

describe('extractPatches', () => {
  it('extracts patches from findings with suggestions', () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'high',
        category: 'security',
        file: 'src/auth.ts',
        line: 42,
        message: 'SQL injection vulnerability',
        suggestion: 'Use parameterized queries',
        source: 'ai',
      },
      {
        severity: 'medium',
        category: 'style',
        file: 'src/utils.ts',
        line: 10,
        message: 'Magic number',
        source: 'ai',
        // no suggestion
      },
      {
        severity: 'low',
        category: 'performance',
        file: 'src/api.ts',
        line: 88,
        message: 'N+1 query',
        suggestion: 'Batch the queries',
        source: 'ai',
      },
    ];

    const patches = extractPatches(findings);

    expect(patches).toHaveLength(2);
    expect(patches[0]).toEqual({
      file: 'src/auth.ts',
      line: 42,
      originalMessage: 'SQL injection vulnerability',
      suggestion: 'Use parameterized queries',
      findingIndex: 0,
    });
    expect(patches[1]).toEqual({
      file: 'src/api.ts',
      line: 88,
      originalMessage: 'N+1 query',
      suggestion: 'Batch the queries',
      findingIndex: 2,
    });
  });

  it('returns empty array when no findings have suggestions', () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'info',
        category: 'style',
        file: 'src/index.ts',
        message: 'Consider adding types',
        source: 'ai',
      },
    ];

    expect(extractPatches(findings)).toEqual([]);
  });

  it('returns empty array for empty findings', () => {
    expect(extractPatches([])).toEqual([]);
  });

  it('skips findings without a file path', () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'medium',
        category: 'bug',
        file: '',
        message: 'Something is wrong',
        suggestion: 'Fix it',
        source: 'ai',
      },
    ];

    expect(extractPatches(findings)).toEqual([]);
  });

  it('skips findings with whitespace-only suggestions', () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'medium',
        category: 'bug',
        file: 'src/app.ts',
        line: 5,
        message: 'Issue found',
        suggestion: '   ',
        source: 'ai',
      },
    ];

    expect(extractPatches(findings)).toEqual([]);
  });

  it('includes findings without line numbers as file-level patches', () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'medium',
        category: 'maintainability',
        file: 'src/config.ts',
        message: 'Consider extracting constants',
        suggestion: 'Create a constants.ts module',
        source: 'ai',
      },
    ];

    const patches = extractPatches(findings);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.line).toBeUndefined();
  });
});

// ─── applyVirtualPatches ───────────────────────────────────────

describe('applyVirtualPatches', () => {
  const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,6 +40,8 @@ function authenticate(user: string) {
   const token = getToken();
+  const query = "SELECT * FROM users WHERE name = '" + user + "'";
+  const result = db.execute(query);
   return result;
 }`;

  it('inserts suggestion markers after matching lines', () => {
    const patches = [
      {
        file: 'src/auth.ts',
        line: 42,
        originalMessage: 'SQL injection',
        suggestion:
          'Use parameterized queries: db.execute("SELECT * FROM users WHERE name = ?", [user])',
        findingIndex: 0,
      },
    ];

    const result = applyVirtualPatches(sampleDiff, patches);
    expect(result).toContain('[SUGGESTED FIX]');
    expect(result).toContain('Use parameterized queries');
  });

  it('returns original diff when no patches', () => {
    const result = applyVirtualPatches(sampleDiff, []);
    expect(result).toBe(sampleDiff);
  });

  it('handles multiple patches for different files', () => {
    const multiFileDiff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added_line_a
 line3
diff --git a/src/b.ts b/src/b.ts
index 1234567..abcdefg 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,4 @@
 line1
+added_line_b
 line3`;

    const patches = [
      {
        file: 'src/a.ts',
        line: 2,
        originalMessage: 'issue in a',
        suggestion: 'fix a',
        findingIndex: 0,
      },
      {
        file: 'src/b.ts',
        line: 2,
        originalMessage: 'issue in b',
        suggestion: 'fix b',
        findingIndex: 1,
      },
    ];

    const result = applyVirtualPatches(multiFileDiff, patches);
    expect(result).toContain('+[SUGGESTED FIX] fix a');
    expect(result).toContain('+[SUGGESTED FIX] fix b');
  });
});

// ─── buildPatchContext ─────────────────────────────────────────

describe('buildPatchContext', () => {
  it('builds context string from patches', () => {
    const patches = [
      {
        file: 'src/auth.ts',
        line: 42,
        originalMessage: 'SQL injection',
        suggestion: 'Use parameterized queries',
        findingIndex: 0,
      },
    ];

    const context = buildPatchContext(patches);
    expect(context).toContain('src/auth.ts:42');
    expect(context).toContain('Use parameterized queries');
    expect(context).toContain('SQL injection');
  });

  it('returns empty string for no patches', () => {
    expect(buildPatchContext([])).toBe('');
  });

  it('handles file-level patches without line numbers', () => {
    const patches = [
      {
        file: 'src/config.ts',
        line: undefined,
        originalMessage: 'Extract constants',
        suggestion: 'Create constants module',
        findingIndex: 0,
      },
    ];

    const context = buildPatchContext(patches);
    expect(context).toContain('src/config.ts');
    expect(context).not.toContain('undefined');
  });
});
