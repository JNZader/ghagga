/**
 * Tests for `ghagga memory stats` subcommand.
 *
 * Mocks ghagga-core (SqliteMemoryStorage) and node:fs (existsSync, statSync).
 * Tests happy path full output, empty DB, and no DB file.
 *
 * @see T7.6, S25–S27
 */

import { Command } from 'commander';
import type { MemoryStats } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

const { mockGetStats, mockClose } = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('ghagga-core', () => ({
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      getStats: (...args: unknown[]) => mockGetStats(...args),
      close: (...args: unknown[]) => mockClose(...args),
    }),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ size: 2457600 }),
}));

vi.mock('../../lib/config.js', () => ({
  getConfigDir: vi.fn().mockReturnValue('/mock-config'),
}));

// Embedding resolution is unrelated to stats' behavior — stub to `none`
// (undefined provider) so openMemoryOrExit's SqliteMemoryStorage.create call
// stays on the pre-existing keyword-only path this test suite exercises.
vi.mock('../../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

import { existsSync, statSync } from 'node:fs';
import { registerStatsCommand } from './stats.js';

const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);

// ─── Helpers ────────────────────────────────────────────────────

function makeStats(overrides: Partial<MemoryStats> = {}): MemoryStats {
  return {
    totalObservations: 147,
    byType: { pattern: 68, bugfix: 42, learning: 21 },
    byProject: { 'acme/widgets': 89, 'acme/gadgets': 45, 'acme/platform': 13 },
    oldestObservation: '2025-01-15T00:00:00Z',
    newestObservation: '2025-03-06T00:00:00Z',
    ...overrides,
  };
}

async function runStatsCommand(): Promise<void> {
  const parent = new Command('memory');
  registerStatsCommand(parent);
  await parent.parseAsync(['stats'], { from: 'user' });
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
  mockStatSync.mockReturnValue({ size: 2457600 } as ReturnType<typeof statSync>);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('ghagga memory stats', () => {
  it('displays full statistics on happy path', async () => {
    mockGetStats.mockResolvedValue(makeStats());

    await runStatsCommand();

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // Header
    expect(output).toContain('Memory Database Statistics');
    expect(output).toContain('──────────');
    // DB info
    expect(output).toContain('/mock-config');
    expect(output).toContain('2.3 MB');
    // Totals
    expect(output).toContain('147 total');
    // Date range
    expect(output).toContain('2025-01-15');
    expect(output).toContain('2025-03-06');
    // By type
    expect(output).toContain('By Type:');
    expect(output).toContain('pattern');
    expect(output).toContain('68');
    expect(output).toContain('bugfix');
    expect(output).toContain('42');
    // By project
    expect(output).toContain('By Project:');
    expect(output).toContain('acme/widgets');
    expect(output).toContain('89');
  });

  it('displays (none) for date range and sections when DB is empty', async () => {
    mockGetStats.mockResolvedValue(
      makeStats({
        totalObservations: 0,
        byType: {},
        byProject: {},
        oldestObservation: null,
        newestObservation: null,
      }),
    );

    await runStatsCommand();

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('0 total');
    // (none) for empty sections
    const noneCount = (output.match(/\(none\)/g) || []).length;
    expect(noneCount).toBeGreaterThanOrEqual(3); // date range (none) — (none), byType (none), byProject (none)
  });

  it('prints no-DB message and exits 0 when database file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    await runStatsCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No memory database found'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes storage after execution', async () => {
    mockGetStats.mockResolvedValue(makeStats());

    await runStatsCommand();

    expect(mockClose).toHaveBeenCalled();
  });
});
