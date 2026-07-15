/**
 * Tests for `ghagga index` — toolchain-gated dependency graph indexing.
 */

import { resolve } from 'node:path';
import { GRAPH_VERSION } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

const mockExecFileSync = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

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

describe('indexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: existsSync passes through to the real fs for reads inside the
    // command (e.g. checking index.scip / output dir), individual tests override.
  });

  describe('toolchain present', () => {
    it('runs scip-go, parses the real fixture index.scip, and writes a valid v1 graph.json', async () => {
      // `which go` / `which scip-go` succeed; the actual `scip-go` invocation is a
      // no-op since index.scip already exists in the fixture dir.
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'which' || cmd === 'where') return '';
        if (cmd === 'scip-go') return '';
        throw new Error(`unexpected exec: ${cmd}`);
      });
      mockExistsSync.mockImplementation((path: string) => {
        if (String(path).endsWith('index.scip')) return true;
        return false; // output dir does not exist yet -> gets created
      });

      await indexCommand(FIXTURE_DIR, {});

      // scip-go was invoked in the fixture dir
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'scip-go',
        [],
        expect.objectContaining({ cwd: FIXTURE_DIR }),
      );

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [outPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toContain('.ghagga/graph.json');

      const graph = JSON.parse(contents as string);
      expect(graph.version).toBe(GRAPH_VERSION);
      expect(typeof graph.rootDir).toBe('string');
      expect(Object.keys(graph.nodes).length).toBeGreaterThan(0);

      expect(tui.log.success).toHaveBeenCalled();
    });
  });

  describe('toolchain absent, no --fallback-regex', () => {
    it('exits non-zero with a helpful message and does not write graph.json', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      await expect(indexCommand(FIXTURE_DIR, {})).rejects.toThrow('process.exit(1)');

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(tui.log.error).toHaveBeenCalled();
      const message = (tui.log.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(message).toContain('scip-go');
    });
  });

  describe('toolchain absent + --fallback-regex', () => {
    it('uses the regex builder and writes graph.json', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      mockExistsSync.mockReturnValue(false);

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
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      mockExistsSync.mockReturnValue(false);

      await indexCommand(FIXTURE_DIR, { fallbackRegex: true, out: 'custom/graph.json' });

      const [outPath] = mockWriteFileSync.mock.calls[0];
      expect(String(outPath)).toBe(resolve(FIXTURE_DIR, 'custom/graph.json'));
    });
  });
});
