import { describe, expect, it } from 'vitest';
import { parseHypotheses } from './diagnostic.js';

// ─── parseHypotheses ────────────────────────────────────────────

describe('parseHypotheses', () => {
  // ── Basic parsing ─────────────────────────────────────────────

  it('parses a single hypothesis with all fields', () => {
    const text = [
      'STATUS: NEEDS_HUMAN_REVIEW',
      'SUMMARY: Found 1 potential issue.',
      '',
      'HYPOTHESIS H1: Race condition in auth token refresh',
      'CONDITIONS: When two concurrent requests trigger token refresh simultaneously, the second may use an invalidated token.',
      'VERIFICATION: Write a test that fires two authenticated requests with an expired token within 50ms. Check if both succeed or if one gets a 401.',
      'CONFIDENCE: high',
      'FILES: src/auth/refresh.ts, src/middleware/auth.ts',
      '',
      'FINDINGS:',
      '- SEVERITY: high',
      '  CATEGORY: bug',
      '  FILE: src/auth/refresh.ts',
      '  LINE: 45',
      '  MESSAGE: H1: Race condition in concurrent token refresh',
      '  SUGGESTION: Use a mutex or deduplication for concurrent refresh calls',
    ].join('\n');

    const hypotheses = parseHypotheses(text);

    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]).toEqual({
      id: 'H1',
      title: 'Race condition in auth token refresh',
      conditions:
        'When two concurrent requests trigger token refresh simultaneously, the second may use an invalidated token.',
      verification:
        'Write a test that fires two authenticated requests with an expired token within 50ms. Check if both succeed or if one gets a 401.',
      confidence: 'high',
      relatedFiles: ['src/auth/refresh.ts', 'src/middleware/auth.ts'],
    });
  });

  it('parses multiple hypotheses', () => {
    const text = [
      'STATUS: NEEDS_HUMAN_REVIEW',
      'SUMMARY: Found 3 potential issues.',
      '',
      'HYPOTHESIS H1: Race condition in auth token refresh',
      'CONDITIONS: Concurrent token refresh can invalidate tokens.',
      'VERIFICATION: Fire two auth requests within 50ms.',
      'CONFIDENCE: high',
      'FILES: src/auth/refresh.ts',
      '',
      'HYPOTHESIS H2: Missing null check on config value',
      'CONDITIONS: config.retryDelay is undefined when not set in .env.',
      'VERIFICATION: Remove RETRY_DELAY from .env and trigger a failing request.',
      'CONFIDENCE: medium',
      'FILES: src/utils/retry.ts',
      '',
      'HYPOTHESIS H3: Potential memory leak in event listener',
      'CONDITIONS: Event listener is added on mount but never removed.',
      'VERIFICATION: Mount and unmount the component 100 times and check heap.',
      'CONFIDENCE: low',
      'FILES: src/components/Dashboard.tsx',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);

    expect(hypotheses).toHaveLength(3);
    expect(hypotheses[0]?.id).toBe('H1');
    expect(hypotheses[0]?.confidence).toBe('high');
    expect(hypotheses[1]?.id).toBe('H2');
    expect(hypotheses[1]?.confidence).toBe('medium');
    expect(hypotheses[2]?.id).toBe('H3');
    expect(hypotheses[2]?.confidence).toBe('low');
  });

  it('returns empty array when no hypotheses are present', () => {
    const text = [
      'STATUS: PASSED',
      'SUMMARY: No issues found. The code looks clean.',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseHypotheses('')).toEqual([]);
  });

  it('returns empty array for random text without hypothesis format', () => {
    const text = 'Just some random text without any structured output at all.';
    expect(parseHypotheses(text)).toEqual([]);
  });

  // ── Confidence parsing ────────────────────────────────────────

  it('parses high confidence correctly', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: When something fails.',
      'VERIFICATION: Run the test.',
      'CONFIDENCE: high',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('high');
  });

  it('parses medium confidence correctly', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: When something fails.',
      'VERIFICATION: Run the test.',
      'CONFIDENCE: medium',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('medium');
  });

  it('parses low confidence correctly', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: When something fails.',
      'VERIFICATION: Run the test.',
      'CONFIDENCE: low',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('low');
  });

  it('defaults to medium for unknown confidence value', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: When something fails.',
      'VERIFICATION: Run the test.',
      'CONFIDENCE: uncertain',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('medium');
  });

  it('defaults to medium when CONFIDENCE line is missing entirely', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: When something fails.',
      'VERIFICATION: Run the test.',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('medium');
  });

  it('handles case-insensitive confidence values', () => {
    const text = [
      'HYPOTHESIS H1: Test issue',
      'CONDITIONS: Something.',
      'VERIFICATION: Test it.',
      'CONFIDENCE: HIGH',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.confidence).toBe('high');
  });

  // ── Fault tolerance ───────────────────────────────────────────

  it('handles missing CONDITIONS field', () => {
    const text = [
      'HYPOTHESIS H1: Missing conditions test',
      'VERIFICATION: Run the test.',
      'CONFIDENCE: high',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.conditions).toBe('Conditions not specified');
  });

  it('handles missing VERIFICATION field', () => {
    const text = [
      'HYPOTHESIS H1: Missing verification test',
      'CONDITIONS: When something bad happens.',
      'CONFIDENCE: medium',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.verification).toBe('Verification steps not specified');
  });

  it('handles missing FILES field', () => {
    const text = [
      'HYPOTHESIS H1: No files listed',
      'CONDITIONS: Something.',
      'VERIFICATION: Test.',
      'CONFIDENCE: low',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.relatedFiles).toEqual([]);
  });

  it('handles FILES with single file', () => {
    const text = [
      'HYPOTHESIS H1: Single file',
      'CONDITIONS: Something.',
      'VERIFICATION: Test.',
      'CONFIDENCE: low',
      'FILES: src/index.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.relatedFiles).toEqual(['src/index.ts']);
  });

  it('handles FILES with multiple files and trims whitespace', () => {
    const text = [
      'HYPOTHESIS H1: Multiple files',
      'CONDITIONS: Something.',
      'VERIFICATION: Test.',
      'CONFIDENCE: medium',
      'FILES: src/a.ts , src/b.ts,  src/c.ts  ',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.relatedFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('filters out empty file entries from FILES', () => {
    const text = [
      'HYPOTHESIS H1: Empty entries',
      'CONDITIONS: Something.',
      'VERIFICATION: Test.',
      'CONFIDENCE: medium',
      'FILES: src/a.ts, , src/b.ts, ',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses[0]?.relatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // ── ID parsing ────────────────────────────────────────────────

  it('preserves hypothesis IDs (H1, H2, H3, etc.)', () => {
    const text = [
      'HYPOTHESIS H1: First',
      'CONDITIONS: C1.',
      'VERIFICATION: V1.',
      'CONFIDENCE: high',
      'FILES: a.ts',
      '',
      'HYPOTHESIS H2: Second',
      'CONDITIONS: C2.',
      'VERIFICATION: V2.',
      'CONFIDENCE: medium',
      'FILES: b.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses.map((h) => h.id)).toEqual(['H1', 'H2']);
  });

  it('handles non-sequential IDs (H1, H3, H5)', () => {
    const text = [
      'HYPOTHESIS H1: First',
      'CONDITIONS: C.',
      'VERIFICATION: V.',
      'CONFIDENCE: high',
      'FILES: a.ts',
      '',
      'HYPOTHESIS H3: Third',
      'CONDITIONS: C.',
      'VERIFICATION: V.',
      'CONFIDENCE: low',
      'FILES: b.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses.map((h) => h.id)).toEqual(['H1', 'H3']);
  });

  // ── Multi-line fields ─────────────────────────────────────────

  it('handles multi-line CONDITIONS', () => {
    const text = [
      'HYPOTHESIS H1: Multi-line conditions',
      'CONDITIONS: When the user is authenticated and the session has expired,',
      'the refresh token endpoint returns a 401 but the client does not retry.',
      'VERIFICATION: Expire the session and observe the client behavior.',
      'CONFIDENCE: high',
      'FILES: src/auth.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.conditions).toContain('When the user is authenticated');
    expect(hypotheses[0]?.conditions).toContain('the refresh token endpoint');
  });

  // ── Realistic full LLM output ─────────────────────────────────

  it('parses a realistic full LLM diagnostic response', () => {
    const text = [
      'STATUS: NEEDS_HUMAN_REVIEW',
      'SUMMARY: Found 3 potential issues requiring investigation.',
      '',
      'HYPOTHESIS H1: Possible race condition in auth token refresh',
      'CONDITIONS: When two concurrent requests trigger token refresh simultaneously, the second may use an invalidated token.',
      'VERIFICATION: Write a test that fires two authenticated requests with an expired token within 50ms. Check if both succeed or if one gets a 401.',
      'CONFIDENCE: high',
      'FILES: src/auth/refresh.ts, src/middleware/auth.ts',
      '',
      'HYPOTHESIS H2: Missing null check on optional config value',
      'CONDITIONS: When `config.retryDelay` is undefined (not set in .env), the multiplication `retryDelay * 2` produces NaN, breaking exponential backoff.',
      'VERIFICATION: Remove RETRY_DELAY from .env and trigger a failing request. Observe if retry intervals are NaN instead of doubling.',
      'CONFIDENCE: medium',
      'FILES: src/utils/retry.ts',
      '',
      'FINDINGS:',
      '- SEVERITY: high',
      '  CATEGORY: bug',
      '  FILE: src/auth/refresh.ts',
      '  LINE: 45',
      '  MESSAGE: H1: Race condition in concurrent token refresh',
      '  SUGGESTION: Use a mutex or deduplication for concurrent refresh calls',
      '- SEVERITY: medium',
      '  CATEGORY: bug',
      '  FILE: src/utils/retry.ts',
      '  LINE: 12',
      '  MESSAGE: H2: NaN propagation when config.retryDelay is undefined',
      '  SUGGESTION: Add a default value or null check for retryDelay',
    ].join('\n');

    const hypotheses = parseHypotheses(text);

    expect(hypotheses).toHaveLength(2);

    // H1
    expect(hypotheses[0]?.id).toBe('H1');
    expect(hypotheses[0]?.title).toBe('Possible race condition in auth token refresh');
    expect(hypotheses[0]?.confidence).toBe('high');
    expect(hypotheses[0]?.relatedFiles).toEqual(['src/auth/refresh.ts', 'src/middleware/auth.ts']);

    // H2
    expect(hypotheses[1]?.id).toBe('H2');
    expect(hypotheses[1]?.title).toBe('Missing null check on optional config value');
    expect(hypotheses[1]?.confidence).toBe('medium');
    expect(hypotheses[1]?.relatedFiles).toEqual(['src/utils/retry.ts']);
  });

  // ── Edge cases with whitespace ────────────────────────────────

  it('handles extra whitespace around HYPOTHESIS keyword', () => {
    const text = [
      'HYPOTHESIS  H1:  Whitespace test  ',
      'CONDITIONS: Something.',
      'VERIFICATION: Test it.',
      'CONFIDENCE: low',
      'FILES: test.ts',
      '',
      'FINDINGS:',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.id).toBe('H1');
    expect(hypotheses[0]?.title).toBe('Whitespace test');
  });

  // ── Hypothesis at end of text (no trailing FINDINGS) ──────────

  it('handles hypothesis at end of text without FINDINGS section', () => {
    const text = [
      'HYPOTHESIS H1: End of text hypothesis',
      'CONDITIONS: When the text ends abruptly.',
      'VERIFICATION: Check parser handles EOF.',
      'CONFIDENCE: high',
      'FILES: parser.ts',
    ].join('\n');

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.title).toBe('End of text hypothesis');
  });

  // ── Maximum hypotheses ────────────────────────────────────────

  it('parses 5 hypotheses (maximum)', () => {
    const blocks: string[] = [];
    for (let i = 1; i <= 5; i++) {
      blocks.push(
        [
          `HYPOTHESIS H${i}: Hypothesis number ${i}`,
          `CONDITIONS: Condition ${i}.`,
          `VERIFICATION: Verify ${i}.`,
          `CONFIDENCE: ${i <= 2 ? 'high' : i <= 4 ? 'medium' : 'low'}`,
          `FILES: file${i}.ts`,
          '',
        ].join('\n'),
      );
    }
    const text = `${blocks.join('\n')}FINDINGS:\n`;

    const hypotheses = parseHypotheses(text);
    expect(hypotheses).toHaveLength(5);
    expect(hypotheses[0]?.id).toBe('H1');
    expect(hypotheses[4]?.id).toBe('H5');
  });
});
