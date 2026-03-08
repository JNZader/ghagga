/**
 * Database client tests.
 *
 * Tests createDatabase and createDatabaseFromEnv with mocked
 * pg.Pool and drizzle-orm to verify connection configuration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks (using vi.hoisted for mock variables) ───────────────

const mocks = vi.hoisted(() => {
  const mockPool = { end: vi.fn() };
  // Vitest v4: must use function expression (not arrow) for constructor mocks
  const MockPool = vi.fn(function () {
    return mockPool;
  });
  const mockDrizzle = vi.fn().mockReturnValue({ query: vi.fn() });
  return { mockPool, MockPool, mockDrizzle };
});

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: mocks.mockDrizzle,
}));

vi.mock('pg', () => ({
  default: { Pool: mocks.MockPool },
}));

import { createDatabase, createDatabaseFromEnv } from './client.js';

// ─── Setup ─────────────────────────────────────────────────────

const savedDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore DATABASE_URL
  if (savedDatabaseUrl !== undefined) {
    process.env.DATABASE_URL = savedDatabaseUrl;
  } else {
    delete process.env.DATABASE_URL;
  }
});

// ─── Tests ─────────────────────────────────────────────────────

describe('createDatabase', () => {
  it('creates pg.Pool with correct connection config', () => {
    createDatabase('postgres://localhost:5432/testdb');

    expect(mocks.MockPool).toHaveBeenCalledWith({
      connectionString: 'postgres://localhost:5432/testdb',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('passes the pool and schema to drizzle', () => {
    createDatabase('postgres://localhost:5432/testdb');

    expect(mocks.mockDrizzle).toHaveBeenCalledWith(
      mocks.mockPool,
      expect.objectContaining({ schema: expect.any(Object) }),
    );
  });

  it('returns the drizzle instance', () => {
    const result = createDatabase('postgres://localhost:5432/testdb');

    expect(result).toBe(mocks.mockDrizzle.mock.results[0]?.value);
  });
});

describe('createDatabaseFromEnv', () => {
  it('reads DATABASE_URL and creates database', () => {
    process.env.DATABASE_URL = 'postgres://env-host:5432/envdb';

    createDatabaseFromEnv();

    expect(mocks.MockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://env-host:5432/envdb',
      }),
    );
  });

  it('throws when DATABASE_URL is not set', () => {
    delete process.env.DATABASE_URL;

    expect(() => createDatabaseFromEnv()).toThrow('DATABASE_URL environment variable is not set');
  });
});
