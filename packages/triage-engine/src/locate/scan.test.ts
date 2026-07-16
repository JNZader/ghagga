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

  it('walks a plain directory entry recursively (backward-compat regression guard)', () => {
    mkdirSync(path.join(root, 'internal', 'deep', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'internal', 'deep', 'nested', 'buried.go'), 'package nested\n');
    const files = walkCodeScope(root, ['internal'], 'go');
    expect([...files.keys()]).toContain('internal/deep/nested/buried.go');
    expect([...files.keys()]).toContain('internal/alerts.go');
  });
});

describe('walkCodeScope (glob + file entries)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'triage-glob-'));
    mkdirSync(path.join(root, 'internal', 'sub'), { recursive: true });
    mkdirSync(path.join(root, 'internal', 'node_modules'), { recursive: true });
    // Files a `internal/**/checklist*.go` glob SHOULD match:
    writeFileSync(path.join(root, 'internal', 'checklist.go'), 'package internal\n');
    writeFileSync(path.join(root, 'internal', 'sub', 'checklist_items.go'), 'package sub\n');
    // Siblings / excluded that it must NOT match:
    writeFileSync(path.join(root, 'internal', 'other.go'), 'package internal\n');
    writeFileSync(path.join(root, 'internal', 'checklist_test.go'), 'package internal\n');
    writeFileSync(path.join(root, 'internal', 'node_modules', 'checklist.go'), 'package noise\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('matches only the glob-targeted files, excluding siblings, tests, and node_modules', () => {
    const keys = [...walkCodeScope(root, ['internal/**/checklist*.go'], 'go').keys()];
    expect(keys).toContain('internal/checklist.go');
    expect(keys).toContain('internal/sub/checklist_items.go');
    expect(keys).not.toContain('internal/other.go');
    expect(keys).not.toContain('internal/checklist_test.go');
    expect(keys).not.toContain('internal/node_modules/checklist.go');
    expect(keys).toHaveLength(2);
  });

  it('reads exactly the file named by an explicit single-file entry', () => {
    const files = walkCodeScope(root, ['internal/checklist.go'], 'go');
    expect([...files.keys()]).toEqual(['internal/checklist.go']);
  });

  it('ignores a single-file entry whose extension does not match the language', () => {
    writeFileSync(path.join(root, 'internal', 'notes.md'), 'not code\n');
    expect(walkCodeScope(root, ['internal/notes.md'], 'go').size).toBe(0);
  });

  it('combines a glob entry and a directory entry in one dirs array', () => {
    mkdirSync(path.join(root, 'other'), { recursive: true });
    writeFileSync(path.join(root, 'other', 'thing.go'), 'package other\n');
    const keys = [...walkCodeScope(root, ['internal/**/checklist*.go', 'other'], 'go').keys()];
    expect(keys).toContain('internal/checklist.go');
    expect(keys).toContain('internal/sub/checklist_items.go');
    expect(keys).toContain('other/thing.go');
  });

  it('honors the cap across glob matches', () => {
    // 2 checklist files match; cap=1 stops after the first.
    expect(walkCodeScope(root, ['internal/**/checklist*.go'], 'go', 1).size).toBe(1);
  });
});

describe('walkCodeScope (codeRoot containment)', () => {
  let parent: string;
  let root: string;

  beforeEach(() => {
    // parent/
    //   repo/     <- codeRoot
    //     internal/inside.go
    //   shared/   <- OUTSIDE codeRoot (sibling); must never be read
    //     secret.go
    parent = mkdtempSync(path.join(tmpdir(), 'triage-contain-'));
    root = path.join(parent, 'repo');
    mkdirSync(path.join(root, 'internal'), { recursive: true });
    mkdirSync(path.join(parent, 'shared'), { recursive: true });
    writeFileSync(path.join(root, 'internal', 'inside.go'), 'package internal\n');
    writeFileSync(path.join(parent, 'shared', 'secret.go'), 'package shared\n');
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('skips a glob entry that escapes codeRoot via `..` (containment holds)', () => {
    const keys = [...walkCodeScope(root, ['../shared/**/*.go'], 'go').keys()];
    expect(keys).not.toContain('../shared/secret.go');
    expect(keys).toHaveLength(0);
  });

  it('skips an explicit `../outside.go` file entry (containment holds)', () => {
    const files = walkCodeScope(root, ['../shared/secret.go'], 'go');
    expect(files.size).toBe(0);
  });

  it('still reads legitimate in-tree entries alongside an escaping one', () => {
    const keys = [...walkCodeScope(root, ['internal', '../shared/secret.go'], 'go').keys()];
    expect(keys).toContain('internal/inside.go');
    expect(keys).not.toContain('../shared/secret.go');
  });
});
