/**
 * Tests for `ghagga index` — registry-dispatcher dependency graph indexing.
 *
 * Mocked: `detectMarkerDirectories` (from `./indexer-registry.js`) — the
 * dispatcher tests only exercise detect/availability/degrade/zero-index/
 * merge/output-isolation/cap wiring, mirroring the mocking style of the
 * previous Go-only tests (mocked `toolchainCheck`/`run`, not real
 * toolchains). Per-language mapping correctness is covered separately by
 * `packages/core`'s SCIP mapper fixture tests.
 *
 * Nested marker detection: `detectMarkerDirectories` returns
 * `Array<{entry, dir}>` pairs (not a flat entry list) — the dispatcher runs
 * each pair independently and merges with `pathPrefix = relative(repoPath,
 * dir)`, so tests here exercise per-pair (not just per-language) dispatch.
 */

import { join, resolve } from 'node:path';
import { GRAPH_VERSION } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexerEntry } from './indexer-registry.js';

// ─── Mocks ─────────────────────────────────────────────────────

const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

// `resolveGitHead` shells out via `execFileSync('git', ['rev-parse', 'HEAD'])`.
// Mocked so tests never depend on the real git state of the checkout the
// suite runs in (and to deterministically exercise the non-git fallback).
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

vi.mock('../ui/tui.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

const mockDetectMarkerDirectories = vi.fn();

vi.mock('./indexer-registry.js', async () => {
  const { join: joinPath } = await import('node:path');
  return {
    detectMarkerDirectories: (...args: unknown[]) => mockDetectMarkerDirectories(...args),
    // Real production shape (`.ghagga/scip/<name>.scip`), not mocked away —
    // the dispatcher's output-path-per-run disambiguation is what's under
    // test here, so this must behave like the real helper.
    scipOutputPath: (dir: string, bin: string) => joinPath(dir, '.ghagga', 'scip', `${bin}.scip`),
  };
});

// process.exit throws so we can assert on it without killing the test runner
const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never);

// ─── Imports (after mocks) ──────────────────────────────────────

import * as tui from '../ui/tui.js';
import { indexCommand } from './index-cmd.js';

const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../../../../packages/core/test/fixtures/scip-go-sample',
);
const FIXTURE_SCIP_PATH = join(FIXTURE_DIR, 'index.scip');

/** Minimal typed shape for parsing a serialized `graph.json` in assertions. */
interface ParsedGraphFixture {
  version: number;
  nodes: Record<string, { language: string }>;
}

function parseGraphFixture(contents: unknown): ParsedGraphFixture {
  return JSON.parse(contents as string) as ParsedGraphFixture;
}

function makeEntry(
  overrides: Partial<IndexerEntry> & Pick<IndexerEntry, 'bin' | 'languages'>,
): IndexerEntry {
  return {
    markers: ['some-marker'],
    toolchainCheck: () => true,
    run: () => {
      throw new Error('run() not stubbed for this test');
    },
    installHint: `install ${overrides.bin}`,
    maturity: 'stable',
    ...overrides,
  };
}

describe('indexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('abc123def456\n');
  });

  describe('single detected+available marker directory', () => {
    it('runs the indexer against the marker dir, parses the produced .scip, and writes a valid v1 graph.json', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([{ entry, dir: FIXTURE_DIR }]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledWith(FIXTURE_DIR, expect.stringContaining('scip-go.scip'));
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const [outPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toContain('.ghagga/graph.json');

      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(Object.keys(graph.nodes).length).toBeGreaterThan(0);
      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('per-marker-directory dispatch (Phase 3)', () => {
    it('dispatches one run per {entry, dir} pair, not just once per unique language', async () => {
      const nestedDir = join(FIXTURE_DIR, 'apps', 'backend');
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([
        { entry, dir: FIXTURE_DIR },
        { entry, dir: nestedDir },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(runSpy).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
      expect(runSpy).toHaveBeenCalledWith(nestedDir, expect.any(String));
      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('per-pair degradation (D6)', () => {
    it('missing toolchain: warns once per entry, skips ALL its dirs, continues with the rest', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const availableEntry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      const missingRunSpy = vi.fn();
      const missingEntry = makeEntry({
        bin: 'rust-analyzer',
        languages: ['rust'],
        toolchainCheck: () => false,
        installHint: 'install rust-analyzer via rustup',
        run: missingRunSpy,
      });
      const nestedDir = join(FIXTURE_DIR, 'services');
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: missingEntry, dir: FIXTURE_DIR },
        { entry: missingEntry, dir: nestedDir },
        { entry: availableEntry, dir: FIXTURE_DIR },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalled();
      expect(missingRunSpy).not.toHaveBeenCalled();
      expect(tui.log.warn).toHaveBeenCalled();
      const warnMessages = (tui.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      // Only ONE toolchain-missing warning for the entry, not one per dir.
      const toolchainWarnings = warnMessages.filter(
        (m) => m.includes('rust') && m.includes('rustup'),
      );
      expect(toolchainWarnings).toHaveLength(1);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      expect(tui.log.success).toHaveBeenCalled();
    });

    it('runtime failure in ONE marker directory: warns, skips only that pair, continues with the rest (spec: one Go dir fails, other Go dir + other languages still indexed)', async () => {
      const nestedDir = join(FIXTURE_DIR, 'apps', 'backend-2');
      const goodRun = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const failingRun = vi.fn().mockImplementation(() => {
        throw new Error('scip-go crashed: segfault');
      });
      const goEntry = makeEntry({
        bin: 'scip-go',
        languages: ['go'],
        run: (dir: string, outPath: string) =>
          dir === nestedDir ? failingRun(dir, outPath) : goodRun(dir, outPath),
      });
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: goEntry, dir: FIXTURE_DIR },
        { entry: goEntry, dir: nestedDir },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(goodRun).toHaveBeenCalled();
      expect(failingRun).toHaveBeenCalled();
      expect(tui.log.warn).toHaveBeenCalled();
      const warnMessages = (tui.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(warnMessages.some((m) => m.includes('segfault'))).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('zero indexed', () => {
    it('no --fallback-regex: exits non-zero listing what was tried and why each failed', async () => {
      const missingEntry = makeEntry({
        bin: 'rust-analyzer',
        languages: ['rust'],
        toolchainCheck: () => false,
      });
      const crashingEntry = makeEntry({
        bin: 'scip-php',
        languages: ['php'],
        run: () => {
          throw new Error('boom');
        },
      });
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: missingEntry, dir: FIXTURE_DIR },
        { entry: crashingEntry, dir: FIXTURE_DIR },
      ]);

      await expect(indexCommand(FIXTURE_DIR, {})).rejects.toThrow('process.exit(1)');

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(tui.log.error).toHaveBeenCalled();
      const message = (tui.log.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(message).toContain('rust');
      expect(message).toContain('php');
    });

    it('no detected marker directories at all, no --fallback-regex: exits non-zero', async () => {
      mockDetectMarkerDirectories.mockReturnValue([]);

      await expect(indexCommand(FIXTURE_DIR, {})).rejects.toThrow('process.exit(1)');

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('with --fallback-regex: uses the regex builder and writes graph.json', async () => {
      const missingEntry = makeEntry({
        bin: 'rust-analyzer',
        languages: ['rust'],
        toolchainCheck: () => false,
      });
      mockDetectMarkerDirectories.mockReturnValue([{ entry: missingEntry, dir: FIXTURE_DIR }]);

      await indexCommand(FIXTURE_DIR, { fallbackRegex: true });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const [outPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toContain('.ghagga/graph.json');

      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(tui.log.warn).toHaveBeenCalled();
    });
  });

  describe('output path option', () => {
    it('writes to a custom --out path relative to the target repo', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([{ entry, dir: FIXTURE_DIR }]);

      await indexCommand(FIXTURE_DIR, { out: 'custom/graph.json' });

      const [outPath] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toBe(resolve(FIXTURE_DIR, 'custom/graph.json'));
    });
  });

  describe('multi-language merge + output isolation (D2, D4)', () => {
    it('reads each pair.run() return path independently — the dispatcher does not assume a single shared output path', async () => {
      // Two entries, each returning its OWN isolated .scip path — here we
      // prove the DISPATCHER calls run(dir, outPath) per pair and reads
      // each returned path independently rather than clobbering a shared
      // variable. Both point at the same real fixture bytes, which is
      // fine: this test exercises path-independence, not per-language
      // mapping correctness (covered in packages/core's SCIP fixture tests).
      const entryA = makeEntry({
        bin: 'scip-go',
        languages: ['go'],
        run: vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH),
      });
      const entryB = makeEntry({
        bin: 'scip-go-2',
        languages: ['java'],
        run: vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH),
      });
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: entryA, dir: FIXTURE_DIR },
        { entry: entryB, dir: FIXTURE_DIR },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(entryA.run).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
      expect(entryB.run).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
      // Both entries' distinct returned scipPaths were read independently —
      // the dispatcher never reused/mutated a single shared variable.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const [, contents] = mockWriteFileSync.mock.calls[0];
      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(Object.keys(graph.nodes).length).toBeGreaterThan(0);
    });

    it('D3 HIGHEST-RISK: two marker directories of the SAME indexer bin (two scip-python dirs) get DISTINCT output paths — no clobber', async () => {
      const mlService = join(FIXTURE_DIR, 'apps', 'ml-service');
      const aiAssistant = join(FIXTURE_DIR, 'services', 'ai-assistant');
      const seenOutPaths: string[] = [];

      const runSpy = vi.fn().mockImplementation((_dir: string, outPath: string) => {
        seenOutPaths.push(outPath);
        return Promise.resolve(FIXTURE_SCIP_PATH);
      });
      const pythonEntry = makeEntry({ bin: 'scip-python', languages: ['python'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: pythonEntry, dir: mlService },
        { entry: pythonEntry, dir: aiAssistant },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(seenOutPaths).toHaveLength(2);
      // The two calls' outPaths must be DISTINCT — the whole point of D3.
      expect(seenOutPaths[0]).not.toBe(seenOutPaths[1]);
      // Both must be disambiguated variants of the SAME bin name, not two
      // unrelated paths — proves the collision was avoided BY DESIGN
      // (dir-slug suffix), not by accident.
      for (const p of seenOutPaths) {
        expect(p).toContain('scip-python');
      }
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('scip-typescript root-umbrella collapse (D6, empirical spike)', () => {
    it('collapses multiple TS/JS marker-dir pairs into a SINGLE root-cwd run', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const tsEntry = makeEntry({
        bin: 'scip-typescript',
        languages: ['typescript', 'javascript'],
        run: runSpy,
      });
      const appsWeb = join(FIXTURE_DIR, 'apps', 'web');
      const packagesUtils = join(FIXTURE_DIR, 'packages', 'utils');
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: tsEntry, dir: appsWeb },
        { entry: tsEntry, dir: packagesUtils },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      // Exactly ONE run, at repo root — NOT one per nested TS marker dir.
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
      expect(tui.log.success).toHaveBeenCalled();
    });

    it('does not affect non-TypeScript entries dispatched in the same run', async () => {
      const tsRunSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const goRunSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const tsEntry = makeEntry({
        bin: 'scip-typescript',
        languages: ['typescript', 'javascript'],
        run: tsRunSpy,
      });
      const goEntry = makeEntry({ bin: 'scip-go', languages: ['go'], run: goRunSpy });
      const appsWeb = join(FIXTURE_DIR, 'apps', 'web');
      const appsBackend = join(FIXTURE_DIR, 'apps', 'backend');
      mockDetectMarkerDirectories.mockReturnValue([
        { entry: tsEntry, dir: appsWeb },
        { entry: goEntry, dir: appsBackend },
      ]);

      await indexCommand(FIXTURE_DIR, {});

      expect(tsRunSpy).toHaveBeenCalledTimes(1);
      expect(tsRunSpy).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
      expect(goRunSpy).toHaveBeenCalledTimes(1);
      expect(goRunSpy).toHaveBeenCalledWith(appsBackend, expect.any(String));
    });

    it('a single TS marker-dir pair still runs (collapse is a no-op, not a skip)', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const tsEntry = makeEntry({
        bin: 'scip-typescript',
        languages: ['typescript', 'javascript'],
        run: runSpy,
      });
      mockDetectMarkerDirectories.mockReturnValue([{ entry: tsEntry, dir: FIXTURE_DIR }]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(FIXTURE_DIR, expect.any(String));
    });
  });

  describe('run-count cap (D5)', () => {
    it('caps runs at the configured maximum and warns naming the skipped marker directories', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      // 30 distinct marker dirs, well over the DEFAULT_MAX_NESTED_RUNS (25).
      const pairs = Array.from({ length: 30 }, (_, i) => ({
        entry,
        dir: join(FIXTURE_DIR, `dir-${i}`),
      }));
      mockDetectMarkerDirectories.mockReturnValue(pairs);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledTimes(25);
      expect(tui.log.warn).toHaveBeenCalled();
      const warnMessages = (tui.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      const capWarning = warnMessages.find((m) => m.includes('cap') || m.includes('25'));
      expect(capWarning).toBeDefined();
      // Names at least one of the dropped directories.
      expect(capWarning).toMatch(/dir-(2[5-9])/);
    });

    it('sorts stable-maturity entries before heavy/experimental when capping', async () => {
      const stableRun = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const experimentalRun = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const stableEntry = makeEntry({
        bin: 'scip-go',
        languages: ['go'],
        maturity: 'stable',
        run: stableRun,
      });
      const experimentalEntry = makeEntry({
        bin: 'scip-dotnet',
        languages: ['csharp'],
        maturity: 'experimental',
        run: experimentalRun,
      });
      // 20 experimental pairs registered FIRST, then 10 stable pairs — if
      // sort-before-cap works, all 10 stable pairs still run even though
      // they were declared after 20 experimental ones (cap is 25).
      const experimentalPairs = Array.from({ length: 20 }, (_, i) => ({
        entry: experimentalEntry,
        dir: join(FIXTURE_DIR, `exp-${i}`),
      }));
      const stablePairs = Array.from({ length: 10 }, (_, i) => ({
        entry: stableEntry,
        dir: join(FIXTURE_DIR, `stable-${i}`),
      }));
      mockDetectMarkerDirectories.mockReturnValue([...experimentalPairs, ...stablePairs]);

      await indexCommand(FIXTURE_DIR, {});

      expect(stableRun).toHaveBeenCalledTimes(10);
      expect(experimentalRun).toHaveBeenCalledTimes(15);
    });
  });

  describe('metadata.json (design v2 D1/B-003)', () => {
    it('writes metadata.json AFTER graph.json, with languages derived from graph.nodes (not dispatch)', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([{ entry, dir: FIXTURE_DIR }]);
      mockExecFileSync.mockReturnValue('deadbeef1234\n');

      await indexCommand(FIXTURE_DIR, {});

      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const [graphPath] = mockWriteFileSync.mock.calls[0];
      const [metadataPath, metadataContents] = mockWriteFileSync.mock.calls[1];
      expect(String(graphPath)).toContain('.ghagga/graph.json');
      expect(String(metadataPath)).toContain('.ghagga/metadata.json');

      const graph = parseGraphFixture(mockWriteFileSync.mock.calls[0][1]);
      const metadata = JSON.parse(metadataContents as string);

      expect(metadata.lastIndexedCommit).toBe('deadbeef1234');
      expect(metadata.schemaVersion).toBe(GRAPH_VERSION);
      expect(metadata.graphVersion).toBe(graph.version);
      expect(metadata.fileCount).toBe(Object.keys(graph.nodes).length);
      // Derived from graph.nodes contents, NOT dispatch's indexedLanguages —
      // both happen to include 'go' here, but the derivation source matters
      // (see the regex-fallback case below, where indexedLanguages is []).
      const graphLanguages = [...new Set(Object.values(graph.nodes).map((n) => n.language))];
      expect(metadata.languages.sort()).toEqual(graphLanguages.sort());
    });

    it('git HEAD resolution failure (non-git repo) degrades to an empty lastIndexedCommit, does not throw', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectMarkerDirectories.mockReturnValue([{ entry, dir: FIXTURE_DIR }]);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      await indexCommand(FIXTURE_DIR, {});

      const [, metadataContents] = mockWriteFileSync.mock.calls[1];
      const metadata = JSON.parse(metadataContents as string);
      expect(metadata.lastIndexedCommit).toBe('');
    });

    it('regex fallback: metadata.languages is derived from graph.nodes, not the empty dispatch indexedLanguages (CRITICAL-1)', async () => {
      const missingEntry = makeEntry({
        bin: 'rust-analyzer',
        languages: ['rust'],
        toolchainCheck: () => false,
      });
      mockDetectMarkerDirectories.mockReturnValue([{ entry: missingEntry, dir: FIXTURE_DIR }]);

      await indexCommand(FIXTURE_DIR, { fallbackRegex: true });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const [, metadataContents] = mockWriteFileSync.mock.calls[1];
      const metadata = JSON.parse(metadataContents as string);
      // Regex-fallback's dispatch indexedLanguages is [] — but the graph's
      // nodes carry real languages, so metadata.languages must NOT be empty
      // when the built graph actually has nodes of a known language.
      const graph = parseGraphFixture(mockWriteFileSync.mock.calls[0][1]);
      const graphLanguages = [...new Set(Object.values(graph.nodes).map((n) => n.language))];
      expect(metadata.languages.sort()).toEqual(graphLanguages.sort());
      expect(metadata.skippedLanguages).toContain('rust');
    });
  });
});
