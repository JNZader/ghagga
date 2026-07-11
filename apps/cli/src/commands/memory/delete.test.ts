/**
 * Tests for `ghagga memory delete` subcommand.
 *
 * Mocks ghagga-core, node:fs, node:readline/promises, and process.stdin.isTTY.
 * Tests happy path with confirmation, cancel, force, not found,
 * non-TTY detection, invalid ID, and no DB.
 *
 * @see T7.5, S17–S24, S48
 */

import { Command } from 'commander';
import type { MemoryObservationDetail } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockGetObservation, mockDeleteObservation, mockClose, mockQuestion, mockRlClose } =
  vi.hoisted(() => ({
    mockGetObservation: vi.fn(),
    mockDeleteObservation: vi.fn(),
    mockClose: vi.fn(),
    mockQuestion: vi.fn(),
    mockRlClose: vi.fn(),
  }));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      getObservation: (...args: unknown[]) => mockGetObservation(...args),
      deleteObservation: (...args: unknown[]) => mockDeleteObservation(...args),
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

// Embedding resolution is unrelated to delete's behavior — stub to `none`
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
import { registerDeleteCommand } from './delete.js';

const mockExistsSync = vi.mocked(existsSync);

// ─── Helpers ────────────────────────────────────────────────────

/** Sentinel thrown by the process.exit mock to halt execution. */
class ProcessExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function makeDetail(overrides: Partial<MemoryObservationDetail> = {}): MemoryObservationDetail {
  return {
    id: 42,
    type: 'pattern',
    title: 'OAuth token refresh',
    content: 'Some content',
    filePaths: ['src/auth.ts'],
    severity: null,
    project: 'acme/widgets',
    topicKey: 'auth-refresh',
    revisionCount: 1,
    createdAt: '2025-03-01T14:22:05Z',
    updatedAt: '2025-03-01T14:22:05Z',
    ...overrides,
  };
}

async function runDeleteCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerDeleteCommand(parent);
  try {
    await parent.parseAsync(['delete', ...args], { from: 'user' });
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

describe('ghagga memory delete', () => {
  it('deletes and prints success when user confirms with "y"', async () => {
    mockGetObservation.mockResolvedValue(makeDetail());
    mockDeleteObservation.mockResolvedValue(true);
    mockQuestion.mockResolvedValue('y');

    await runDeleteCommand(['42']);

    expect(mockGetObservation).toHaveBeenCalledWith(42);
    expect(mockDeleteObservation).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith('Deleted observation 42.');
  });

  it('cancels when user answers "n"', async () => {
    mockGetObservation.mockResolvedValue(makeDetail());
    mockQuestion.mockResolvedValue('n');

    await runDeleteCommand(['42']);

    expect(mockDeleteObservation).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('skips prompt when --force is passed', async () => {
    mockGetObservation.mockResolvedValue(makeDetail());
    mockDeleteObservation.mockResolvedValue(true);

    await runDeleteCommand(['42', '--force']);

    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockDeleteObservation).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith('Deleted observation 42.');
  });

  it('prints error and exits 1 when observation is not found', async () => {
    mockGetObservation.mockResolvedValue(null);

    await runDeleteCommand(['999']);

    expect(logSpy).toHaveBeenCalledWith('Observation not found: 999');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDeleteObservation).not.toHaveBeenCalled();
  });

  it('prints error and exits 1 for non-TTY without --force', async () => {
    process.stdin.isTTY = undefined as unknown as boolean;
    mockGetObservation.mockResolvedValue(makeDetail());

    await runDeleteCommand(['42']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--force'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDeleteObservation).not.toHaveBeenCalled();
  });

  it('deletes without prompt for non-TTY with --force', async () => {
    process.stdin.isTTY = undefined as unknown as boolean;
    mockGetObservation.mockResolvedValue(makeDetail());
    mockDeleteObservation.mockResolvedValue(true);

    await runDeleteCommand(['42', '--force']);

    expect(mockDeleteObservation).toHaveBeenCalledWith(42);
    expect(logSpy).toHaveBeenCalledWith('Deleted observation 42.');
  });

  it('prints error and exits 1 for invalid ID', async () => {
    await runDeleteCommand(['abc']);

    expect(logSpy).toHaveBeenCalledWith('Invalid observation ID: "abc". Expected a number.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runDeleteCommand(['42']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockGetObservation.mockResolvedValue(makeDetail());
    mockDeleteObservation.mockResolvedValue(true);
    mockQuestion.mockResolvedValue('y');

    await runDeleteCommand(['42']);

    expect(mockClose).toHaveBeenCalled();
  });
});
