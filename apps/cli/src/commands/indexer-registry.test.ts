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
import { dirname, join } from 'node:path';
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

/** Find an entry in INDEXER_REGISTRY covering `language`, asserting it exists. */
function requireEntry(language: string) {
  const entry = INDEXER_REGISTRY.find((e) => e.languages.includes(language as never));
  if (!entry) throw new Error(`no registry entry for ${language}`);
  return entry;
}

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

describe('INDEXER_REGISTRY — Tier B mature languages', () => {
  it('contains a TS/JS entry backed by scip-typescript', () => {
    const ts = requireEntry('typescript');
    expect(ts.bin).toBe('scip-typescript');
    expect(ts.languages).toEqual(['typescript', 'javascript']);
    expect(ts.markers).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
    expect(ts.maturity).toBe('stable');
    expect(typeof ts.installHint).toBe('string');
  });

  it('contains a Python entry backed by scip-python', () => {
    const py = requireEntry('python');
    expect(py.bin).toBe('scip-python');
    expect(py.languages).toEqual(['python']);
    expect(py.markers).toEqual(
      expect.arrayContaining(['pyproject.toml', 'requirements.txt', 'setup.py']),
    );
    expect(py.maturity).toBe('stable');
  });

  it('contains a Rust entry backed by rust-analyzer', () => {
    const rust = requireEntry('rust');
    expect(rust.bin).toBe('rust-analyzer');
    expect(rust.languages).toEqual(['rust']);
    expect(rust.markers).toEqual(expect.arrayContaining(['Cargo.toml']));
    expect(rust.maturity).toBe('stable');
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

  it('detects TS/JS via package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('typescript'))).toBe(true);
  });

  it('does not duplicate the TS/JS entry when both package.json and tsconfig.json are present', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const detected = detectPresentLanguages(dir).filter((e) => e.languages.includes('typescript'));
    expect(detected).toHaveLength(1);
  });

  it('detects Python via pyproject.toml', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('python'))).toBe(true);
  });

  it('detects Python via requirements.txt', () => {
    writeFileSync(join(dir, 'requirements.txt'), '');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('python'))).toBe(true);
  });

  it('detects Rust via Cargo.toml', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('rust'))).toBe(true);
  });

  it('detects a poly-language repo with Go, TS, Python, and Rust markers all present', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const detected = detectPresentLanguages(dir);
    const languages = new Set(detected.flatMap((e) => e.languages));
    expect(languages.has('go')).toBe(true);
    expect(languages.has('typescript')).toBe(true);
    expect(languages.has('python')).toBe(true);
    expect(languages.has('rust')).toBe(true);
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

describe('tsEntry.run (real fs, mocked execFileSync)', () => {
  const tsEntry = requireEntry('typescript');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir and writes directly to it via --output', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-typescript');
    // The mock does NOT create the isolated dir — scip-typescript writes
    // straight to --output but requires the parent to pre-exist (verified live:
    // ENOENT otherwise). So this writeFileSync only succeeds if production's own
    // mkdirSync(dirname(outPath)) ran first. Delete that production line and
    // this test fails — the real R1-001 regression guard, not a papered mock.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(expectedOutPath, 'fake-scip-index');
      return Buffer.from('');
    });

    // .ghagga/scip/ must NOT pre-exist going in — that's the point of the guard.
    expect(existsSync(dirname(expectedOutPath))).toBe(false);
    const result = tsEntry.run(dir);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'scip-typescript',
      expect.arrayContaining(['index', '--output', expectedOutPath]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if scip-typescript does not produce an index at the isolated path', () => {
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => tsEntry.run(dir)).toThrow(/did not produce an index/);
  });
});

describe('pythonEntry.run (real fs, mocked execFileSync)', () => {
  const pythonEntry = requireEntry('python');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir and writes directly to it via --output', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-python');
    // Mock does NOT create the dir — production's mkdirSync must run first, or
    // this writeFileSync throws ENOENT. Real regression guard for R1-001.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(expectedOutPath, 'fake-scip-index');
      return Buffer.from('');
    });

    expect(existsSync(dirname(expectedOutPath))).toBe(false);
    const result = pythonEntry.run(dir);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
  });

  it('throws if scip-python does not produce an index at the isolated path', () => {
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => pythonEntry.run(dir)).toThrow(/did not produce an index/);
  });
});

describe('rustEntry.run (real fs, mocked execFileSync)', () => {
  const rustEntry = requireEntry('rust');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir and writes directly to it via --output', () => {
    const expectedOutPath = scipOutputPath(dir, 'rust-analyzer');
    // Mock does NOT create the dir — production's mkdirSync must run first, or
    // this writeFileSync throws ENOENT. Real regression guard for R1-001.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(expectedOutPath, 'fake-scip-index');
      return Buffer.from('');
    });

    expect(existsSync(dirname(expectedOutPath))).toBe(false);
    const result = rustEntry.run(dir);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'rust-analyzer',
      expect.arrayContaining(['scip', dir, '--output', expectedOutPath]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if rust-analyzer does not produce an index at the isolated path', () => {
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => rustEntry.run(dir)).toThrow(/did not produce an index/);
  });
});
