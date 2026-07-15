/**
 * Tests for the per-language SCIP indexer registry (D1) and marker-file
 * language detection (spec "Language Detection").
 *
 * Mocked: `execFileSync` (toolchain checks/`run` under the hood) — no real
 * toolchains are ever invoked. `detectPresentLanguages` only touches the
 * filesystem (marker files), so it's tested against a real temp dir.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only `execFileSync` — everything else (fs, path) stays real so
// `goEntry.run()` exercises its actual mkdir/rm/rename behavior against a
// real temp dir (that's the whole point of this suite: catching R1-001,
// which no mock-fs test caught).
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

import { detectPresentLanguages, INDEXER_REGISTRY, scipOutputPath } from './indexer-registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghagga-indexer-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('INDEXER_REGISTRY', () => {
  it('contains exactly one entry for Go, refactored into IndexerEntry shape', () => {
    const goEntries = INDEXER_REGISTRY.filter((entry) => entry.languages.includes('go'));
    expect(goEntries).toHaveLength(1);
    const go = goEntries[0];
    expect(go).toBeDefined();
    expect(go?.bin).toBe('scip-go');
    expect(go?.markers).toContain('go.mod');
    expect(typeof go?.toolchainCheck).toBe('function');
    expect(typeof go?.run).toBe('function');
    expect(typeof go?.installHint).toBe('string');
    expect(go?.maturity).toBe('stable');
  });
});

describe('detectPresentLanguages', () => {
  it('detects Go via go.mod', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    const detected = detectPresentLanguages(dir);
    const goEntries = detected.filter((entry) => entry.languages.includes('go'));
    expect(goEntries).toHaveLength(1);
  });

  it('detects nothing in an empty directory', () => {
    const detected = detectPresentLanguages(dir);
    expect(detected).toEqual([]);
  });

  it('detects multiple languages present in a poly-language repo', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'package.json'), '{}');

    const detected = detectPresentLanguages(dir);
    // detectPresentLanguages checks marker files at repoPath root only (D-scope
    // for Tier A) — package.json in a subdir is out of scope for this test,
    // this only exercises root-level detection.
    const goEntries = detected.filter((entry) => entry.languages.includes('go'));
    expect(goEntries).toHaveLength(1);
  });

  it('does not duplicate an entry if multiple of its markers are present', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    const detected = detectPresentLanguages(dir);
    expect(detected).toHaveLength(detected.length);
    const goEntries = detected.filter((entry) => entry.languages.includes('go'));
    expect(goEntries).toHaveLength(1);
  });
});

describe('goEntry.run (real fs, mocked execFileSync)', () => {
  const goEntry = INDEXER_REGISTRY.find((entry) => entry.bin === 'scip-go');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir on a fresh repo (regression guard for R1-001: fails before the mkdirSync fix, passes after)', () => {
    // Simulate scip-go writing `index.scip` at the repo root, as the real
    // binary does — no native --output flag.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fake-scip-index');
      return Buffer.from('');
    });

    expect(goEntry).toBeDefined();
    // .ghagga/scip/ must NOT pre-exist — that's the whole point of the guard.
    const result = goEntry?.run(dir);

    const expectedOutPath = scipOutputPath(dir, 'scip-go');
    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
  });

  it('removes a stale pre-existing root index.scip before running, so it cannot leak into the output', () => {
    writeFileSync(join(dir, 'index.scip'), 'stale-from-a-prior-manual-run');

    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fresh-scip-index');
      return Buffer.from('');
    });

    const result = goEntry?.run(dir);

    const expectedOutPath = scipOutputPath(dir, 'scip-go');
    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
  });
});
