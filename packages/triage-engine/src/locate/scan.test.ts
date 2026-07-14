import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreCandidates, walkCodeScope } from './scan.js';

describe('scoreCandidates (pure)', () => {
  it('returns [] when there are no hits', () => {
    const files = new Map([['a.go', 'package foo\n']]);
    expect(scoreCandidates(files, ['nomatch'])).toEqual([]);
  });

  it('returns [] for empty keywords or empty file pool', () => {
    expect(scoreCandidates(new Map(), ['x'])).toEqual([]);
    expect(scoreCandidates(new Map([['a.go', 'x']]), [])).toEqual([]);
  });

  it('ranks a file NAMED after a keyword above one that merely mentions it (filename boost)', () => {
    const files = new Map([
      ['internal/threshold.go', 'package internal\n\nfunc Check() bool { return true }\n'],
      ['internal/other.go', 'package internal\n\n// mentions threshold once\nfunc X() {}\n'],
    ]);
    const result = scoreCandidates(files, ['threshold']);
    expect(result[0]?.path).toBe('internal/threshold.go');
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
  });

  it('tf-idf orders files by keyword hit density', () => {
    const files = new Map([
      ['a.go', 'alert alert alert'],
      ['b.go', 'alert'],
      ['c.go', 'nothing here'],
    ]);
    const result = scoreCandidates(files, ['alert']);
    expect(result.map((r) => r.path)).toEqual(['a.go', 'b.go']);
  });

  it('caps results at `limit`', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 20; i++) files.set(`f${i}.go`, 'alert');
    const result = scoreCandidates(files, ['alert'], 5);
    expect(result).toHaveLength(5);
  });
});

describe('walkCodeScope (filesystem)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'triage-scan-'));
    mkdirSync(path.join(root, 'internal'), { recursive: true });
    mkdirSync(path.join(root, 'internal', 'node_modules'), { recursive: true });
    writeFileSync(path.join(root, 'internal', 'alerts.go'), 'package internal\n');
    writeFileSync(path.join(root, 'internal', 'alerts_test.go'), 'package internal\n');
    writeFileSync(path.join(root, 'internal', 'node_modules', 'noise.go'), 'package noise\n');
    writeFileSync(path.join(root, 'internal', 'readme.md'), 'not code\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks the configured scope, filtering by language extension', () => {
    const files = walkCodeScope(root, ['internal'], 'go');
    expect([...files.keys()]).toContain('internal/alerts.go');
    expect([...files.keys()]).not.toContain('internal/readme.md');
  });

  it('excludes test files', () => {
    const files = walkCodeScope(root, ['internal'], 'go');
    expect([...files.keys()]).not.toContain('internal/alerts_test.go');
  });

  it('excludes noise directories (node_modules etc.)', () => {
    const files = walkCodeScope(root, ['internal'], 'go');
    expect([...files.keys()]).not.toContain('internal/node_modules/noise.go');
  });

  it('returns an empty map for a nonexistent dir (no throw)', () => {
    expect(() => walkCodeScope(root, ['nope'], 'go')).not.toThrow();
    expect(walkCodeScope(root, ['nope'], 'go').size).toBe(0);
  });
});
