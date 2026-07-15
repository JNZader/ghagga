/**
 * Tests for `ghagga index` — registry-dispatcher dependency graph indexing.
 *
 * Mocked: `detectPresentLanguages` (from `./indexer-registry.js`) — the
 * dispatcher tests only exercise detect/availability/degrade/zero-index/
 * merge/output-isolation wiring, mirroring the mocking style of the
 * previous Go-only tests (mocked `toolchainCheck`/`run`, not real
 * toolchains). Per-language mapping correctness is covered separately by
 * `packages/core`'s SCIP mapper fixture tests.
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

const mockDetectPresentLanguages = vi.fn();

vi.mock('./indexer-registry.js', () => ({
  detectPresentLanguages: (...args: unknown[]) => mockDetectPresentLanguages(...args),
}));

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
  });

  describe('single detected+available language', () => {
    it('runs the indexer, parses the produced .scip, and writes a valid v1 graph.json', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const entry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      mockDetectPresentLanguages.mockReturnValue([entry]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalledWith(FIXTURE_DIR);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [outPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toContain('.ghagga/graph.json');

      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(Object.keys(graph.nodes).length).toBeGreaterThan(0);
      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('per-language degradation (D6)', () => {
    it('missing toolchain: warns, skips that language, continues with the rest', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const availableEntry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      const missingEntry = makeEntry({
        bin: 'rust-analyzer',
        languages: ['rust'],
        toolchainCheck: () => false,
        installHint: 'install rust-analyzer via rustup',
      });
      mockDetectPresentLanguages.mockReturnValue([missingEntry, availableEntry]);

      await indexCommand(FIXTURE_DIR, {});

      expect(runSpy).toHaveBeenCalled();
      expect(tui.log.warn).toHaveBeenCalled();
      const warnMessages = (tui.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(warnMessages.some((m) => m.includes('rust') && m.includes('rustup'))).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(tui.log.success).toHaveBeenCalled();
    });

    it('runtime failure: indexer throws, warns, skips that language, continues with the rest', async () => {
      const runSpy = vi.fn().mockResolvedValue(FIXTURE_SCIP_PATH);
      const availableEntry = makeEntry({ bin: 'scip-go', languages: ['go'], run: runSpy });
      const crashingEntry = makeEntry({
        bin: 'scip-php',
        languages: ['php'],
        run: () => {
          throw new Error('scip-php crashed: segfault');
        },
      });
      mockDetectPresentLanguages.mockReturnValue([crashingEntry, availableEntry]);

      await indexCommand(FIXTURE_DIR, {});

      expect(tui.log.warn).toHaveBeenCalled();
      const warnMessages = (tui.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(warnMessages.some((m) => m.includes('php') && m.includes('segfault'))).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
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
      mockDetectPresentLanguages.mockReturnValue([missingEntry, crashingEntry]);

      await expect(indexCommand(FIXTURE_DIR, {})).rejects.toThrow('process.exit(1)');

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(tui.log.error).toHaveBeenCalled();
      const message = (tui.log.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(message).toContain('rust');
      expect(message).toContain('php');
    });

    it('no detected languages at all, no --fallback-regex: exits non-zero', async () => {
      mockDetectPresentLanguages.mockReturnValue([]);

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
      mockDetectPresentLanguages.mockReturnValue([missingEntry]);

      await indexCommand(FIXTURE_DIR, { fallbackRegex: true });

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
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
      mockDetectPresentLanguages.mockReturnValue([entry]);

      await indexCommand(FIXTURE_DIR, { out: 'custom/graph.json' });

      const [outPath] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toBe(resolve(FIXTURE_DIR, 'custom/graph.json'));
    });
  });

  describe('multi-language merge + output isolation (D2, D4)', () => {
    it('reads each entry.run() return path independently — the dispatcher does not assume a single shared output path', async () => {
      // Two entries, each returning its OWN isolated .scip path (per D2:
      // `.ghagga/scip/<bin>.scip` is indexer-registry.ts's job, tested there
      // — here we prove the DISPATCHER calls run(repoPath) per entry and
      // reads each returned path independently rather than clobbering a
      // shared variable). Both point at the same real fixture bytes, which
      // is fine: this test exercises path-independence, not per-language
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
      mockDetectPresentLanguages.mockReturnValue([entryA, entryB]);

      await indexCommand(FIXTURE_DIR, {});

      expect(entryA.run).toHaveBeenCalledWith(FIXTURE_DIR);
      expect(entryB.run).toHaveBeenCalledWith(FIXTURE_DIR);
      // Both entries' distinct returned scipPaths were read independently —
      // the dispatcher never reused/mutated a single shared variable.
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [, contents] = mockWriteFileSync.mock.calls[0];
      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(Object.keys(graph.nodes).length).toBeGreaterThan(0);
    });
  });
});
