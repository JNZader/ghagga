import { describe, expect, it, vi } from 'vitest';
import type { ReviewFinding, ReviewResult } from '../types.js';
import { applyCritique, parseCritiqueResponse, runDualCritique } from './critique.js';
import type { CritiqueResult } from './types.js';

// ─── parseCritiqueResponse ─────────────────────────────────────

describe('parseCritiqueResponse', () => {
  it('parses a well-formed critique response', () => {
    const text = `OVERALL_ASSESSMENT: The review is mostly accurate but has two false positives.

CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: valid
  REASONING: This is a real SQL injection vulnerability.
- FINDING_INDEX: 1
  VERDICT: false-positive
  REASONING: The function is intentionally designed this way.
- FINDING_INDEX: 2
  VERDICT: overreaction
  REASONING: This is a minor style issue, not a high severity bug.
  SUGGESTED_SEVERITY: low`;

    const result = parseCritiqueResponse(text);

    expect(result.overallAssessment).toBe(
      'The review is mostly accurate but has two false positives.',
    );
    expect(result.critiques).toHaveLength(3);

    expect(result.critiques[0]).toEqual({
      findingIndex: 0,
      verdict: 'valid',
      reasoning: 'This is a real SQL injection vulnerability.',
    });

    expect(result.critiques[1]).toEqual({
      findingIndex: 1,
      verdict: 'false-positive',
      reasoning: 'The function is intentionally designed this way.',
    });

    expect(result.critiques[2]).toEqual({
      findingIndex: 2,
      verdict: 'overreaction',
      reasoning: 'This is a minor style issue, not a high severity bug.',
      suggestedSeverity: 'low',
    });

    expect(result.falsePositiveCount).toBe(1);
    expect(result.overreactionCount).toBe(1);
  });

  it('defaults to valid for unknown verdicts', () => {
    const text = `OVERALL_ASSESSMENT: OK

CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: nonsense-verdict
  REASONING: Something`;

    const result = parseCritiqueResponse(text);
    expect(result.critiques[0].verdict).toBe('valid');
  });

  it('handles empty critique response', () => {
    const result = parseCritiqueResponse('');
    expect(result.overallAssessment).toBe('Assessment could not be parsed.');
    expect(result.critiques).toHaveLength(0);
    expect(result.falsePositiveCount).toBe(0);
  });

  it('ignores suggested severity when verdict is not overreaction', () => {
    const text = `OVERALL_ASSESSMENT: OK

CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: valid
  REASONING: Good finding
  SUGGESTED_SEVERITY: low`;

    const result = parseCritiqueResponse(text);
    expect(result.critiques[0].suggestedSeverity).toBeUndefined();
  });

  it('parses redundant verdicts', () => {
    const text = `OVERALL_ASSESSMENT: Review has duplicates.

CRITIQUES:
- FINDING_INDEX: 3
  VERDICT: redundant
  REASONING: Same as finding 1`;

    const result = parseCritiqueResponse(text);
    expect(result.critiques[0]).toEqual({
      findingIndex: 3,
      verdict: 'redundant',
      reasoning: 'Same as finding 1',
    });
  });
});

// ─── applyCritique ─────────────────────────────────────────────

describe('applyCritique', () => {
  const baseFinding: ReviewFinding = {
    severity: 'high',
    category: 'security',
    file: 'src/auth.ts',
    line: 42,
    message: 'SQL injection',
    suggestion: 'Use parameterized queries',
    source: 'ai',
  };

  it('keeps findings with valid verdict', () => {
    const findings = [baseFinding];
    const critique: CritiqueResult = {
      critiques: [{ findingIndex: 0, verdict: 'valid', reasoning: 'Correct' }],
      overallAssessment: 'Good',
      falsePositiveCount: 0,
      overreactionCount: 0,
    };

    const { refined, removedCount, adjustedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(1);
    expect(refined[0]).toEqual(baseFinding);
    expect(removedCount).toBe(0);
    expect(adjustedCount).toBe(0);
  });

  it('removes findings with false-positive verdict', () => {
    const findings = [baseFinding];
    const critique: CritiqueResult = {
      critiques: [{ findingIndex: 0, verdict: 'false-positive', reasoning: 'Not real' }],
      overallAssessment: 'Over-reported',
      falsePositiveCount: 1,
      overreactionCount: 0,
    };

    const { refined, removedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(0);
    expect(removedCount).toBe(1);
  });

  it('removes findings with redundant verdict', () => {
    const findings = [baseFinding, { ...baseFinding, message: 'Duplicate' }];
    const critique: CritiqueResult = {
      critiques: [{ findingIndex: 1, verdict: 'redundant', reasoning: 'Same as 0' }],
      overallAssessment: 'Has duplicates',
      falsePositiveCount: 0,
      overreactionCount: 0,
    };

    const { refined, removedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(1);
    expect(removedCount).toBe(1);
  });

  it('adjusts severity for overreaction findings', () => {
    const findings = [baseFinding];
    const critique: CritiqueResult = {
      critiques: [
        {
          findingIndex: 0,
          verdict: 'overreaction',
          reasoning: 'Minor issue',
          suggestedSeverity: 'low',
        },
      ],
      overallAssessment: 'Overreacted',
      falsePositiveCount: 0,
      overreactionCount: 1,
    };

    const { refined, adjustedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(1);
    expect(refined[0].severity).toBe('low');
    expect(adjustedCount).toBe(1);
  });

  it('keeps overreaction findings unchanged when no suggested severity', () => {
    const findings = [baseFinding];
    const critique: CritiqueResult = {
      critiques: [
        { findingIndex: 0, verdict: 'overreaction', reasoning: 'Too harsh but hard to say' },
      ],
      overallAssessment: 'OK',
      falsePositiveCount: 0,
      overreactionCount: 1,
    };

    const { refined, adjustedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(1);
    expect(refined[0].severity).toBe('high');
    expect(adjustedCount).toBe(0);
  });

  it('keeps findings without a matching critique', () => {
    const findings = [baseFinding, { ...baseFinding, file: 'other.ts' }];
    const critique: CritiqueResult = {
      critiques: [{ findingIndex: 0, verdict: 'false-positive', reasoning: 'Wrong' }],
      overallAssessment: 'Partial review',
      falsePositiveCount: 1,
      overreactionCount: 0,
    };

    const { refined } = applyCritique(findings, critique);
    expect(refined).toHaveLength(1);
    expect(refined[0].file).toBe('other.ts');
  });

  it('handles mixed verdicts correctly', () => {
    const findings = [
      { ...baseFinding, message: 'Finding 0' },
      { ...baseFinding, message: 'Finding 1' },
      { ...baseFinding, message: 'Finding 2' },
      { ...baseFinding, message: 'Finding 3' },
    ];
    const critique: CritiqueResult = {
      critiques: [
        { findingIndex: 0, verdict: 'valid', reasoning: 'OK' },
        { findingIndex: 1, verdict: 'false-positive', reasoning: 'Wrong' },
        {
          findingIndex: 2,
          verdict: 'overreaction',
          reasoning: 'Too harsh',
          suggestedSeverity: 'info',
        },
        { findingIndex: 3, verdict: 'redundant', reasoning: 'Dup' },
      ],
      overallAssessment: 'Mixed',
      falsePositiveCount: 1,
      overreactionCount: 1,
    };

    const { refined, removedCount, adjustedCount } = applyCritique(findings, critique);
    expect(refined).toHaveLength(2);
    expect(refined[0].message).toBe('Finding 0');
    expect(refined[1].message).toBe('Finding 2');
    expect(refined[1].severity).toBe('info');
    expect(removedCount).toBe(2);
    expect(adjustedCount).toBe(1);
  });
});

// ─── runDualCritique ───────────────────────────────────────────

describe('runDualCritique', () => {
  const makeFinding = (message: string, source: string = 'ai'): ReviewFinding => ({
    severity: 'high',
    category: 'security',
    file: 'src/app.ts',
    line: 10,
    message,
    source,
  });

  const makeReviewResult = (findings: ReviewFinding[]): ReviewResult => ({
    status: 'FAILED',
    summary: 'Issues found.',
    findings,
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'test-model',
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
  };

  it('skips critique when below minimum findings', async () => {
    const review = makeReviewResult([]);
    const generateFn = vi.fn();

    const result = await runDualCritique(review, defaultInput, generateFn);

    expect(generateFn).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
    expect(result.critiqueMetadata).toBeUndefined();
  });

  it('runs full critique loop and removes false positives', async () => {
    const review = makeReviewResult([
      makeFinding('Real issue'),
      makeFinding('False alarm'),
      makeFinding('Static finding', 'semgrep'),
    ]);

    const generateFn = vi
      .fn()
      // First call: self-critique
      .mockResolvedValueOnce({
        text: `OVERALL_ASSESSMENT: One false positive found.

CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: valid
  REASONING: This is real.
- FINDING_INDEX: 1
  VERDICT: false-positive
  REASONING: This is not actually an issue.`,
        tokensUsed: 200,
        provider: 'gateway',
        model: 'test',
      })
      // Second call: refined review
      .mockResolvedValueOnce({
        text: 'STATUS: PASSED\nSUMMARY: After critique, only one real issue remains.\nFINDINGS:\n',
        tokensUsed: 150,
        provider: 'gateway',
        model: 'test',
      });

    const result = await runDualCritique(review, defaultInput, generateFn);

    expect(generateFn).toHaveBeenCalledTimes(2);
    // 1 AI finding kept + 1 static finding untouched
    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((f) => f.message === 'Real issue')).toBeDefined();
    expect(result.findings.find((f) => f.source === 'semgrep')).toBeDefined();
    expect(result.findings.find((f) => f.message === 'False alarm')).toBeUndefined();
    expect(result.status).toBe('PASSED');
    expect(result.summary).toBe('After critique, only one real issue remains.');
    expect(result.critiqueMetadata).toBeDefined();
    expect(result.critiqueMetadata!.initialFindingCount).toBe(2);
    expect(result.critiqueMetadata!.finalFindingCount).toBe(1);
    expect(result.critiqueMetadata!.removedAsFalsePositive).toBe(1);
  });

  it('preserves non-AI findings untouched', async () => {
    const review = makeReviewResult([
      makeFinding('AI finding'),
      makeFinding('Trivy finding', 'trivy'),
      makeFinding('Semgrep finding', 'semgrep'),
    ]);

    const generateFn = vi
      .fn()
      .mockResolvedValueOnce({
        text: `OVERALL_ASSESSMENT: OK

CRITIQUES:
- FINDING_INDEX: 0
  VERDICT: false-positive
  REASONING: Wrong.`,
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

    const result = await runDualCritique(review, defaultInput, generateFn);

    // All AI findings removed, but static findings remain
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.source !== 'ai')).toBe(true);
  });

  it('respects includeCritiqueMetadata config', async () => {
    const review = makeReviewResult([makeFinding('Issue')]);

    const generateFn = vi
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
        text: 'STATUS: FAILED\nSUMMARY: Issue found.\nFINDINGS:\n',
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      });

    const result = await runDualCritique(
      review,
      { ...defaultInput, config: { includeCritiqueMetadata: false } },
      generateFn,
    );

    expect(result.critiqueMetadata).toBeUndefined();
  });

  it('calls progress callback at each step', async () => {
    const review = makeReviewResult([makeFinding('Issue')]);
    const progressEvents: string[] = [];

    const generateFn = vi
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
        text: 'STATUS: FAILED\nSUMMARY: Issue found.\nFINDINGS:\n',
        tokensUsed: 100,
        provider: 'gateway',
        model: 'test',
      });

    await runDualCritique(review, defaultInput, generateFn, (event) => {
      progressEvents.push(event.message);
    });

    expect(progressEvents.length).toBeGreaterThanOrEqual(3);
    expect(progressEvents[0]).toContain('Running self-critique');
    expect(progressEvents[1]).toContain('Critique complete');
    expect(progressEvents[2]).toContain('Refined');
  });
});
