/**
 * Unit tests for schema constants — DEFAULT_REPO_SETTINGS.
 *
 * Pure constant — no mocking needed.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SETTINGS } from './schema.js';

// ─── DEFAULT_REPO_SETTINGS ──────────────────────────────────────

describe('DEFAULT_REPO_SETTINGS', () => {
  it('should have all 9 keys matching RepoSettings interface with correct defaults', () => {
    expect(DEFAULT_REPO_SETTINGS).toEqual({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      enableMemory: true,
      customRules: [],
      ignorePatterns: expect.any(Array),
      reviewLevel: 'normal',
      enabledTools: undefined,
      disabledTools: [],
    });
  });

  it('should have the expected default ignorePatterns', () => {
    expect(DEFAULT_REPO_SETTINGS.ignorePatterns).toEqual([
      '*.md',
      '*.txt',
      '.gitignore',
      'LICENSE',
      '*.lock',
    ]);
  });
});

// ─── Reviews input/output token split (graph-context-retrieval T5.3) ──

import { getTableColumns } from 'drizzle-orm';
import { reviews } from './schema.js';

describe('reviews token split columns', () => {
  it('defines nullable input_tokens / output_tokens with no default (NULL = unmeasured)', () => {
    const cols = getTableColumns(reviews);
    expect(cols.inputTokens?.name).toBe('input_tokens');
    expect(cols.inputTokens?.notNull).toBe(false);
    expect(cols.inputTokens?.hasDefault).toBe(false);
    expect(cols.outputTokens?.name).toBe('output_tokens');
    expect(cols.outputTokens?.notNull).toBe(false);
    expect(cols.outputTokens?.hasDefault).toBe(false);
  });

  it('tokens_used keeps its authoritative default (split columns never replace it)', () => {
    const cols = getTableColumns(reviews);
    expect(cols.tokensUsed?.name).toBe('tokens_used');
    expect(cols.tokensUsed?.hasDefault).toBe(true);
  });
});
