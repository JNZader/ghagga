/**
 * Tests for `ghagga memory show` subcommand.
 *
 * Mocks ghagga-core (SqliteMemoryStorage) and node:fs.
 * Tests happy path field display, not found (exit 1),
 * invalid ID (exit 1), and no DB file (exit 0).
 *
 * @see T7.4, S13–S16
 */

import { Command } from 'commander';
import type { MemoryObservationDetail } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockGetObservation, mockClose } = vi.hoisted(() => ({
  mockGetObservation: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      getObservation: (...args: unknown[]) => mockGetObservation(...args),
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

// Embedding resolution is unrelated to show's behavior — stub to `none`
// (undefined provider) so openMemoryOrExit's SqliteMemoryStorage.create call
// stays on the pre-existing keyword-only path this test suite exercises.
vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

import { existsSync } from 'node:fs';
import { registerShowCommand } from './show.js';

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
    title: 'OAuth token refresh patterns',
    content: 'OAuth token refresh must handle 401 responses.',
    filePaths: ['src/auth.ts', 'lib/token.ts'],
    severity: null,
    project: 'acme/widgets',
    topicKey: 'auth-token-refresh',
    revisionCount: 3,
    createdAt: '2025-03-01T14:22:05Z',
    updatedAt: '2025-03-04T09:15:32Z',
    ...overrides,
  };
}

async function runShowCommand(args: string[] = []): Promise<void> {
  const parent = new Command('memory');
  registerShowCommand(parent);
  try {
    await parent.parseAsync(['show', ...args], { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  }
}

// ─── Setup ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let logSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let exitSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory show', () => {
  it('displays all fields with correct labels on happy path', async () => {
    const obs = makeDetail();
    mockGetObservation.mockResolvedValue(obs);

    await runShowCommand(['42']);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('ID:');
    expect(output).toContain('42');
    expect(output).toContain('Type:');
    expect(output).toContain('pattern');
    expect(output).toContain('Title:');
    expect(output).toContain('OAuth token refresh patterns');
    expect(output).toContain('Project:');
    expect(output).toContain('acme/widgets');
    expect(output).toContain('Topic Key:');
    expect(output).toContain('auth-token-refresh');
    expect(output).toContain('Revision Count:');
    expect(output).toContain('3');
    expect(output).toContain('Created:');
    expect(output).toContain('Updated:');
    expect(output).toContain('File Paths:');
    expect(output).toContain('src/auth.ts, lib/token.ts');
    expect(output).toContain('Content:');
    expect(output).toContain('OAuth token refresh must handle 401 responses.');
  });

  it('shows (none) for null topicKey', async () => {
    mockGetObservation.mockResolvedValue(makeDetail({ topicKey: null }));

    await runShowCommand(['42']);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('(none)');
  });

  it('shows (none) for null filePaths', async () => {
    mockGetObservation.mockResolvedValue(makeDetail({ filePaths: null }));

    await runShowCommand(['42']);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toMatch(/File Paths:.*\(none\)/);
  });

  it('shows (none) for empty filePaths array', async () => {
    mockGetObservation.mockResolvedValue(makeDetail({ filePaths: [] }));

    await runShowCommand(['42']);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toMatch(/File Paths:.*\(none\)/);
  });

  it('prints error and exits 1 when observation is not found', async () => {
    mockGetObservation.mockResolvedValue(null);

    await runShowCommand(['999']);

    expect(logSpy).toHaveBeenCalledWith('Observation not found: 999');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints error and exits 1 for invalid ID "abc"', async () => {
    await runShowCommand(['abc']);

    expect(logSpy).toHaveBeenCalledWith('Invalid observation ID: "abc". Expected a number.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runShowCommand(['42']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockGetObservation.mockResolvedValue(makeDetail());

    await runShowCommand(['42']);

    expect(mockClose).toHaveBeenCalled();
  });
});
