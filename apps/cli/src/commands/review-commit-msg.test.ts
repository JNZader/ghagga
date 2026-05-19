/**
 * Tests for commit message review (heuristic validation).
 *
 * Validates that reviewCommitMessage() correctly identifies
 * empty, too-short, long subject, trailing period, missing blank line,
 * git comments, and multiple issues. Also verifies quick mode skips AI.
 *
 * @see Phase 4, Test 3
 */

import { describe, expect, it } from 'vitest';
import type { CommitMsgReviewOptions } from './review-commit-msg.js';
import { reviewCommitMessage } from './review-commit-msg.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Default options for tests (quick mode — heuristics only) */
function makeOpts(
  message: string,
  overrides: Partial<CommitMsgReviewOptions> = {},
): CommitMsgReviewOptions {
  return {
    message,
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
    quick: true,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('reviewCommitMessage — heuristic validation', () => {
  it('flags empty message with high severity', async () => {
    const result = await reviewCommitMessage(makeOpts(''));

    expect(result.status).toBe('FAILED');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('high');
    expect(result.findings[0]?.message).toContain('empty');
  });

  it('flags too-short message (≤ 3 chars) with high severity', async () => {
    const result = await reviewCommitMessage(makeOpts('fix'));

    expect(result.status).toBe('FAILED');
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const shortFinding = result.findings.find((f) => f.message.includes('too short'));
    expect(shortFinding).toBeDefined();
    expect(shortFinding?.severity).toBe('high');
  });

  it('flags subject line > 72 chars with medium severity', async () => {
    const longSubject = 'a'.repeat(80);
    const result = await reviewCommitMessage(makeOpts(longSubject));

    const finding = result.findings.find((f) => f.message.includes('72'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('medium');
  });

  it('flags subject ending with period with low severity', async () => {
    const result = await reviewCommitMessage(makeOpts('Add new feature for users.'));

    const finding = result.findings.find((f) => f.message.includes('period'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('low');
  });

  it('flags body not separated by blank line with medium severity', async () => {
    const msg = 'Add feature\nThis is the body without blank line';
    const result = await reviewCommitMessage(makeOpts(msg));

    const finding = result.findings.find((f) => f.message.includes('blank line'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('medium');
  });

  it('returns no findings for a valid conventional commit', async () => {
    const msg = 'feat(auth): add OAuth token refresh support';
    const result = await reviewCommitMessage(makeOpts(msg));

    expect(result.status).toBe('PASSED');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('looks good');
  });

  it('strips git comment lines (# lines) before validation', async () => {
    const msg = [
      'feat: add new feature',
      '',
      '# Please enter the commit message',
      '# Lines starting with # will be ignored.',
    ].join('\n');

    const result = await reviewCommitMessage(makeOpts(msg));

    expect(result.status).toBe('PASSED');
    expect(result.findings).toHaveLength(0);
  });

  it('detects multiple issues simultaneously', async () => {
    // Long subject + ends with period + body without blank line
    const longSubject = `${'a'.repeat(80)}.`;
    const msg = `${longSubject}\nBody without blank separator`;
    const result = await reviewCommitMessage(makeOpts(msg));

    // Should have at least 3 findings: long subject, period, no blank line
    expect(result.findings.length).toBeGreaterThanOrEqual(3);

    const severities = result.findings.map((f) => f.severity);
    expect(severities).toContain('medium'); // long subject or blank line
    expect(severities).toContain('low'); // period
  });

  it('uses "static-only" model in quick mode metadata', async () => {
    const result = await reviewCommitMessage(makeOpts('feat: valid commit', { quick: true }));

    expect(result.metadata.model).toBe('static-only');
    expect(result.metadata.provider).toBe('none');
  });

  it('records actual provider and model when quick is false', async () => {
    const result = await reviewCommitMessage(makeOpts('feat: valid commit', { quick: false }));

    expect(result.metadata.provider).toBe('gateway');
    expect(result.metadata.model).toBe('claude-sonnet-4-20250514');
  });

  it('sets file to COMMIT_EDITMSG in all findings', async () => {
    const result = await reviewCommitMessage(makeOpts(''));

    for (const finding of result.findings) {
      expect(finding.file).toBe('COMMIT_EDITMSG');
    }
  });

  it('skips all static analysis tools', async () => {
    const result = await reviewCommitMessage(makeOpts('feat: valid'));

    expect(result.staticAnalysis?.semgrep.status).toBe('skipped');
    expect(result.staticAnalysis?.trivy.status).toBe('skipped');
    expect(result.staticAnalysis?.cpd.status).toBe('skipped');
  });

  it('returns PASSED status when only low-severity findings exist', async () => {
    const result = await reviewCommitMessage(makeOpts('Add new feature for users.'));

    // Only low severity (period) — should still pass
    const hasCriticalOrHigh = result.findings.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    expect(hasCriticalOrHigh).toBe(false);
    expect(result.status).toBe('PASSED');
  });

  it('includes valid body separated by blank line without findings', async () => {
    const msg = 'feat(core): add caching layer\n\nThis adds Redis-based caching.';
    const result = await reviewCommitMessage(makeOpts(msg));

    expect(result.status).toBe('PASSED');
    expect(result.findings).toHaveLength(0);
  });
});
