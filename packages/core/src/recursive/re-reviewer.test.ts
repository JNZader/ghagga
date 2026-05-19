import { describe, expect, it } from 'vitest';
import type { GenerateTextFn } from '../providers/generate-fn.js';
import { runReReview } from './re-reviewer.js';

// ─── Mock GenerateTextFn ───────────────────────────────────────

function createMockGenerateFn(responseText: string): GenerateTextFn {
  return async (_system: string, _prompt: string) => ({
    text: responseText,
    tokensUsed: 100,
    provider: 'gateway',
    model: 'gpt-4o-mini',
  });
}

function createFailingGenerateFn(): GenerateTextFn {
  return async () => {
    throw new Error('LLM call failed');
  };
}

// ─── runReReview ───────────────────────────────────────────────

describe('runReReview', () => {
  it('returns findings from re-review response', async () => {
    const response = `STATUS: FAILED
SUMMARY: The suggestion introduces a new bug.
FINDINGS:
- SEVERITY: high
  CATEGORY: bug
  FILE: src/auth.ts
  LINE: 42
  MESSAGE: Parameterized query has wrong parameter count
  SUGGESTION: Add the missing parameter`;

    const result = await runReReview({
      patchedDiff: 'some diff',
      patchContext: 'some context',
      generateFn: createMockGenerateFn(response),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.source).toBe('recursive-review');
    expect(result.findings[0]?.severity).toBe('high');
    expect(result.findings[0]?.file).toBe('src/auth.ts');
    expect(result.tokensUsed).toBe(100);
  });

  it('returns empty findings when re-review passes', async () => {
    const response = `STATUS: PASSED
SUMMARY: Suggestions look good, no new issues introduced.
FINDINGS:
`;

    const result = await runReReview({
      patchedDiff: 'some diff',
      patchContext: 'some context',
      generateFn: createMockGenerateFn(response),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.tokensUsed).toBe(100);
  });

  it('returns empty findings on LLM failure', async () => {
    const result = await runReReview({
      patchedDiff: 'some diff',
      patchContext: 'some context',
      generateFn: createFailingGenerateFn(),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.tokensUsed).toBe(0);
  });

  it('marks all findings with recursive-review source', async () => {
    const response = `STATUS: FAILED
SUMMARY: Multiple issues.
FINDINGS:
- SEVERITY: medium
  CATEGORY: performance
  FILE: src/api.ts
  LINE: 10
  MESSAGE: Inefficient loop
  SUGGESTION: Use map instead
- SEVERITY: low
  CATEGORY: style
  FILE: src/api.ts
  LINE: 20
  MESSAGE: Naming convention
  SUGGESTION: Rename variable`;

    const result = await runReReview({
      patchedDiff: 'some diff',
      patchContext: 'some context',
      generateFn: createMockGenerateFn(response),
    });

    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding.source).toBe('recursive-review');
    }
  });
});
