/**
 * Unit tests for NodeExecutionContext.
 *
 * Tests:
 * - Basic exec
 * - Timeout handling
 * - Error handling
 * - Cache no-ops
 * - Logging
 */

import { describe, expect, it, vi } from 'vitest';
import { createNodeExecutionContext } from './execution.js';

// ─── Mocks ──────────────────────────────────────────────────────

// We mock child_process to avoid actual process spawning
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

// ─── Tests ──────────────────────────────────────────────────────

describe('createNodeExecutionContext', () => {
  // ── exec ──

  describe('exec', () => {
    it('resolves with stdout and stderr on success', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(null, 'hello stdout', 'hello stderr');
        return { on: vi.fn() } as any;
      });

      const ctx = createNodeExecutionContext();
      const result = await ctx.exec('echo', ['hello'], { timeoutMs: 5000 });

      expect(result.stdout).toBe('hello stdout');
      expect(result.stderr).toBe('hello stderr');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('handles non-zero exit codes', async () => {
      const error = Object.assign(new Error('exit 1'), { code: 1 });
      // biome-ignore lint/suspicious/noExplicitAny: mock
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
        callback(error, 'partial output', 'error details');
        return { on: vi.fn() } as any;
      });

      const ctx = createNodeExecutionContext();
      const result = await ctx.exec('failing-cmd', [], { timeoutMs: 5000 });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('partial output');
      expect(result.timedOut).toBe(false);
    });
  });

  // ── cache ──

  describe('cache', () => {
    it('cacheRestore always returns false (no-op)', async () => {
      const ctx = createNodeExecutionContext();
      const result = await ctx.cacheRestore('semgrep', ['/usr/local/bin/semgrep']);
      expect(result).toBe(false);
    });

    it('cacheSave is a no-op', async () => {
      const ctx = createNodeExecutionContext();
      await expect(ctx.cacheSave('semgrep', ['/usr/local/bin/semgrep'])).resolves.toBeUndefined();
    });
  });

  // ── logging ──

  describe('log', () => {
    it('delegates to provided logger', () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const ctx = createNodeExecutionContext(logger);

      ctx.log('info', 'test message');
      expect(logger.info).toHaveBeenCalledWith('test message');

      ctx.log('warn', 'warning');
      expect(logger.warn).toHaveBeenCalledWith('warning');

      ctx.log('error', 'error');
      expect(logger.error).toHaveBeenCalledWith('error');
    });

    // BL-SARIF-STDOUT: the DEFAULT logger must route ALL diagnostic levels to
    // stderr. console.info/console.log write to stdout, which would interleave
    // with and corrupt machine output (SARIF/JSON) emitted by CLI consumers.
    it('default logger routes info/warn/error to stderr (never stdout)', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const ctx = createNodeExecutionContext(); // no logger → default

      ctx.log('info', 'progress: running tools');
      ctx.log('warn', 'budget low');
      ctx.log('error', 'tool failed');

      // Nothing on stdout.
      expect(logSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      // All three diagnostics on stderr.
      expect(errorSpy).toHaveBeenCalledWith('progress: running tools');
      expect(errorSpy).toHaveBeenCalledWith('budget low');
      expect(errorSpy).toHaveBeenCalledWith('tool failed');

      logSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
