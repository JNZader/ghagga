/**
 * Tests for the per-language SCIP indexer registry (D1) and marker-file
 * language detection (spec "Language Detection").
 *
 * Mocked: `execFileSync` (toolchain checks/`run` under the hood) — no real
 * toolchains are ever invoked. `detectPresentLanguages` only touches the
 * filesystem (marker files), so it's tested against a real temp dir.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import {
  DEFAULT_MARKER_DEPTH,
  detectMarkerDirectories,
  detectPresentLanguages,
  INDEXER_REGISTRY,
  scipOutputPath,
} from './indexer-registry.js';

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

describe('INDEXER_REGISTRY — Tier C/D heavy + experimental languages', () => {
  it('contains a Java+Kotlin entry backed by scip-java (shared indexer)', () => {
    const java = requireEntry('java');
    expect(java.bin).toBe('scip-java');
    expect(java.languages).toEqual(['java', 'kotlin']);
    expect(java.markers).toEqual(
      expect.arrayContaining(['pom.xml', 'build.gradle', 'build.gradle.kts']),
    );
    expect(java.maturity).toBe('heavy');
    expect(typeof java.installHint).toBe('string');
    // Same entry object covers both languages — not two separate entries.
    const kotlin = requireEntry('kotlin');
    expect(kotlin).toBe(java);
  });

  it('contains a C# entry backed by scip-dotnet', () => {
    const csharp = requireEntry('csharp');
    expect(csharp.bin).toBe('scip-dotnet');
    expect(csharp.languages).toEqual(['csharp']);
    expect(csharp.markers).toEqual(expect.arrayContaining(['*.csproj', '*.sln']));
    expect(csharp.maturity).toBe('experimental');
  });

  it('contains a PHP entry backed by scip-php', () => {
    const php = requireEntry('php');
    expect(php.bin).toBe('scip-php');
    expect(php.languages).toEqual(['php']);
    expect(php.markers).toEqual(expect.arrayContaining(['composer.json']));
    expect(php.maturity).toBe('experimental');
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

  it('detects Java+Kotlin via pom.xml', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project></project>\n');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('java'))).toBe(true);
    expect(detected.some((e) => e.languages.includes('kotlin'))).toBe(true);
  });

  it('detects Java+Kotlin via build.gradle.kts', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), '');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('java'))).toBe(true);
  });

  it('does not duplicate the Java entry when both pom.xml and build.gradle are present', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project></project>\n');
    writeFileSync(join(dir, 'build.gradle'), '');
    const detected = detectPresentLanguages(dir).filter((e) => e.languages.includes('java'));
    expect(detected).toHaveLength(1);
  });

  it('detects C# via a glob marker on *.csproj (no fixed filename)', () => {
    writeFileSync(join(dir, 'MyApp.csproj'), '<Project></Project>\n');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('csharp'))).toBe(true);
  });

  it('detects C# via a glob marker on *.sln', () => {
    writeFileSync(join(dir, 'MyApp.sln'), '');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('csharp'))).toBe(true);
  });

  it('does not detect C# when no *.csproj/*.sln file is present', () => {
    writeFileSync(join(dir, 'notes.txt'), 'csproject but not a marker\n');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('csharp'))).toBe(false);
  });

  it('detects PHP via composer.json', () => {
    writeFileSync(join(dir, 'composer.json'), '{}');
    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('php'))).toBe(true);
  });
});

describe('detectMarkerDirectories', () => {
  /** Build nested subdirectories `dir/segs[0]/segs[1]/...` and return the leaf path. */
  function nestedDir(segs: string[]): string {
    let cur = dir;
    for (const seg of segs) {
      cur = join(cur, seg);
      mkdirSync(cur, { recursive: true });
    }
    return cur;
  }

  it('finds a marker at repo root (depth 0) — no regression vs detectPresentLanguages', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const pairs = detectMarkerDirectories(dir);
    const tsPairs = pairs.filter((p) => p.entry.languages.includes('typescript'));
    expect(tsPairs).toHaveLength(1);
    expect(tsPairs[0]?.dir).toBe(dir);
  });

  it('finds a nested-only marker (no root-level marker present)', () => {
    const backend = nestedDir(['apps', 'backend']);
    writeFileSync(join(backend, 'go.mod'), 'module example.com/x\n');

    const pairs = detectMarkerDirectories(dir);
    const goPairs = pairs.filter((p) => p.entry.languages.includes('go'));
    expect(goPairs).toHaveLength(1);
    expect(goPairs[0]?.dir).toBe(backend);
  });

  it('respects the default depth bound: a marker at depth 4 is found, at depth 5 is not', () => {
    expect(DEFAULT_MARKER_DEPTH).toBe(4);

    const atDepth4 = nestedDir(['l1', 'l2', 'l3', 'l4']);
    writeFileSync(join(atDepth4, 'go.mod'), 'module x\n');

    const atDepth5 = nestedDir(['m1', 'm2', 'm3', 'm4', 'm5']);
    writeFileSync(join(atDepth5, 'Cargo.toml'), '[package]\nname = "x"\n');

    const pairs = detectMarkerDirectories(dir);
    const goPairs = pairs.filter((p) => p.entry.languages.includes('go'));
    const rustPairs = pairs.filter((p) => p.entry.languages.includes('rust'));

    expect(goPairs).toHaveLength(1);
    expect(goPairs[0]?.dir).toBe(atDepth4);
    expect(rustPairs).toHaveLength(0);
  });

  it('an explicit maxDepth override is honored', () => {
    const atDepth2 = nestedDir(['a', 'b']);
    writeFileSync(join(atDepth2, 'go.mod'), 'module x\n');

    expect(detectMarkerDirectories(dir, { maxDepth: 1 })).toHaveLength(0);
    expect(detectMarkerDirectories(dir, { maxDepth: 2 })).toHaveLength(1);
  });

  it('skips EXCLUDED_DIRS additions (.tools) even well within the depth bound', () => {
    const toolsSub = nestedDir(['.tools', 'codeql']);
    writeFileSync(join(toolsSub, 'go.mod'), 'module x\n');

    const pairs = detectMarkerDirectories(dir);
    expect(pairs).toHaveLength(0);
  });

  it('skips .ghagga and .worktrees too', () => {
    writeFileSync(join(nestedDir(['.ghagga']), 'package.json'), '{}');
    writeFileSync(join(nestedDir(['.worktrees', 'wt1']), 'package.json'), '{}');

    const pairs = detectMarkerDirectories(dir);
    expect(pairs).toHaveLength(0);
  });

  it('same language present in two different subdirectories yields two distinct pairs', () => {
    const mlService = nestedDir(['apps', 'ml-service']);
    const aiAssistant = nestedDir(['services', 'ai-assistant']);
    writeFileSync(join(mlService, 'pyproject.toml'), '[project]\nname = "a"\n');
    writeFileSync(join(aiAssistant, 'pyproject.toml'), '[project]\nname = "b"\n');

    const pairs = detectMarkerDirectories(dir);
    const pyPairs = pairs.filter((p) => p.entry.languages.includes('python'));
    expect(pyPairs).toHaveLength(2);
    const dirs = pyPairs.map((p) => p.dir).sort();
    expect(dirs).toEqual([aiAssistant, mlService].sort());
  });

  it('finds a glob marker (*.csproj) nested in a subdirectory', () => {
    const backend = nestedDir(['src', 'Backend']);
    writeFileSync(join(backend, 'Backend.csproj'), '<Project></Project>\n');

    const pairs = detectMarkerDirectories(dir);
    const csharpPairs = pairs.filter((p) => p.entry.languages.includes('csharp'));
    expect(csharpPairs).toHaveLength(1);
    expect(csharpPairs[0]?.dir).toBe(backend);
  });

  it('deduplicates: does not emit the same {entry, dir} pair twice even with multiple matching markers', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    const pairs = detectMarkerDirectories(dir);
    const tsPairs = pairs.filter((p) => p.entry.languages.includes('typescript'));
    expect(tsPairs).toHaveLength(1);
  });

  it('a poly-language repo with both a root marker and a nested marker yields both pairs', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const backend = nestedDir(['apps', 'backend']);
    writeFileSync(join(backend, 'go.mod'), 'module x\n');

    const pairs = detectMarkerDirectories(dir);
    expect(pairs.some((p) => p.entry.languages.includes('typescript') && p.dir === dir)).toBe(true);
    expect(pairs.some((p) => p.entry.languages.includes('go') && p.dir === backend)).toBe(true);
  });

  it('returns [] for an empty/unreadable directory (no throw)', () => {
    expect(detectMarkerDirectories(dir)).toEqual([]);
  });
});

describe('detectPresentLanguages as a depth-0 wrapper over detectMarkerDirectories', () => {
  it('still ignores nested-only markers (root-scope only, unchanged Tier A behavior)', () => {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'package.json'), '{}');
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');

    const detected = detectPresentLanguages(dir);
    expect(detected.some((e) => e.languages.includes('go'))).toBe(true);
    expect(detected.some((e) => e.languages.includes('typescript'))).toBe(false);
  });
});

describe('goEntry.run (real fs, mocked execFileSync)', () => {
  const goEntry = INDEXER_REGISTRY.find((entry) => entry.bin === 'scip-go');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir on a fresh repo (regression guard for R1-001: fails before the mkdirSync fix, passes after)', () => {
    const outPath = scipOutputPath(dir, 'scip-go');
    // Simulate scip-go writing `index.scip` at the repo root, as the real
    // binary does — no native --output flag.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fake-scip-index');
      return Buffer.from('');
    });

    expect(goEntry).toBeDefined();
    // .ghagga/scip/ must NOT pre-exist — that's the whole point of the guard.
    // The dispatcher passes `outPath` explicitly — this mock does NOT
    // pre-create it (hardened regression guard, not a papered mock).
    const result = goEntry?.run(dir, outPath);

    expect(result).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('removes a stale pre-existing root index.scip before running, so it cannot leak into the output', () => {
    const outPath = scipOutputPath(dir, 'scip-go');
    writeFileSync(join(dir, 'index.scip'), 'stale-from-a-prior-manual-run');

    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fresh-scip-index');
      return Buffer.from('');
    });

    const result = goEntry?.run(dir, outPath);

    expect(result).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('writes to a dispatcher-disambiguated outPath distinct from the default scipOutputPath(dir, bin)', () => {
    const disambiguatedPath = join(dir, '.ghagga', 'scip', 'scip-go__apps_backend.scip');
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fake-scip-index');
      return Buffer.from('');
    });

    const result = goEntry?.run(dir, disambiguatedPath);

    expect(result).toBe(disambiguatedPath);
    expect(existsSync(disambiguatedPath)).toBe(true);
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
    const result = tsEntry.run(dir, expectedOutPath);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'scip-typescript',
      expect.arrayContaining(['index', '--output', expectedOutPath]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if scip-typescript does not produce an index at the passed outPath', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-typescript');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => tsEntry.run(dir, expectedOutPath)).toThrow(/did not produce an index/);
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
    const result = pythonEntry.run(dir, expectedOutPath);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
  });

  it('throws if scip-python does not produce an index at the passed outPath', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-python');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => pythonEntry.run(dir, expectedOutPath)).toThrow(/did not produce an index/);
  });

  it('two runs of pythonEntry against distinct dispatcher-chosen outPaths do not clobber each other (D3 collision guard)', () => {
    const mlServiceOut = join(dir, '.ghagga', 'scip', 'scip-python__apps_ml-service.scip');
    const aiAssistantOut = join(dir, '.ghagga', 'scip', 'scip-python__services_ai-assistant.scip');

    execFileSyncMock.mockImplementationOnce(() => {
      writeFileSync(mlServiceOut, 'ml-service-index');
      return Buffer.from('');
    });
    const firstResult = pythonEntry.run(dir, mlServiceOut);

    execFileSyncMock.mockImplementationOnce(() => {
      writeFileSync(aiAssistantOut, 'ai-assistant-index');
      return Buffer.from('');
    });
    const secondResult = pythonEntry.run(dir, aiAssistantOut);

    expect(firstResult).toBe(mlServiceOut);
    expect(secondResult).toBe(aiAssistantOut);
    expect(existsSync(mlServiceOut)).toBe(true);
    expect(existsSync(aiAssistantOut)).toBe(true);
    expect(readFileSync(mlServiceOut, 'utf-8')).toBe('ml-service-index');
    expect(readFileSync(aiAssistantOut, 'utf-8')).toBe('ai-assistant-index');
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
    const result = rustEntry.run(dir, expectedOutPath);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'rust-analyzer',
      expect.arrayContaining(['scip', dir, '--output', expectedOutPath]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if rust-analyzer does not produce an index at the passed outPath', () => {
    const expectedOutPath = scipOutputPath(dir, 'rust-analyzer');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => rustEntry.run(dir, expectedOutPath)).toThrow(/did not produce an index/);
  });
});

describe('javaEntry.run (real fs, mocked execFileSync)', () => {
  const javaEntry = requireEntry('java');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir and writes directly to it via --output', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-java');
    // Mock does NOT create the dir — production's mkdirSync must run first, or
    // this writeFileSync throws ENOENT. Real regression guard for R1-001.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(expectedOutPath, 'fake-scip-index');
      return Buffer.from('');
    });

    expect(existsSync(dirname(expectedOutPath))).toBe(false);
    const result = javaEntry.run(dir, expectedOutPath);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'scip-java',
      expect.arrayContaining(['index', '--output', expectedOutPath]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if scip-java does not produce an index at the passed outPath', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-java');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => javaEntry.run(dir, expectedOutPath)).toThrow(/did not produce an index/);
  });
});

describe('csharpEntry.run (real fs, mocked execFileSync)', () => {
  const csharpEntry = requireEntry('csharp');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir and writes directly to it via --output', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-dotnet');
    // Mock does NOT create the dir — production's mkdirSync must run first, or
    // this writeFileSync throws ENOENT. Real regression guard for R1-001.
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(expectedOutPath, 'fake-scip-index');
      return Buffer.from('');
    });

    expect(existsSync(dirname(expectedOutPath))).toBe(false);
    const result = csharpEntry.run(dir, expectedOutPath);

    expect(result).toBe(expectedOutPath);
    expect(existsSync(expectedOutPath)).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'scip-dotnet',
      expect.arrayContaining(['index', '--output', expectedOutPath, '--working-directory', dir]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('throws if scip-dotnet does not produce an index at the passed outPath', () => {
    const expectedOutPath = scipOutputPath(dir, 'scip-dotnet');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => csharpEntry.run(dir, expectedOutPath)).toThrow(/did not produce an index/);
  });
});

describe('phpEntry.run (real fs, mocked execFileSync)', () => {
  const phpEntry = requireEntry('php');

  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it('creates the isolated .ghagga/scip/ output dir on a fresh repo (run-then-move, no native --output)', () => {
    const outPath = scipOutputPath(dir, 'scip-php');
    // Simulate scip-php writing `index.scip` at the repo root, as the real
    // binary does — no --output flag (verified against upstream source).
    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fake-scip-index');
      return Buffer.from('');
    });

    const result = phpEntry.run(dir, outPath);

    expect(result).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    // The root-level index.scip must have been moved, not left behind.
    expect(existsSync(join(dir, 'index.scip'))).toBe(false);
  });

  it('removes a stale pre-existing root index.scip before running, so it cannot leak into the output', () => {
    const outPath = scipOutputPath(dir, 'scip-php');
    writeFileSync(join(dir, 'index.scip'), 'stale-from-a-prior-manual-run');

    execFileSyncMock.mockImplementation(() => {
      writeFileSync(join(dir, 'index.scip'), 'fresh-scip-index');
      return Buffer.from('');
    });

    const result = phpEntry.run(dir, outPath);

    expect(result).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });

  it('throws if scip-php does not produce an index.scip at its cwd', () => {
    const outPath = scipOutputPath(dir, 'scip-php');
    execFileSyncMock.mockImplementation(() => Buffer.from(''));
    expect(() => phpEntry.run(dir, outPath)).toThrow(/did not produce an index/);
  });
});
