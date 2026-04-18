import { describe, expect, it, vi } from 'vitest';
import type { ReviewFinding, ReviewResult } from '../types.js';
import { computeSimilarity, matchFindings, runCrossModelReview } from './cross-model.js';

// ─── computeSimilarity ─────────────────────────────────────────

describe('computeSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const sim = computeSimilarity('SQL injection vulnerability', 'SQL injection vulnerability');
    expect(sim).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    const sim = computeSimilarity('performance bottleneck', 'xyz abc def');
    expect(sim).toBe(0);
  });

  it('returns partial similarity for overlapping words', () => {
    const sim = computeSimilarity(
      'SQL injection vulnerability in auth module',
      'SQL injection found in authentication handler',
    );
    expect(sim).toBeGreaterThan(0.2);
    expect(sim).toBeLessThan(1.0);
  });

  it('ignores short words (<=2 chars)', () => {
    const sim = computeSimilarity('a b c', 'a b c');
    expect(sim).toBe(0); // all tokens filtered out
  });

  it('is case-insensitive', () => {
    const sim = computeSimilarity('SQL Injection', 'sql injection');
    expect(sim).toBe(1.0);
  });

  it('returns 0 for empty strings', () => {
    expect(computeSimilarity('', 'something')).toBe(0);
    expect(computeSimilarity('something', '')).toBe(0);
    expect(computeSimilarity('', '')).toBe(0);
  });
});

// ─── matchFindings ─────────────────────────────────────────────

describe('matchFindings', () => {
  const makeFinding = (file: string, message: string): ReviewFinding => ({
    severity: 'high',
    category: 'security',
    file,
    message,
    source: 'ai',
  });

  it('matches findings with same file and similar message', () => {
    const findingsA = [makeFinding('src/auth.ts', 'SQL injection vulnerability in query builder')];
    const findingsB = [makeFinding('src/auth.ts', 'SQL injection vulnerability found in query')];

    const { matches, unmatchedA, unmatchedB } = matchFindings(findingsA, findingsB, 0.5);

    expect(matches).toHaveLength(1);
    expect(matches[0].indexA).toBe(0);
    expect(matches[0].indexB).toBe(0);
    expect(unmatchedA).toHaveLength(0);
    expect(unmatchedB).toHaveLength(0);
  });

  it('does not match findings from different files', () => {
    const findingsA = [makeFinding('src/auth.ts', 'SQL injection')];
    const findingsB = [makeFinding('src/api.ts', 'SQL injection')];

    const { matches, unmatchedA, unmatchedB } = matchFindings(findingsA, findingsB, 0.5);

    expect(matches).toHaveLength(0);
    expect(unmatchedA).toHaveLength(1);
    expect(unmatchedB).toHaveLength(1);
  });

  it('does not match below similarity threshold', () => {
    const findingsA = [makeFinding('src/app.ts', 'Performance bottleneck in render loop')];
    const findingsB = [makeFinding('src/app.ts', 'Missing error handling for null values')];

    const { matches } = matchFindings(findingsA, findingsB, 0.5);
    expect(matches).toHaveLength(0);
  });

  it('handles empty finding arrays', () => {
    const { matches, unmatchedA, unmatchedB } = matchFindings([], [], 0.5);
    expect(matches).toHaveLength(0);
    expect(unmatchedA).toHaveLength(0);
    expect(unmatchedB).toHaveLength(0);
  });

  it('greedy matches best pair first', () => {
    const findingsA = [
      makeFinding('src/app.ts', 'SQL injection vulnerability'),
      makeFinding('src/app.ts', 'Missing input validation'),
    ];
    const findingsB = [makeFinding('src/app.ts', 'SQL injection vulnerability detected')];

    const { matches, unmatchedA, unmatchedB } = matchFindings(findingsA, findingsB, 0.4);

    expect(matches).toHaveLength(1);
    expect(matches[0].indexA).toBe(0); // SQL injection matched
    expect(unmatchedA).toEqual([1]); // Missing input unmatched
    expect(unmatchedB).toHaveLength(0);
  });

  it('prevents double-matching', () => {
    const findingsA = [
      makeFinding('src/app.ts', 'SQL injection vulnerability'),
      makeFinding('src/app.ts', 'SQL injection in different module'),
    ];
    const findingsB = [makeFinding('src/app.ts', 'SQL injection vulnerability detected')];

    const { matches } = matchFindings(findingsA, findingsB, 0.4);

    // Only one match — B[0] can only match one A
    expect(matches).toHaveLength(1);
  });
});

// ─── runCrossModelReview ───────────────────────────────────────

describe('runCrossModelReview', () => {
  const makeFinding = (message: string, file = 'src/app.ts'): ReviewFinding => ({
    severity: 'high',
    category: 'security',
    file,
    line: 10,
    message,
    source: 'ai',
  });

  const makeStaticFinding = (): ReviewFinding => ({
    severity: 'medium',
    category: 'lint',
    file: 'src/app.ts',
    line: 5,
    message: 'Lint error',
    source: 'semgrep',
  });

  const makeReview = (
    aiFindings: ReviewFinding[],
    staticFindings: ReviewFinding[] = [],
  ): ReviewResult => ({
    status: 'FAILED',
    summary: 'Issues found.',
    findings: [...aiFindings, ...staticFindings],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'test',
      tokensUsed: 100,
      executionTimeMs: 500,
      toolsRun: [],
      toolsSkipped: [],
    },
  });

  const defaultInput = {
    diff: 'diff --git a/src/app.ts\n+const x = 1;',
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    modelALabel: 'claude',
    modelBLabel: 'gpt-4o',
  };

  // Mock generateFn that returns a no-critique response
  const mockCritiqueFn = () =>
    vi.fn().mockResolvedValue({
      text: 'OVERALL_ASSESSMENT: OK\nCRITIQUES:\n',
      tokensUsed: 100,
      provider: 'gateway',
      model: 'test',
    });

  it('identifies agreed findings from both models', async () => {
    const reviewA = makeReview([makeFinding('SQL injection vulnerability in query builder')]);
    const reviewB = makeReview([makeFinding('SQL injection vulnerability found in query')]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.metadata.agreedCount).toBe(1);
    expect(
      result.findings.filter((f) => f.agreementLevel === 'agreed' && f.source === 'ai'),
    ).toHaveLength(1);
    expect(result.findings[0].crossModelConfidence).toBeGreaterThan(0.8);
    expect(result.findings[0].reportedBy).toEqual(['claude', 'gpt-4o']);
  });

  it('identifies model-specific findings', async () => {
    const reviewA = makeReview([
      makeFinding('SQL injection vulnerability'),
      makeFinding('XSS in template rendering'),
    ]);
    const reviewB = makeReview([makeFinding('SQL injection vulnerability found')]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.metadata.agreedCount).toBe(1);
    expect(result.metadata.modelAOnlyCount).toBe(1);
    expect(result.metadata.modelBOnlyCount).toBe(0);

    const aOnly = result.findings.filter((f) => f.agreementLevel === 'model-a-only');
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].message).toBe('XSS in template rendering');
    expect(aOnly[0].crossModelConfidence).toBeLessThan(
      result.findings.find((f) => f.agreementLevel === 'agreed' && f.source === 'ai')!
        .crossModelConfidence,
    );
  });

  it('preserves static findings from model A', async () => {
    const reviewA = makeReview([makeFinding('Issue')], [makeStaticFinding()]);
    const reviewB = makeReview([makeFinding('Different thing', 'other.ts')]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    const staticFindings = result.findings.filter((f) => f.source === 'semgrep');
    expect(staticFindings).toHaveLength(1);
    expect(staticFindings[0].crossModelConfidence).toBe(1.0);
  });

  it('returns PASSED when no findings from either model', async () => {
    const reviewA = makeReview([]);
    const reviewB = makeReview([]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.status).toBe('PASSED');
    expect(result.findings.filter((f) => f.source === 'ai')).toHaveLength(0);
  });

  it('returns FAILED when agreed high-severity findings exist', async () => {
    const reviewA = makeReview([makeFinding('Critical SQL injection')]);
    const reviewB = makeReview([makeFinding('Critical SQL injection found')]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.status).toBe('FAILED');
  });

  it('returns NEEDS_HUMAN_REVIEW when models disagree', async () => {
    const reviewA = makeReview([makeFinding('Issue only model A sees')]);
    const reviewB = makeReview([
      makeFinding('Completely different issue model B sees', 'other.ts'),
    ]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.status).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('runs dual-critique when enableCritique is true', async () => {
    const reviewA = makeReview([makeFinding('Issue A')]);
    const reviewB = makeReview([makeFinding('Issue B', 'other.ts')]);

    // Mock critique responses: first pair for model A, second for model B
    const genA = vi
      .fn()
      .mockResolvedValueOnce({
        text: `OVERALL_ASSESSMENT: OK
CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: valid
  REASONING: Correct`,
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      })
      .mockResolvedValueOnce({
        text: 'STATUS: FAILED\nSUMMARY: Issue.\nFINDINGS:\n',
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      });

    const genB = vi
      .fn()
      .mockResolvedValueOnce({
        text: `OVERALL_ASSESSMENT: OK
CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: false-positive
  REASONING: Not real`,
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      })
      .mockResolvedValueOnce({
        text: 'STATUS: PASSED\nSUMMARY: Clean.\nFINDINGS:\n',
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      });

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: true } },
      genA,
      genB,
    );

    // Model B's finding was removed by critique, so only model A's remains
    expect(genA).toHaveBeenCalled();
    expect(genB).toHaveBeenCalled();
    expect(result.metadata.modelAFindingCount).toBe(1);
    expect(result.metadata.modelBFindingCount).toBe(0); // removed by critique
  });

  it('calls progress callback', async () => {
    const reviewA = makeReview([makeFinding('Issue')]);
    const reviewB = makeReview([makeFinding('Issue found')]);
    const events: string[] = [];

    await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
      (event) => events.push(event.message),
    );

    expect(events.some((e) => e.includes('Comparing'))).toBe(true);
    expect(events.some((e) => e.includes('Cross-model complete'))).toBe(true);
  });

  it('summary mentions both model labels', async () => {
    const reviewA = makeReview([makeFinding('Issue')]);
    const reviewB = makeReview([makeFinding('Issue found')]);

    const result = await runCrossModelReview(
      reviewA,
      reviewB,
      { ...defaultInput, config: { enableCritique: false } },
      mockCritiqueFn(),
      mockCritiqueFn(),
    );

    expect(result.summary).toContain('claude');
    expect(result.summary).toContain('gpt-4o');
  });
});
