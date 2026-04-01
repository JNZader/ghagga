/**
 * Unit tests for fan-out lenses review agent.
 *
 * Tests:
 *   - Lens registry (register, get, reset)
 *   - Finding merge/deduplication logic
 *   - Full fan-out review flow with fake generate functions
 *   - Edge cases: no lenses, all lenses fail, empty findings
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ReviewFinding } from '../types.js';
import {
  DEFAULT_LENSES,
  type FanOutReviewInput,
  getAllLenses,
  getLens,
  LENS_ACCESSIBILITY,
  LENS_ERROR_HANDLING,
  LENS_PERFORMANCE,
  LENS_SECURITY,
  LENS_TYPING,
  mergeFindings,
  type ReviewLens,
  registerLens,
  resetLensRegistry,
  runFanOutReview,
} from './fan-out-lenses.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'medium',
    category: 'security',
    file: 'src/auth.ts',
    line: 42,
    message: 'SQL injection vulnerability',
    suggestion: 'Use parameterized queries',
    source: 'ai',
    ...overrides,
  };
}

function makeFakeGenerateFn(response: string): GenerateTextFn {
  return vi.fn().mockResolvedValue({
    text: response,
    tokensUsed: 100,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
}

const PASSED_RESPONSE = `STATUS: PASSED
SUMMARY: No issues found.
FINDINGS:
`;

const FINDING_RESPONSE = (
  severity: string,
  category: string,
  file: string,
  line: number,
  message: string,
) => `STATUS: FAILED
SUMMARY: Found an issue.
FINDINGS:
- SEVERITY: ${severity}
  CATEGORY: ${category}
  FILE: ${file}
  LINE: ${line}
  MESSAGE: ${message}
  SUGGESTION: Fix it
`;

// ─── Lens Registry ──────────────────────────────────────────────

describe('Lens Registry', () => {
  beforeEach(() => {
    resetLensRegistry();
  });

  it('DEFAULT_LENSES has 5 built-in lenses', () => {
    expect(DEFAULT_LENSES).toHaveLength(5);
    expect(DEFAULT_LENSES.map((l) => l.name)).toEqual([
      'security',
      'performance',
      'error-handling',
      'typing',
      'accessibility',
    ]);
  });

  it('getLens returns built-in lenses by name', () => {
    expect(getLens('security')).toBe(LENS_SECURITY);
    expect(getLens('performance')).toBe(LENS_PERFORMANCE);
    expect(getLens('error-handling')).toBe(LENS_ERROR_HANDLING);
    expect(getLens('typing')).toBe(LENS_TYPING);
    expect(getLens('accessibility')).toBe(LENS_ACCESSIBILITY);
  });

  it('getLens returns undefined for unknown names', () => {
    expect(getLens('nonexistent')).toBeUndefined();
  });

  it('registerLens adds a custom lens', () => {
    const custom: ReviewLens = {
      name: 'i18n',
      label: 'Internationalization',
      system: 'Review for i18n issues.',
    };
    registerLens(custom);
    expect(getLens('i18n')).toBe(custom);
  });

  it('registerLens overwrites built-in lens with same name', () => {
    const override: ReviewLens = {
      name: 'security',
      label: 'Custom Security',
      system: 'Custom security prompt.',
    };
    registerLens(override);
    expect(getLens('security')).toBe(override);
    expect(getLens('security')?.label).toBe('Custom Security');
  });

  it('getAllLenses includes built-in and custom lenses', () => {
    registerLens({ name: 'custom', label: 'Custom', system: 'Custom prompt.' });
    const all = getAllLenses();
    expect(all.length).toBe(6);
    expect(all.map((l) => l.name)).toContain('custom');
    expect(all.map((l) => l.name)).toContain('security');
  });

  it('resetLensRegistry clears custom registrations', () => {
    registerLens({ name: 'custom', label: 'Custom', system: 'Custom prompt.' });
    expect(getLens('custom')).toBeDefined();
    resetLensRegistry();
    expect(getLens('custom')).toBeUndefined();
  });
});

// ─── mergeFindings ──────────────────────────────────────────────

describe('mergeFindings', () => {
  it('returns empty for no findings', () => {
    expect(mergeFindings([])).toEqual([]);
  });

  it('passes through unique findings', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: 1 }),
      makeFinding({ file: 'b.ts', line: 2 }),
    ];
    expect(mergeFindings(findings)).toHaveLength(2);
  });

  it('deduplicates by file+line, keeping highest severity', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: 10, severity: 'low', message: 'Low issue' }),
      makeFinding({ file: 'a.ts', line: 10, severity: 'critical', message: 'Critical issue' }),
    ];
    const merged = mergeFindings(findings);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe('critical');
  });

  it('keeps separate findings when same file but different lines', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: 10 }),
      makeFinding({ file: 'a.ts', line: 20 }),
    ];
    expect(mergeFindings(findings)).toHaveLength(2);
  });

  it('deduplicates line-less findings by file+message', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: undefined, message: 'Same issue', severity: 'low' }),
      makeFinding({ file: 'a.ts', line: undefined, message: 'Same issue', severity: 'high' }),
    ];
    const merged = mergeFindings(findings);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe('high');
  });

  it('keeps line-less findings with different messages', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: undefined, message: 'Issue A' }),
      makeFinding({ file: 'a.ts', line: undefined, message: 'Issue B' }),
    ];
    expect(mergeFindings(findings)).toHaveLength(2);
  });

  it('sorts by severity (highest first), then by file', () => {
    const findings = [
      makeFinding({ file: 'z.ts', line: 1, severity: 'low' }),
      makeFinding({ file: 'a.ts', line: 2, severity: 'critical' }),
      makeFinding({ file: 'b.ts', line: 3, severity: 'high' }),
    ];
    const merged = mergeFindings(findings);
    expect(merged.map((f) => f.severity)).toEqual(['critical', 'high', 'low']);
  });

  it('keeps first finding when duplicate has equal severity', () => {
    const findings = [
      makeFinding({ file: 'a.ts', line: 5, severity: 'medium', message: 'First' }),
      makeFinding({ file: 'a.ts', line: 5, severity: 'medium', message: 'Second' }),
    ];
    const merged = mergeFindings(findings);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.message).toBe('First');
  });
});

// ─── runFanOutReview ────────────────────────────────────────────

describe('runFanOutReview', () => {
  beforeEach(() => {
    resetLensRegistry();
  });

  function makeInput(overrides: Partial<FanOutReviewInput> = {}): FanOutReviewInput {
    return {
      diff: '--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
      staticContext: '',
      memoryContext: null,
      stackHints: '',
      reviewLevel: 'normal',
      ...overrides,
    };
  }

  it('uses first 3 default lenses when none specified', async () => {
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    const result = await runFanOutReview(makeInput({ generateFns: [fn], lenses: undefined }));

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('PASSED');
    expect(result.metadata.mode).toBe('fan-out');
  });

  it('uses specified lenses', async () => {
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    const result = await runFanOutReview(
      makeInput({ generateFns: [fn], lenses: ['security', 'typing'] }),
    );

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('PASSED');
  });

  it('skips unknown lenses with warning', async () => {
    const progressEvents: string[] = [];
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    await runFanOutReview(
      makeInput({
        generateFns: [fn],
        lenses: ['security', 'nonexistent'],
        onProgress: (e) => progressEvents.push(e.message),
      }),
    );

    expect(fn).toHaveBeenCalledTimes(1); // Only security runs
    expect(progressEvents).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown lens "nonexistent"')]),
    );
  });

  it('throws when no valid lenses resolved', async () => {
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    await expect(
      runFanOutReview(makeInput({ generateFns: [fn], lenses: ['bad1', 'bad2'] })),
    ).rejects.toThrow('No valid lenses');
  });

  it('merges findings from multiple lenses', async () => {
    const securityFn = makeFakeGenerateFn(
      FINDING_RESPONSE('critical', 'security', 'auth.ts', 10, 'SQL injection'),
    );
    const perfFn = makeFakeGenerateFn(
      FINDING_RESPONSE('high', 'performance', 'db.ts', 20, 'N+1 query'),
    );

    const result = await runFanOutReview(
      makeInput({
        generateFns: [securityFn, perfFn],
        lenses: ['security', 'performance'],
      }),
    );

    expect(result.findings).toHaveLength(2);
    expect(result.status).toBe('FAILED'); // critical finding
  });

  it('deduplicates findings from different lenses at same location', async () => {
    // Both lenses find something at the same file:line
    const response = FINDING_RESPONSE('high', 'security', 'auth.ts', 42, 'Issue found');
    const fn = makeFakeGenerateFn(response);

    const result = await runFanOutReview(
      makeInput({
        generateFns: [fn],
        lenses: ['security', 'error-handling'],
      }),
    );

    // Same file:line from 2 lenses → deduped to 1
    expect(result.findings).toHaveLength(1);
  });

  it('returns NEEDS_HUMAN_REVIEW when some lenses FAIL and no critical', async () => {
    const fn = makeFakeGenerateFn(
      FINDING_RESPONSE('high', 'security', 'auth.ts', 10, 'High issue'),
    );

    const result = await runFanOutReview(makeInput({ generateFns: [fn], lenses: ['security'] }));

    expect(result.status).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('handles lens failures gracefully', async () => {
    const failFn: GenerateTextFn = vi.fn().mockRejectedValue(new Error('Rate limited'));
    const passFn = makeFakeGenerateFn(PASSED_RESPONSE);

    const result = await runFanOutReview(
      makeInput({
        generateFns: [failFn, passFn],
        lenses: ['security', 'performance'],
      }),
    );

    // First lens fails, second passes
    expect(result.findings).toHaveLength(0);
    expect(result.metadata.modelsUsed).toEqual(
      expect.arrayContaining([expect.stringContaining('FAILED')]),
    );
  });

  it('tracks token usage across all lenses', async () => {
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    const result = await runFanOutReview(
      makeInput({ generateFns: [fn], lenses: ['security', 'performance', 'typing'] }),
    );

    // 100 tokens per lens * 3 lenses
    expect(result.metadata.tokensUsed).toBe(300);
  });

  it('distributes generateFns round-robin', async () => {
    const fn1 = makeFakeGenerateFn(PASSED_RESPONSE);
    const fn2 = makeFakeGenerateFn(PASSED_RESPONSE);

    await runFanOutReview(
      makeInput({
        generateFns: [fn1, fn2],
        lenses: ['security', 'performance', 'error-handling'],
      }),
    );

    // fn1 → lens 0 (security) and lens 2 (error-handling)
    // fn2 → lens 1 (performance)
    expect(fn1).toHaveBeenCalledTimes(2);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('applies custom registered lenses', async () => {
    registerLens({
      name: 'i18n',
      label: 'Internationalization',
      system: 'Check for i18n issues.',
    });

    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    const result = await runFanOutReview(makeInput({ generateFns: [fn], lenses: ['i18n'] }));

    expect(result.status).toBe('PASSED');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('populates metadata with correct mode and modelsUsed', async () => {
    const fn = makeFakeGenerateFn(PASSED_RESPONSE);
    const result = await runFanOutReview(makeInput({ generateFns: [fn], lenses: ['security'] }));

    expect(result.metadata.mode).toBe('fan-out');
    expect(result.metadata.modelsUsed).toEqual(['security:anthropic/claude-sonnet-4-20250514']);
  });
});
