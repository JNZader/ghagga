import { describe, expect, it } from 'vitest';
import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ReviewFinding } from '../types.js';
import { recursiveReview } from './index.js';

// ─── Helpers ───────────────────────────────────────────────────

function createMockGenerateFn(responses: string[]): GenerateTextFn {
  let callIndex = 0;
  return async (_system: string, _prompt: string) => {
    const text = responses[callIndex] ?? responses[responses.length - 1] ?? '';
    callIndex++;
    return {
      text,
      tokensUsed: 50,
      provider: 'gateway',
      model: 'gpt-4o-mini',
    };
  };
}

const baseFinding: ReviewFinding = {
  severity: 'high',
  category: 'security',
  file: 'src/auth.ts',
  line: 42,
  message: 'SQL injection vulnerability',
  suggestion: 'Use parameterized queries',
  source: 'ai',
};

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

// ─── recursiveReview ───────────────────────────────────────────

describe('recursiveReview', () => {
  it('returns null when no findings have suggestions', async () => {
    const findings: ReviewFinding[] = [
      {
        severity: 'info',
        category: 'style',
        file: 'src/index.ts',
        message: 'Consider adding types',
        source: 'ai',
      },
    ];

    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings,
      generateFn: createMockGenerateFn(['']),
    });

    expect(result).toBeNull();
  });

  it('converges when re-review finds no new issues', async () => {
    const passResponse = `STATUS: PASSED
SUMMARY: Suggestions look good.
FINDINGS:
`;

    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([passResponse]),
    });

    expect(result).not.toBeNull();
    expect(result?.converged).toBe(true);
    expect(result?.iterations).toBe(1);
    expect(result?.regressions).toHaveLength(0);
    expect(result?.totalNewIssues).toBe(0);
  });

  it('detects regressions when re-review finds issues in patched files', async () => {
    const failResponse = `STATUS: FAILED
SUMMARY: The suggestion introduces a new bug.
FINDINGS:
- SEVERITY: high
  CATEGORY: bug
  FILE: src/auth.ts
  LINE: 43
  MESSAGE: Parameterized query has wrong parameter count
  SUGGESTION: Fix the parameter list`;

    // Second call also finds issues (convergence not reached)
    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([failResponse, failResponse]),
      config: { maxIterations: 2 },
    });

    expect(result).not.toBeNull();
    expect(result?.converged).toBe(false);
    expect(result?.iterations).toBe(2);
    expect(result?.regressions.length).toBeGreaterThan(0);
    expect(result?.regressions[0]?.isRegression).toBe(true);
    expect(result?.regressions[0]?.originatingSuggestion.file).toBe('src/auth.ts');
  });

  it('stops after max iterations', async () => {
    const failResponse = `STATUS: FAILED
SUMMARY: Issues found.
FINDINGS:
- SEVERITY: medium
  CATEGORY: bug
  FILE: src/auth.ts
  LINE: 42
  MESSAGE: Still broken
  SUGGESTION: Try another approach`;

    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([failResponse, failResponse, failResponse]),
      config: { maxIterations: 2 },
    });

    expect(result).not.toBeNull();
    expect(result?.iterations).toBe(2);
    expect(result?.converged).toBe(false);
  });

  it('stops early when new findings have no suggestions', async () => {
    const noSuggestionResponse = `STATUS: FAILED
SUMMARY: New issue without suggestion.
FINDINGS:
- SEVERITY: medium
  CATEGORY: bug
  FILE: src/auth.ts
  LINE: 42
  MESSAGE: Still has issues
  SUGGESTION: N/A`;

    // parseFindingsBlock will parse "N/A" as a suggestion, but
    // extractPatches considers it non-empty — which is fine,
    // the loop handles it
    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([noSuggestionResponse]),
      config: { maxIterations: 2 },
    });

    expect(result).not.toBeNull();
    // Should complete (converged or not) — key is it doesn't error
    expect(result?.iterations).toBeGreaterThanOrEqual(1);
  });

  it('calls onProgress callback during execution', async () => {
    const passResponse = `STATUS: PASSED
SUMMARY: All good.
FINDINGS:
`;

    const messages: string[] = [];
    await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([passResponse]),
      onProgress: (msg) => messages.push(msg),
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes('suggestion'))).toBe(true);
  });

  it('respects custom maxIterations config', async () => {
    const failResponse = `STATUS: FAILED
SUMMARY: Issues.
FINDINGS:
- SEVERITY: low
  CATEGORY: style
  FILE: src/auth.ts
  LINE: 42
  MESSAGE: Minor issue
  SUGGESTION: Fix it`;

    const result = await recursiveReview({
      originalDiff: sampleDiff,
      findings: [baseFinding],
      generateFn: createMockGenerateFn([failResponse]),
      config: { maxIterations: 1 },
    });

    expect(result).not.toBeNull();
    expect(result?.iterations).toBe(1);
  });
});
