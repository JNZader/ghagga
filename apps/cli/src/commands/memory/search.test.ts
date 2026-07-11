/**
 * Tests for `ghagga memory search` subcommand.
 *
 * Mocks ghagga-core (SqliteMemoryStorage), node:fs, and resolveProjectId.
 * Tests happy path numbered results, repo flags, inferred repo, limit,
 * empty results, and no DB.
 *
 * @see T7.3, S8–S12
 */

import { Command } from 'commander';
import type { MemoryObservationRow } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockSearchObservations, mockClose, mockResolveProjectId } = vi.hoisted(() => ({
  mockSearchObservations: vi.fn(),
  mockClose: vi.fn(),
  mockResolveProjectId: vi.fn().mockReturnValue('inferred/repo'),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      searchObservations: (...args: unknown[]) => mockSearchObservations(...args),
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

// Embedding resolution is unrelated to search's behavior — stub to `none`
// (undefined provider) so openMemoryOrExit's SqliteMemoryStorage.create call
// stays on the pre-existing keyword-only path this test suite exercises.
vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

vi.mock('../../lib/git.js', () => ({
  resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
}));

import { existsSync } from 'node:fs';
import { registerSearchCommand } from './search.js';

const mockExistsSync = vi.mocked(existsSync);

// ─── Helpers ────────────────────────────────────────────────────

function makeRow(overrides: Partial<MemoryObservationRow> = {}): MemoryObservationRow {
  return {
    id: 42,
    type: 'pattern',
    title: 'OAuth token refresh',
    content: 'OAuth token refresh must handle 401 responses',
    filePaths: ['src/auth.ts'],
    severity: null,
    ...overrides,
  };
}

async function runSearchCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerSearchCommand(parent);
  await parent.parseAsync(['search', ...args], { from: 'user' });
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
  mockResolveProjectId.mockReturnValue('inferred/repo');
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory search', () => {
  it('displays numbered results on happy path', async () => {
    const rows = [
      makeRow({ id: 1, type: 'pattern', title: 'OAuth refresh', content: 'Handle 401 responses' }),
      makeRow({
        id: 2,
        type: 'bugfix',
        title: 'Pool leak',
        content: 'Connection leak in transactions',
      }),
    ];
    mockSearchObservations.mockResolvedValue(rows);

    await runSearchCommand(['auth', '--repo', 'acme/widgets']);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('Found 2 results');
    expect(output).toContain('acme/widgets');
    expect(output).toContain('1. [pattern] OAuth refresh');
    expect(output).toContain('2. [bugfix] Pool leak');
    expect(output).toContain('00000001');
    expect(output).toContain('00000002');
  });

  it('uses explicit --repo flag', async () => {
    mockSearchObservations.mockResolvedValue([]);

    await runSearchCommand(['query', '--repo', 'acme/widgets']);

    expect(mockSearchObservations).toHaveBeenCalledWith(
      'acme/widgets',
      'query',
      expect.objectContaining({ limit: 10 }),
    );
    expect(mockResolveProjectId).not.toHaveBeenCalled();
  });

  it('infers repo from git when --repo is not provided', async () => {
    mockSearchObservations.mockResolvedValue([]);

    await runSearchCommand(['auth']);

    expect(mockResolveProjectId).toHaveBeenCalledWith(process.cwd());
    expect(mockSearchObservations).toHaveBeenCalledWith(
      'inferred/repo',
      'auth',
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('passes --limit as a number', async () => {
    mockSearchObservations.mockResolvedValue([]);

    await runSearchCommand(['query', '--repo', 'acme/widgets', '--limit', '3']);

    expect(mockSearchObservations).toHaveBeenCalledWith(
      'acme/widgets',
      'query',
      expect.objectContaining({ limit: 3 }),
    );
  });

  it('prints "No matching observations found." when results are empty', async () => {
    mockSearchObservations.mockResolvedValue([]);

    await runSearchCommand(['nonexistent', '--repo', 'acme/widgets']);

    expect(logSpy).toHaveBeenCalledWith('No matching observations found.');
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runSearchCommand(['auth', '--repo', 'acme/widgets']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockSearchObservations.mockResolvedValue([makeRow()]);

    await runSearchCommand(['auth', '--repo', 'acme/widgets']);

    expect(mockClose).toHaveBeenCalled();
  });
});
