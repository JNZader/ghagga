import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveRules,
  type FindingFeedback,
  formatRulesForPrompt,
  type ImprovementRule,
  loadFeedback,
  recordFeedback,
} from './index.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeFeedback(overrides: Partial<FindingFeedback> = {}): FindingFeedback {
  return {
    findingHash: 'abc123',
    outcome: 'accepted',
    category: 'security',
    severity: 'high',
    modelUsed: 'claude-sonnet-4',
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRejections(category: string, count: number): FindingFeedback[] {
  return Array.from({ length: count }, (_, i) =>
    makeFeedback({ outcome: 'rejected', category, findingHash: `hash-rej-${i}` }),
  );
}

function makeAcceptances(category: string, count: number): FindingFeedback[] {
  return Array.from({ length: count }, (_, i) =>
    makeFeedback({ outcome: 'accepted', category, findingHash: `hash-acc-${i}` }),
  );
}

// ─── deriveRules ─────────────────────────────────────────────────

describe('deriveRules', () => {
  it('returns empty array for no feedback', () => {
    expect(deriveRules([])).toHaveLength(0);
  });

  it('returns empty when sample count is below threshold', () => {
    // Only 4 samples — threshold is 5
    const feedback = makeRejections('style', 4);
    expect(deriveRules(feedback)).toHaveLength(0);
  });

  it('creates suppress rule when rejection rate > 70%', () => {
    // 8 rejected, 2 accepted → 80% rejection rate
    const feedback = [...makeRejections('style', 8), ...makeAcceptances('style', 2)];
    const rules = deriveRules(feedback);

    const suppressed = rules.find((r) => r.category === 'style' && r.action === 'suppress');
    expect(suppressed).toBeDefined();
    expect(suppressed?.confidence).toBeGreaterThan(0.7);
    expect(suppressed?.sampleCount).toBe(10);
  });

  it('creates boost_priority rule when acceptance rate > 80%', () => {
    // 9 accepted, 1 rejected → 90% acceptance rate
    const feedback = [...makeAcceptances('security', 9), ...makeRejections('security', 1)];
    const rules = deriveRules(feedback);

    const boosted = rules.find((r) => r.category === 'security' && r.action === 'boost_priority');
    expect(boosted).toBeDefined();
    expect(boosted?.confidence).toBeGreaterThan(0.8);
  });

  it('creates no rule when neither threshold is met', () => {
    // 3 rejected, 3 accepted out of 6 → 50% rejection — below threshold
    const feedback = [...makeRejections('performance', 3), ...makeAcceptances('performance', 3)];
    const rules = deriveRules(feedback);

    expect(rules.find((r) => r.category === 'performance')).toBeUndefined();
  });

  it('handles multiple categories', () => {
    const feedback = [
      ...makeRejections('style', 8),
      ...makeAcceptances('style', 2),
      ...makeAcceptances('security', 9),
      ...makeRejections('security', 1),
    ];
    const rules = deriveRules(feedback);

    expect(rules).toHaveLength(2);
    const categories = rules.map((r) => r.category);
    expect(categories).toContain('style');
    expect(categories).toContain('security');
  });

  it('sorts rules by confidence descending', () => {
    // 9 rejected out of 10 for style → 90% reject rate
    // 8 accepted out of 10 for security → 80% accept rate (just above threshold but less confident)
    // Wait — we need to ensure the higher confidence rule sorts first.
    // style: 90% reject (high confidence suppress)
    // security: 82% accept → boost
    const feedback = [
      ...makeRejections('style', 9),
      ...makeAcceptances('style', 1),
      ...makeAcceptances('security', 9),
      ...makeRejections('security', 1),
    ];
    const rules = deriveRules(feedback);

    for (let i = 0; i < rules.length - 1; i++) {
      const current = rules[i] as ImprovementRule;
      const next = rules[i + 1] as ImprovementRule;
      expect(current.confidence).toBeGreaterThanOrEqual(next.confidence);
    }
  });

  it('includes modified outcomes in total count but not in accepted or rejected', () => {
    // 5 rejected, 3 modified, 2 accepted → total 10
    // rejection rate: 5/10 = 50% → no suppress
    const feedback = [
      ...makeRejections('bug', 5),
      ...Array.from({ length: 3 }, (_, i) =>
        makeFeedback({ outcome: 'modified', category: 'bug', findingHash: `mod-${i}` }),
      ),
      ...makeAcceptances('bug', 2),
    ];
    const rules = deriveRules(feedback);
    expect(rules.find((r) => r.category === 'bug' && r.action === 'suppress')).toBeUndefined();
  });
});

// ─── formatRulesForPrompt ─────────────────────────────────────────

describe('formatRulesForPrompt', () => {
  it('returns empty string for no rules', () => {
    expect(formatRulesForPrompt([])).toBe('');
  });

  it('formats suppress rules with rejection rate', () => {
    const rules: ImprovementRule[] = [
      {
        pattern: 'category:style',
        category: 'style',
        action: 'suppress',
        confidence: 0.8,
        sampleCount: 10,
      },
    ];
    const output = formatRulesForPrompt(rules);
    expect(output).toContain('SUPPRESS');
    expect(output).toContain('style');
    expect(output).toContain('80%');
  });

  it('formats boost rules with acceptance rate', () => {
    const rules: ImprovementRule[] = [
      {
        pattern: 'category:security',
        category: 'security',
        action: 'boost_priority',
        confidence: 0.9,
        sampleCount: 15,
      },
    ];
    const output = formatRulesForPrompt(rules);
    expect(output).toContain('PRIORITIZE');
    expect(output).toContain('security');
    expect(output).toContain('90%');
  });

  it('includes header section', () => {
    const rules: ImprovementRule[] = [
      {
        pattern: 'category:style',
        category: 'style',
        action: 'suppress',
        confidence: 0.75,
        sampleCount: 8,
      },
    ];
    const output = formatRulesForPrompt(rules);
    expect(output).toContain('Review Improvement Rules');
  });
});

// ─── recordFeedback / loadFeedback ───────────────────────────────

describe('recordFeedback and loadFeedback', () => {
  let tmpDir: string;
  let storagePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ghagga-test-'));
    storagePath = join(tmpDir, 'feedback.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file and records a single feedback entry', async () => {
    const fb = makeFeedback({ findingHash: 'test-hash-1' });
    await recordFeedback(fb, storagePath);

    const loaded = await loadFeedback(storagePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.findingHash).toBe('test-hash-1');
  });

  it('appends multiple entries', async () => {
    await recordFeedback(makeFeedback({ findingHash: 'hash-1' }), storagePath);
    await recordFeedback(makeFeedback({ findingHash: 'hash-2' }), storagePath);
    await recordFeedback(makeFeedback({ findingHash: 'hash-3' }), storagePath);

    const loaded = await loadFeedback(storagePath);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((f) => f.findingHash)).toContain('hash-1');
    expect(loaded.map((f) => f.findingHash)).toContain('hash-3');
  });

  it('returns empty array when file does not exist', async () => {
    const loaded = await loadFeedback(join(tmpDir, 'nonexistent.jsonl'));
    expect(loaded).toEqual([]);
  });

  it('creates parent directories if they do not exist', async () => {
    const nestedPath = join(tmpDir, 'nested', 'deep', 'feedback.jsonl');
    await recordFeedback(makeFeedback(), nestedPath);

    const loaded = await loadFeedback(nestedPath);
    expect(loaded).toHaveLength(1);
  });

  it('round-trips all feedback fields', async () => {
    const original = makeFeedback({
      findingHash: 'abc-xyz',
      outcome: 'modified',
      category: 'performance',
      severity: 'medium',
      modelUsed: 'gpt-4o',
      recordedAt: '2024-01-01T00:00:00.000Z',
    });
    await recordFeedback(original, storagePath);

    const [loaded] = await loadFeedback(storagePath);
    expect(loaded).toEqual(original);
  });
});
