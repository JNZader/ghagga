/**
 * Tests for `ghagga memory clear` subcommand.
 *
 * Mocks ghagga-core, node:fs, node:readline/promises, and process.stdin.isTTY.
 * Tests happy path clear all, scoped --repo, cancel, force, no observations,
 * non-TTY detection, and no DB.
 *
 * @see T7.7, S28–S35, S49
 */

import { Command } from 'commander';
import type { MemoryStats } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const {
  mockGetStats,
  mockListObservations,
  mockClearObservations,
  mockClose,
  mockQuestion,
  mockRlClose,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockListObservations: vi.fn(),
  mockClearObservations: vi.fn(),
  mockClose: vi.fn(),
  mockQuestion: vi.fn(),
  mockRlClose: vi.fn(),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      getStats: (...args: unknown[]) => mockGetStats(...args),
      listObservations: (...args: unknown[]) => mockListObservations(...args),
      clearObservations: (...args: unknown[]) => mockClearObservations(...args),
      close: (...args: unknown[]) => mockClose(...args),
    }),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('../../lib/config.js', () => ({
  getConfigDir: vi.fn().mockReturnValue('/mock-config'),
}));

// Embedding resolution is unrelated to clear's behavior — stub to `none`
// (undefined provider) so openMemoryOrExit's SqliteMemoryStorage.create call
// stays on the pre-existing keyword-only path this test suite exercises.
vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: (...args: unknown[]) => mockQuestion(...args),
    close: (...args: unknown[]) => mockRlClose(...args),
  }),
}));

import { existsSync } from 'node:fs';
import { registerClearCommand } from './clear.js';

const mockExistsSync = vi.mocked(existsSync);

// ─── Helpers ────────────────────────────────────────────────────

/** Sentinel thrown by the process.exit mock to halt execution. */
class ProcessExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function makeStats(overrides: Partial<MemoryStats> = {}): MemoryStats {
  return {
    totalObservations: 147,
    byType: { pattern: 68, bugfix: 42 },
    byProject: { 'acme/widgets': 89, 'acme/gadgets': 58 },
    oldestObservation: '2025-01-15T00:00:00Z',
    newestObservation: '2025-03-06T00:00:00Z',
    ...overrides,
  };
}

async function runClearCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerClearCommand(parent);
  try {
    await parent.parseAsync(['clear', ...args], { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  }
}

// ─── Setup ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let logSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let errorSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let exitSpy: any;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  mockExistsSync.mockReturnValue(true);
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  process.stdin.isTTY = originalIsTTY as boolean;
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory clear', () => {
  it('clears all observations after user confirms', async () => {
    mockGetStats.mockResolvedValue(makeStats());
    mockClearObservations.mockResolvedValue(147);
    mockQuestion.mockResolvedValue('y');

    await runClearCommand();

    expect(mockClearObservations).toHaveBeenCalledWith({ project: undefined });
    expect(logSpy).toHaveBeenCalledWith('Cleared 147 observations.');
  });

  it('scopes deletion to --repo and counts correctly', async () => {
    mockGetStats.mockResolvedValue(makeStats());
    // When --repo is set, listObservations is called to count
    const fakeObs = Array.from({ length: 89 }, (_, i) => ({ id: i }));
    mockListObservations.mockResolvedValue(fakeObs);
    mockClearObservations.mockResolvedValue(89);
    mockQuestion.mockResolvedValue('y');

    await runClearCommand(['--repo', 'acme/widgets']);

    expect(mockListObservations).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'acme/widgets' }),
    );
    expect(mockClearObservations).toHaveBeenCalledWith({ project: 'acme/widgets' });
    expect(logSpy).toHaveBeenCalledWith('Cleared 89 observations.');
  });

  it('cancels when user answers "n"', async () => {
    mockGetStats.mockResolvedValue(makeStats());
    mockQuestion.mockResolvedValue('n');

    await runClearCommand();

    expect(mockClearObservations).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('skips prompt when --force is passed', async () => {
    mockGetStats.mockResolvedValue(makeStats());
    mockClearObservations.mockResolvedValue(147);

    await runClearCommand(['--force']);

    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockClearObservations).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Cleared 147 observations.');
  });

  it('prints "No observations to clear." and exits when count is 0', async () => {
    mockGetStats.mockResolvedValue(makeStats({ totalObservations: 0 }));

    await runClearCommand();

    expect(logSpy).toHaveBeenCalledWith('No observations to clear.');
    expect(mockClearObservations).not.toHaveBeenCalled();
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  it('prints error and exits 1 for non-TTY without --force', async () => {
    process.stdin.isTTY = undefined as unknown as boolean;
    mockGetStats.mockResolvedValue(makeStats());

    await runClearCommand();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--force'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockClearObservations).not.toHaveBeenCalled();
  });

  it('clears without prompt for non-TTY with --force', async () => {
    process.stdin.isTTY = undefined as unknown as boolean;
    mockGetStats.mockResolvedValue(makeStats());
    mockClearObservations.mockResolvedValue(147);

    await runClearCommand(['--force']);

    expect(mockClearObservations).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Cleared 147 observations.');
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runClearCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockGetStats.mockResolvedValue(makeStats());
    mockClearObservations.mockResolvedValue(147);
    mockQuestion.mockResolvedValue('y');

    await runClearCommand();

    expect(mockClose).toHaveBeenCalled();
  });
});
