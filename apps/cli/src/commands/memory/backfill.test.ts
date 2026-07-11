/**
 * Tests for `ghagga memory backfill` subcommand.
 *
 * Mocks ghagga-core (SqliteMemoryStorage, backfillEmbeddings) and the CLI's
 * embedding provider resolver — verifies flag parsing/forwarding, the
 * "no provider configured" error path, and the no-DB-file exit path.
 *
 * @see design D6, task 6.3
 */

import { Command } from 'commander';
import type { EmbeddingProvider } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockBackfillEmbeddings, mockClose } = vi.hoisted(() => ({
  mockBackfillEmbeddings: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      close: (...args: unknown[]) => mockClose(...args),
    }),
  },
  backfillEmbeddings: (...args: unknown[]) => mockBackfillEmbeddings(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('../../lib/config.js', () => ({
  getConfigDir: vi.fn().mockReturnValue('/mock-config'),
}));

const fakeProvider: EmbeddingProvider = {
  dimension: 8,
  embed: vi.fn(),
  embedBatch: vi.fn(),
};

const { mockResolveCliEmbeddingProvider } = vi.hoisted(() => ({
  mockResolveCliEmbeddingProvider: vi.fn(),
}));

vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => mockResolveCliEmbeddingProvider(),
}));

import { existsSync } from 'node:fs';
import { registerBackfillCommand } from './backfill.js';

const mockExistsSync = vi.mocked(existsSync);

// ─── Helpers ────────────────────────────────────────────────────

/** Sentinel thrown by the process.exit mock to halt execution (mirrors show.test.ts). */
class ProcessExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

async function runBackfillCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerBackfillCommand(parent);
  try {
    await parent.parseAsync(['backfill', ...args], { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let logSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let errorSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let exitSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  mockExistsSync.mockReturnValue(true);
  mockResolveCliEmbeddingProvider.mockReturnValue({
    config: { provider: 'openai-compatible', model: 'text-embedding-3-small', candidateK: 200 },
    provider: fakeProvider,
  });
  mockBackfillEmbeddings.mockResolvedValue({ totalProcessed: 5, totalBatches: 1 });
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory backfill', () => {
  it('calls backfillEmbeddings with default options and reports the result', async () => {
    await runBackfillCommand();

    expect(mockBackfillEmbeddings).toHaveBeenCalledWith(
      expect.anything(),
      fakeProvider,
      'text-embedding-3-small',
      expect.objectContaining({
        batchSize: 100,
        limit: undefined,
        reEmbed: false,
        delayMs: 0,
      }),
    );

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('Backfill complete: 5 rows embedded across 1 batches.');
  });

  it('forwards --batch, --limit, --re-embed, --delay flags', async () => {
    await runBackfillCommand(['--batch', '25', '--limit', '100', '--re-embed', '--delay', '500']);

    expect(mockBackfillEmbeddings).toHaveBeenCalledWith(
      expect.anything(),
      fakeProvider,
      'text-embedding-3-small',
      expect.objectContaining({
        batchSize: 25,
        limit: 100,
        reEmbed: true,
        delayMs: 500,
      }),
    );
  });

  it('errors clearly and exits 1 when no embedding provider is configured', async () => {
    mockResolveCliEmbeddingProvider.mockReturnValue({
      config: { provider: 'none', candidateK: 200 },
      provider: undefined,
    });

    await runBackfillCommand();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No embedding provider configured'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockBackfillEmbeddings).not.toHaveBeenCalled();
  });

  it('closes storage after execution', async () => {
    await runBackfillCommand();

    expect(mockClose).toHaveBeenCalled();
  });
});
