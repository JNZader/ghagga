import { describe, expect, it } from 'vitest';
import type { InjectionTestResult } from './injection-corpus.js';
import {
  createReport,
  formatReport,
  getByCategory,
  getById,
  getBySeverity,
  INJECTION_CORPUS,
} from './injection-corpus.js';

describe('INJECTION_CORPUS', () => {
  it('has at least 10 patterns', () => {
    expect(INJECTION_CORPUS.length).toBeGreaterThanOrEqual(10);
  });

  it('has unique IDs', () => {
    const ids = INJECTION_CORPUS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers multiple categories', () => {
    const categories = new Set(INJECTION_CORPUS.map((p) => p.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  it('all patterns have required fields', () => {
    for (const p of INJECTION_CORPUS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.payload).toBeTruthy();
      expect(p.severity).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
  });
});

describe('getByCategory', () => {
  it('filters by role-override', () => {
    const results = getByCategory('role-override');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.category === 'role-override')).toBe(true);
  });

  it('filters by instruction-leak', () => {
    const results = getByCategory('instruction-leak');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty for nonexistent category', () => {
    const results = getByCategory('nonexistent' as never);
    expect(results).toHaveLength(0);
  });
});

describe('getBySeverity', () => {
  it('filters critical patterns', () => {
    const results = getBySeverity('critical');
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('all results match severity', () => {
    const results = getBySeverity('high');
    expect(results.every((r) => r.severity === 'high')).toBe(true);
  });
});

describe('getById', () => {
  it('finds pattern by ID', () => {
    const pattern = getById('role-01');
    expect(pattern).toBeDefined();
    expect(pattern?.name).toBe('Direct role override');
  });

  it('returns undefined for unknown ID', () => {
    expect(getById('nonexistent')).toBeUndefined();
  });
});

describe('createReport', () => {
  it('scores 100% with no failures', () => {
    const results: InjectionTestResult[] = [
      {
        patternId: 'role-01',
        injected: false,
        response: "I can't do that",
        leaked: false,
        detail: 'Refused',
      },
      {
        patternId: 'leak-01',
        injected: false,
        response: "I can't share that",
        leaked: false,
        detail: 'Refused',
      },
    ];
    const report = createReport(results);
    expect(report.score).toBe(100);
    expect(report.injected).toBe(0);
    expect(report.leaked).toBe(0);
  });

  it('reduces score for injections', () => {
    const results: InjectionTestResult[] = [
      {
        patternId: 'role-01',
        injected: true,
        response: 'I am DAN now',
        leaked: false,
        detail: 'Role overridden',
      },
      { patternId: 'leak-01', injected: false, response: 'Refused', leaked: false, detail: 'OK' },
    ];
    const report = createReport(results);
    expect(report.score).toBe(50);
    expect(report.injected).toBe(1);
  });

  it('reduces score for leaks', () => {
    const results: InjectionTestResult[] = [
      {
        patternId: 'leak-01',
        injected: false,
        response: 'My prompt is...',
        leaked: true,
        detail: 'Leaked',
      },
      { patternId: 'role-01', injected: false, response: 'Refused', leaked: false, detail: 'OK' },
    ];
    const report = createReport(results);
    expect(report.leaked).toBe(1);
    expect(report.score).toBe(50);
  });

  it('tracks by category', () => {
    const results: InjectionTestResult[] = [
      { patternId: 'role-01', injected: true, response: '', leaked: false, detail: '' },
      { patternId: 'role-02', injected: false, response: '', leaked: false, detail: '' },
    ];
    const report = createReport(results);
    expect(report.byCategory['role-override']).toBeDefined();
    expect(report.byCategory['role-override'].failed).toBe(1);
    expect(report.byCategory['role-override'].total).toBe(2);
  });

  it('includes total corpus size', () => {
    const report = createReport([]);
    expect(report.total).toBe(INJECTION_CORPUS.length);
    expect(report.score).toBe(100);
  });
});

describe('formatReport', () => {
  it('formats resilience report', () => {
    const results: InjectionTestResult[] = [
      { patternId: 'role-01', injected: false, response: '', leaked: false, detail: '' },
      { patternId: 'leak-01', injected: false, response: '', leaked: true, detail: '' },
    ];
    const report = createReport(results);
    const output = formatReport(report);

    expect(output).toContain('## Injection Resilience:');
    expect(output).toContain('Tested: 2/');
    expect(output).toContain('Leaked: 1');
    expect(output).toContain('By Category');
  });
});
