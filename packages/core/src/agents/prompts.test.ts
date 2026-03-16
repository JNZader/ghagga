import { describe, expect, it } from 'vitest';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  buildStackHints,
  buildStaticAnalysisContext,
  CONSENSUS_FOR_SYSTEM,
  REVIEW_CALIBRATION,
  SIMPLE_REVIEW_SYSTEM,
  WORKFLOW_SCOPE_SYSTEM,
} from './prompts.js';

// ─── buildStaticAnalysisContext ─────────────────────────────────

describe('buildStaticAnalysisContext', () => {
  it('returns empty string for empty input', () => {
    expect(buildStaticAnalysisContext('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    // The function checks `!staticFindings`, so empty string is falsy
    expect(buildStaticAnalysisContext('')).toBe('');
  });

  it('wraps content with newlines when provided', () => {
    const result = buildStaticAnalysisContext('some findings');
    expect(result).toBe('\n\nsome findings\n');
  });

  it('preserves the input content', () => {
    const input = '[SEMGREP] [critical] src/auth.ts:42 - SQL injection';
    const result = buildStaticAnalysisContext(input);
    expect(result).toContain(input);
  });
});

// ─── buildMemoryContext ─────────────────────────────────────────

describe('buildMemoryContext', () => {
  it('returns empty string for null', () => {
    expect(buildMemoryContext(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    // Empty string is falsy, so `!memoryContext` is true
    expect(buildMemoryContext('')).toBe('');
  });

  it('wraps content with header when provided', () => {
    const result = buildMemoryContext('This repo uses strict null checks');
    expect(result).not.toBe('');
    expect(result.length).toBeGreaterThan('This repo uses strict null checks'.length);
  });

  it('includes "Background Context from Past Reviews" section title', () => {
    const result = buildMemoryContext('Some memory context');
    expect(result).toContain('Background Context from Past Reviews');
  });

  it('includes anti-priming instruction for situational awareness only', () => {
    const result = buildMemoryContext('Some memory context');
    expect(result).toContain('situational awareness only');
    expect(result).toContain('Do NOT use them as reasons to flag issues');
  });

  it('requires findings justified from the code diff itself', () => {
    const result = buildMemoryContext('Some memory context');
    expect(result).toContain('from the code diff itself');
  });

  it('does NOT contain old priming language', () => {
    const result = buildMemoryContext('Some memory context');
    expect(result).not.toContain('give more informed');
    expect(result).not.toContain('context-aware reviews');
    expect(result).not.toContain('Past Review Memory');
  });
});

// ─── buildStackHints ────────────────────────────────────────────

describe('buildStackHints', () => {
  it('returns empty string for empty stacks array', () => {
    expect(buildStackHints([])).toBe('');
  });

  it('returns TypeScript hint for ["typescript"]', () => {
    const result = buildStackHints(['typescript']);
    expect(result).toContain('type safety');
    expect(result).toContain('strict null checks');
  });

  it('returns React hint for ["react"]', () => {
    const result = buildStackHints(['react']);
    expect(result).toContain('hooks');
    expect(result).toContain('re-renders');
  });

  it('returns combined hints for multiple stacks', () => {
    const result = buildStackHints(['typescript', 'react']);
    expect(result).toContain('type safety');
    expect(result).toContain('hooks');
  });

  it('returns empty string for unknown stacks only', () => {
    // 'elixir' is not in the hints object, so relevant[] is empty
    expect(buildStackHints(['elixir'])).toBe('');
  });

  it('includes "Stack-Specific Review Hints" header', () => {
    const result = buildStackHints(['python']);
    expect(result).toContain('Stack-Specific Review Hints');
  });

  it('ignores unknown stacks while keeping known ones', () => {
    const result = buildStackHints(['elixir', 'go', 'cobol']);
    expect(result).toContain('error handling patterns');
    expect(result).toContain('goroutine leaks');
  });

  it('handles case-insensitive stack names via toLowerCase', () => {
    const result = buildStackHints(['TypeScript']);
    expect(result).toContain('type safety');
  });
});

// ─── Exported Constants ─────────────────────────────────────────

describe('prompt constants', () => {
  it('SIMPLE_REVIEW_SYSTEM contains STATUS: format instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM).toContain('STATUS:');
  });

  it('WORKFLOW_SCOPE_SYSTEM contains scope-related content', () => {
    expect(WORKFLOW_SCOPE_SYSTEM).toContain('scope');
  });

  it('CONSENSUS_FOR_SYSTEM contains IN FAVOR', () => {
    expect(CONSENSUS_FOR_SYSTEM).toContain('IN FAVOR');
  });
});

// ─── buildReviewLevelInstruction ────────────────────────────────

describe('buildReviewLevelInstruction', () => {
  it('soft level returns 90%+ confidence text', () => {
    const result = buildReviewLevelInstruction('soft');
    expect(result).toContain('90%+');
  });

  it('soft level focuses exclusively on bugs, security, and logic errors', () => {
    const result = buildReviewLevelInstruction('soft');
    expect(result).toContain('bugs');
    expect(result).toContain('security vulnerabilities');
    expect(result).toContain('logic errors');
  });

  it('soft level ignores style, naming, and maintainability', () => {
    const result = buildReviewLevelInstruction('soft');
    expect(result).toContain('Ignore style, naming, and maintainability');
  });

  it('normal level returns 80%+ confidence text', () => {
    const result = buildReviewLevelInstruction('normal');
    expect(result).toContain('80%+');
  });

  it('normal level covers bugs, security, performance, error handling', () => {
    const result = buildReviewLevelInstruction('normal');
    expect(result).toContain('bugs');
    expect(result).toContain('security');
    expect(result).toContain('performance');
    expect(result).toContain('error handling');
  });

  it('normal level is cautious with style-only findings', () => {
    const result = buildReviewLevelInstruction('normal');
    expect(result).toContain('cautious with style-only findings');
  });

  it('strict level returns thorough review text', () => {
    const result = buildReviewLevelInstruction('strict');
    expect(result).toContain('thorough review');
  });

  it('strict level includes style, naming, and documentation', () => {
    const result = buildReviewLevelInstruction('strict');
    expect(result).toContain('style');
    expect(result).toContain('naming');
    expect(result).toContain('documentation');
  });

  it('strict level flags anything that could be improved', () => {
    const result = buildReviewLevelInstruction('strict');
    expect(result).toContain('Flag anything that could be improved');
  });
});

// ─── REVIEW_CALIBRATION ─────────────────────────────────────────

describe('REVIEW_CALIBRATION', () => {
  it('contains 80%+ confidence threshold', () => {
    expect(REVIEW_CALIBRATION).toContain('80%+ confident');
  });

  it('prohibits flagging stylistic preferences without explicit rules', () => {
    expect(REVIEW_CALIBRATION).toContain(
      'Do NOT flag stylistic preferences unless they violate an explicitly provided rule',
    );
  });

  it('prohibits inventing or assuming coding standards', () => {
    expect(REVIEW_CALIBRATION).toContain(
      'Do NOT invent or assume coding standards that are not provided',
    );
  });

  it('prohibits flagging hypothetical edge cases', () => {
    expect(REVIEW_CALIBRATION).toContain(
      'Do NOT flag hypothetical edge cases that are unlikely in practice',
    );
  });

  it('permits STATUS: PASSED with zero findings', () => {
    expect(REVIEW_CALIBRATION).toContain('STATUS: PASSED with zero findings');
  });
});

// ─── Cross-provider compatibility ───────────────────────────────

describe('cross-provider compatibility', () => {
  it('REVIEW_CALIBRATION and buildReviewLevelInstruction output contain no provider-specific syntax', () => {
    const levels = ['soft', 'normal', 'strict'] as const;
    const texts = [REVIEW_CALIBRATION, ...levels.map((l) => buildReviewLevelInstruction(l))];

    for (const text of texts) {
      // No XML tags (Anthropic-style)
      expect(text).not.toMatch(/<\/?[a-zA-Z_][\w.-]*>/);
      // No JSON objects
      expect(text).not.toMatch(/^\s*\{/m);
      // No system role hacks (OpenAI-style)
      expect(text).not.toMatch(/\{"role":/);
    }
  });
});

// ─── SIMPLE_REVIEW_SYSTEM content ───────────────────────────────

describe('SIMPLE_REVIEW_SYSTEM content', () => {
  it('does NOT contain "coding standards and rules"', () => {
    expect(SIMPLE_REVIEW_SYSTEM).not.toContain('coding standards and rules');
  });

  it('still contains bug-checking instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM).toContain('bugs');
  });

  it('still contains error handling instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM.toLowerCase()).toContain('error handling');
  });

  it('still contains code quality instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM.toLowerCase()).toContain('code quality');
  });

  it('still contains security instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM).toContain('security');
  });

  it('still contains performance instruction', () => {
    expect(SIMPLE_REVIEW_SYSTEM).toContain('performance');
  });
});
