/**
 * Tests for `ghagga memory list` subcommand.
 *
 * Mocks ghagga-core (SqliteMemoryStorage) and node:fs (existsSync).
 * Tests happy path table output, filters, limit, empty results, and no DB.
 *
 * @see T7.2, S1–S7
 */

import { Command } from 'commander';
import type { MemoryObservationDetail } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockListObservations, mockClose } = vi.hoisted(() => ({
  mockListObservations: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      listObservations: (...args: unknown[]) => mockListObservations(...args),
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

// Embedding resolution is unrelated to list's behavior — stub to `none`
// (undefined provider) so openMemoryOrExit's SqliteMemoryStorage.create call
// stays on the pre-existing keyword-only path this test suite exercises.
vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

import { existsSync } from 'node:fs';
import { registerListCommand } from './list.js';

const mockExistsSync = vi.mocked(existsSync);

// ─── Helpers ────────────────────────────────────────────────────

function makeObservation(
  overrides: Partial<MemoryObservationDetail> = {},
): MemoryObservationDetail {
  return {
    id: 42,
    type: 'pattern',
    title: 'OAuth token refresh',
    content: 'Some content about OAuth',
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

/** Invoke the list command handler via Commander parsing */
async function runListCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerListCommand(parent);
  await parent.parseAsync(['list', ...args], { from: 'user' });
}

// ─── Setup ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let logSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let exitSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory list', () => {
  it('displays table with correct headers and formatted rows', async () => {
    const obs = [
      makeObservation({
        id: 42,
        type: 'pattern',
        title: 'OAuth token refresh',
        project: 'acme/widgets',
        createdAt: '2025-03-01T14:22:05Z',
      }),
      makeObservation({
        id: 99,
        type: 'bugfix',
        title: 'Pool leak fix',
        project: 'acme/gadgets',
        createdAt: '2025-02-28T10:00:00Z',
      }),
    ];
    mockListObservations.mockResolvedValue(obs);

    await runListCommand();

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // Headers
    expect(output).toContain('ID');
    expect(output).toContain('Type');
    expect(output).toContain('Title');
    expect(output).toContain('Repo');
    expect(output).toContain('Date');
    // Separator with ─ chars
    expect(output).toContain('──────────');
    // Formatted IDs
    expect(output).toContain('00000042');
    expect(output).toContain('00000099');
    // Types and dates
    expect(output).toContain('pattern');
    expect(output).toContain('bugfix');
    expect(output).toContain('2025-03-01');
    expect(output).toContain('2025-02-28');
  });

  it('passes --repo filter to listObservations', async () => {
    mockListObservations.mockResolvedValue([makeObservation()]);

    await runListCommand(['--repo', 'acme/widgets']);

    expect(mockListObservations).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'acme/widgets' }),
    );
  });

  it('passes --type filter to listObservations', async () => {
    mockListObservations.mockResolvedValue([makeObservation()]);

    await runListCommand(['--type', 'pattern']);

    expect(mockListObservations).toHaveBeenCalledWith(expect.objectContaining({ type: 'pattern' }));
  });

  it('passes --limit as a number to listObservations', async () => {
    mockListObservations.mockResolvedValue([makeObservation()]);

    await runListCommand(['--limit', '5']);

    expect(mockListObservations).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('uses default limit of 20', async () => {
    mockListObservations.mockResolvedValue([]);

    await runListCommand();

    expect(mockListObservations).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it('prints "No observations found." when results are empty', async () => {
    mockListObservations.mockResolvedValue([]);

    await runListCommand();

    expect(logSpy).toHaveBeenCalledWith('No observations found.');
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runListCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockListObservations.mockResolvedValue([makeObservation()]);

    await runListCommand();

    expect(mockClose).toHaveBeenCalled();
  });
});
