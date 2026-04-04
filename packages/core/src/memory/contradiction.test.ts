import { describe, expect, it } from 'vitest';
import type { MemoryObservationRow, VersioningConfig } from '../types.js';
import {
  computeSimilarity,
  detectContradictions,
  extractCategory,
  extractFiles,
} from './contradiction.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeObs(overrides: Partial<MemoryObservationRow> = {}): MemoryObservationRow {
  return {
    id: 1,
    type: 'discovery',
    title: 'security: SQL injection',
    content: '[CRITICAL] security\nFile: src/auth.ts:42\nIssue: SQL injection detected',
    filePaths: ['src/auth.ts'],
    severity: 'critical',
    ...overrides,
  };
}

// ─── extractCategory ────────────────────────────────────────────

describe('extractCategory', () => {
  it('extracts category from standard content format', () => {
    const obs = makeObs({ content: '[CRITICAL] security\nFile: src/auth.ts' });
    expect(extractCategory(obs)).toBe('security');
  });

  it('falls back to observation type when format is non-standard', () => {
    const obs = makeObs({ content: 'some random content', type: 'bugfix' });
    expect(extractCategory(obs)).toBe('bugfix');
  });

  it('handles empty content gracefully', () => {
    const obs = makeObs({ content: '', type: 'pattern' });
    expect(extractCategory(obs)).toBe('pattern');
  });
});

// ─── extractFiles ───────────────────────────────────────────────

describe('extractFiles', () => {
  it('returns filePaths when available', () => {
    const obs = makeObs({ filePaths: ['src/db.ts', 'src/auth.ts'] });
    expect(extractFiles(obs)).toEqual(['src/db.ts', 'src/auth.ts']);
  });

  it('parses file from content when filePaths is null', () => {
    const obs = makeObs({ filePaths: null, content: '[HIGH] bug\nFile: src/core.ts:10\nIssue: x' });
    expect(extractFiles(obs)).toEqual(['src/core.ts']);
  });

  it('returns empty array when no file info available', () => {
    const obs = makeObs({ filePaths: null, content: 'no file info here' });
    expect(extractFiles(obs)).toEqual([]);
  });

  it('returns empty array for empty filePaths', () => {
    const obs = makeObs({ filePaths: [] });
    // Falls back to content parsing
    expect(extractFiles(obs)).toEqual(['src/auth.ts']);
  });
});

// ─── computeSimilarity ──────────────────────────────────────────

describe('computeSimilarity', () => {
  it('returns 1.0 for identical observations', () => {
    const a = makeObs();
    const b = makeObs({ id: 2 });
    expect(computeSimilarity(a, b)).toBe(1.0);
  });

  it('returns 0.6 for same file different category', () => {
    const a = makeObs({ content: '[HIGH] security\nFile: x' });
    const b = makeObs({ content: '[HIGH] performance\nFile: x', id: 2 });
    expect(computeSimilarity(a, b)).toBe(0.6);
  });

  it('returns 0.4 for same category different file', () => {
    const a = makeObs({ filePaths: ['a.ts'] });
    const b = makeObs({ filePaths: ['b.ts'], id: 2 });
    expect(computeSimilarity(a, b)).toBe(0.4);
  });

  it('returns 0 for completely different observations', () => {
    const a = makeObs({ filePaths: ['a.ts'], content: '[HIGH] security\nFile: a.ts' });
    const b = makeObs({
      id: 2,
      filePaths: ['b.ts'],
      content: '[LOW] performance\nFile: b.ts',
    });
    expect(computeSimilarity(a, b)).toBe(0);
  });
});

// ─── detectContradictions ───────────────────────────────────────

describe('detectContradictions', () => {
  it('returns empty array when no observations overlap', () => {
    const source = [makeObs({ filePaths: ['a.ts'] })];
    const target = [
      makeObs({ id: 2, filePaths: ['b.ts'], content: '[HIGH] performance\nFile: b.ts' }),
    ];
    expect(detectContradictions(source, target)).toEqual([]);
  });

  it('detects contradiction for same file and category with different severity', () => {
    const source = [makeObs({ severity: 'critical' })];
    const target = [makeObs({ id: 2, severity: 'low' })];
    const result = detectContradictions(source, target);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toContain('conflicting severity');
    expect(result[0]?.reason).toContain('critical');
    expect(result[0]?.reason).toContain('low');
  });

  it('detects contradiction for same area with different content', () => {
    const source = [
      makeObs({
        content: '[CRITICAL] security\nFile: src/auth.ts\nIssue: Use prepared statements',
      }),
    ];
    const target = [
      makeObs({
        id: 2,
        content: '[CRITICAL] security\nFile: src/auth.ts\nIssue: Raw SQL is fine here',
      }),
    ];
    const result = detectContradictions(source, target);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toContain('different findings');
  });

  it('respects configurable threshold', () => {
    // These share the same file but different categories → similarity = 0.6
    const source = [
      makeObs({
        filePaths: ['src/auth.ts'],
        content: '[HIGH] security\nFile: src/auth.ts\nIssue: A',
        severity: 'high',
      }),
    ];
    const target = [
      makeObs({
        id: 2,
        filePaths: ['src/auth.ts'],
        content: '[LOW] performance\nFile: src/auth.ts\nIssue: B',
        severity: 'low',
      }),
    ];

    // High threshold (0.99) — similarity 0.6 is below → no contradictions
    const strict: VersioningConfig = { contradictionThreshold: 0.99 };
    expect(detectContradictions(source, target, strict)).toEqual([]);

    // Low threshold (0.3) — similarity 0.6 is above → contradiction detected
    const loose: VersioningConfig = { contradictionThreshold: 0.3 };
    expect(detectContradictions(source, target, loose)).toHaveLength(1);
  });

  it('handles empty observation arrays', () => {
    expect(detectContradictions([], [])).toEqual([]);
    expect(detectContradictions([makeObs()], [])).toEqual([]);
    expect(detectContradictions([], [makeObs()])).toEqual([]);
  });

  it('finds multiple contradictions across observations', () => {
    const source = [
      makeObs({ id: 1, filePaths: ['a.ts'], severity: 'critical' }),
      makeObs({
        id: 2,
        filePaths: ['b.ts'],
        severity: 'high',
        content: '[HIGH] security\nFile: b.ts\nIssue: problem',
      }),
    ];
    const target = [
      makeObs({ id: 3, filePaths: ['a.ts'], severity: 'low' }),
      makeObs({
        id: 4,
        filePaths: ['b.ts'],
        severity: 'low',
        content: '[LOW] security\nFile: b.ts\nIssue: no problem',
      }),
    ];
    const result = detectContradictions(source, target);
    expect(result).toHaveLength(2);
  });
});
