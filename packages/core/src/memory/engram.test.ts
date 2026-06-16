import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngramObservation, EngramStats } from './engram-types.js';

// ─── Mock the EngramClient ─────────────────────────────────────

const mockHealthCheck = vi.fn<() => Promise<boolean>>();
const mockSearch = vi.fn<() => Promise<EngramObservation[]>>();
const mockSave = vi.fn<() => Promise<EngramObservation | null>>();
const mockGetObservation = vi.fn<() => Promise<EngramObservation | null>>();
const mockDeleteObservation = vi.fn<() => Promise<boolean>>();
const mockGetStats = vi.fn<() => Promise<EngramStats | null>>();
const mockCreateSession = vi.fn<() => Promise<number | null>>();
const mockEndSession = vi.fn<() => Promise<void>>();

// Vitest v4: must use function expression (not arrow) for constructor mocks
vi.mock('./engram-client.js', () => ({
  EngramClient: vi.fn(function () {
    return {
      healthCheck: mockHealthCheck,
      search: mockSearch,
      save: mockSave,
      getObservation: mockGetObservation,
      deleteObservation: mockDeleteObservation,
      getStats: mockGetStats,
      createSession: mockCreateSession,
      endSession: mockEndSession,
    };
  }),
}));

import { EngramMemoryStorage } from './engram.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeEngramObservation(overrides: Partial<EngramObservation> = {}): EngramObservation {
  return {
    id: 42,
    type: 'pattern',
    title: 'Test observation',
    content: 'Some content\n---\nSource: ghagga',
    project: 'owner/repo',
    topic_key: 'test-key',
    revision_count: 1,
    created_at: '2025-06-01T10:00:00Z',
    updated_at: '2025-06-01T12:00:00Z',
    ...overrides,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('EngramMemoryStorage', () => {
  // ── create() ──

  describe('create()', () => {
    it('returns instance when Engram is healthy', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      expect(storage).toBeInstanceOf(EngramMemoryStorage);
    });

    it('returns null when Engram is unreachable', async () => {
      mockHealthCheck.mockResolvedValue(false);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      expect(storage).toBeNull();
    });

    it('logs warning when Engram is unreachable', async () => {
      mockHealthCheck.mockResolvedValue(false);

      await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ghagga:engram]'),
        expect.stringContaining('http://localhost:7437'),
      );
    });

    it('uses config from env vars when no explicit config', async () => {
      const originalHost = process.env.GHAGGA_ENGRAM_HOST;
      const originalTimeout = process.env.GHAGGA_ENGRAM_TIMEOUT;

      try {
        process.env.GHAGGA_ENGRAM_HOST = 'http://custom-host:9999';
        process.env.GHAGGA_ENGRAM_TIMEOUT = '10';

        mockHealthCheck.mockResolvedValue(true);

        const storage = await EngramMemoryStorage.create();

        expect(storage).toBeInstanceOf(EngramMemoryStorage);
        // The EngramClient constructor is called with the env-based config
        const { EngramClient } = await import('./engram-client.js');
        expect(EngramClient).toHaveBeenCalledWith({
          host: 'http://custom-host:9999',
          timeout: 10000, // 10 * 1000
        });
      } finally {
        if (originalHost === undefined) delete process.env.GHAGGA_ENGRAM_HOST;
        else process.env.GHAGGA_ENGRAM_HOST = originalHost;
        if (originalTimeout === undefined) delete process.env.GHAGGA_ENGRAM_TIMEOUT;
        else process.env.GHAGGA_ENGRAM_TIMEOUT = originalTimeout;
      }
    });

    it('uses default config when no env vars and no explicit config', async () => {
      const originalHost = process.env.GHAGGA_ENGRAM_HOST;
      const originalTimeout = process.env.GHAGGA_ENGRAM_TIMEOUT;

      try {
        delete process.env.GHAGGA_ENGRAM_HOST;
        delete process.env.GHAGGA_ENGRAM_TIMEOUT;

        mockHealthCheck.mockResolvedValue(true);

        const storage = await EngramMemoryStorage.create();

        expect(storage).toBeInstanceOf(EngramMemoryStorage);
        const { EngramClient } = await import('./engram-client.js');
        expect(EngramClient).toHaveBeenCalledWith({
          host: 'http://localhost:7437',
          timeout: 5000, // '5' * 1000
        });
      } finally {
        if (originalHost === undefined) delete process.env.GHAGGA_ENGRAM_HOST;
        else process.env.GHAGGA_ENGRAM_HOST = originalHost;
        if (originalTimeout === undefined) delete process.env.GHAGGA_ENGRAM_TIMEOUT;
        else process.env.GHAGGA_ENGRAM_TIMEOUT = originalTimeout;
      }
    });
  });

  // ── searchObservations ──

  describe('searchObservations()', () => {
    it('calls client.search with correct params', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      await storage?.searchObservations('acme/widgets', 'auth', { limit: 5 });

      expect(mockSearch).toHaveBeenCalledWith('auth', 'acme/widgets', 5);
    });

    it('maps results to MemoryObservationRow', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({
          id: 1,
          type: 'pattern',
          title: 'Auth',
          content: '[severity:high]\nUse JWT\n---\nSource: ghagga',
        }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.searchObservations('acme/widgets', 'auth');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 1,
        type: 'pattern',
        title: 'Auth',
        content: 'Use JWT',
        filePaths: null,
        severity: 'high',
      });
    });

    it('applies type filter', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, type: 'pattern', title: 'Pattern' }),
        makeEngramObservation({ id: 2, type: 'bugfix', title: 'Bugfix' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.searchObservations('acme/widgets', 'test', { type: 'bugfix' });

      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('bugfix');
    });

    it('over-fetches (limit*3) when a type filter is present so a type-matched dup beyond the first `limit` keyword hits is still found', async () => {
      mockHealthCheck.mockResolvedValue(true);
      // Server returns keyword matches ordered by relevance. The first TWO are
      // OTHER types; the real issue-triage match is THIRD. With limit=2 and NO
      // over-fetch, the server would only hand back the first 2 (both wrong
      // type) and the genuine dup at position 3 would be silently missed.
      // Over-fetching limit*3 = 6 lets the client-side filter still see it.
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, type: 'pattern', title: 'noise A' }),
        makeEngramObservation({ id: 2, type: 'pattern', title: 'noise B' }),
        makeEngramObservation({ id: 3, type: 'issue-triage', title: 'real dup' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.searchObservations('acme/widgets', 'login crash', {
        limit: 2,
        type: 'issue-triage',
      });

      // Over-fetch factor: limit (2) * 3 = 6 rows requested from the server.
      expect(mockSearch).toHaveBeenCalledWith('login crash', 'acme/widgets', 6);
      // The type-matched dup beyond the first `limit` keyword hits is recovered.
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(3);
      expect(results[0]?.type).toBe('issue-triage');
    });

    it('does NOT over-fetch when no type filter is present (fetches exactly `limit`)', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.searchObservations('acme/widgets', 'auth', { limit: 5 });

      // No type filter → nothing to drop → fetch exactly `limit`, not limit*3.
      expect(mockSearch).toHaveBeenCalledWith('auth', 'acme/widgets', 5);
    });

    it('slices a type-filtered over-fetch back to `limit` (never returns more than asked)', async () => {
      mockHealthCheck.mockResolvedValue(true);
      // Four type-matched rows returned by the over-fetch; caller asked for 2.
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, type: 'issue-triage', title: 'a' }),
        makeEngramObservation({ id: 2, type: 'issue-triage', title: 'b' }),
        makeEngramObservation({ id: 3, type: 'issue-triage', title: 'c' }),
        makeEngramObservation({ id: 4, type: 'issue-triage', title: 'd' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.searchObservations('acme/widgets', 'q', {
        limit: 2,
        type: 'issue-triage',
      });

      expect(results).toHaveLength(2);
      expect(results?.map((r) => r.id)).toEqual([1, 2]);
    });

    it('uses default limit of 10 when not specified', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.searchObservations('acme/widgets', 'query');

      expect(mockSearch).toHaveBeenCalledWith('query', 'acme/widgets', 10);
    });
  });

  // ── saveObservation ──

  describe('saveObservation()', () => {
    it('calls client.save with mapped data', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSave.mockResolvedValue(makeEngramObservation({ id: 10 }));

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'pattern',
        title: 'Auth pattern',
        content: 'Use JWT tokens',
        severity: 'high',
        filePaths: ['src/auth.ts'],
      });

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pattern',
          title: 'Auth pattern',
          project: 'acme/widgets',
          content: expect.stringContaining('Use JWT tokens'),
        }),
      );
    });

    it('returns mapped result', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSave.mockResolvedValue(
        makeEngramObservation({
          id: 10,
          type: 'pattern',
          title: 'Auth',
          content: 'JWT info\n---\nSource: ghagga',
        }),
      );

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const result = await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'pattern',
        title: 'Auth',
        content: 'JWT info',
      });

      expect(result.id).toBe(10);
      expect(result.type).toBe('pattern');
      expect(result.title).toBe('Auth');
      expect(result.content).toBe('JWT info');
    });

    it('handles save failure gracefully with synthetic row', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSave.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const result = await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'pattern',
        title: 'Failing save',
        content: 'Some content',
      });

      expect(result.id).toBe(-1);
      expect(result.type).toBe('pattern');
      expect(result.title).toBe('Failing save');
      expect(result.content).toBe('Some content');
      expect(result.filePaths).toBeNull();
      expect(result.severity).toBeNull();
    });

    it('returns synthetic row with provided filePaths and severity on failure', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSave.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const result = await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'discovery',
        title: 'SQL injection',
        content: 'Issue found',
        severity: 'critical',
        filePaths: ['src/db.ts'],
      });

      expect(result.id).toBe(-1);
      expect(result.severity).toBe('critical');
      expect(result.filePaths).toEqual(['src/db.ts']);
    });
  });

  // ── createSession / endSession ──

  describe('createSession()', () => {
    it('delegates to client', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockCreateSession.mockResolvedValue(7);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const session = await storage?.createSession({ project: 'acme/widgets' });

      expect(session).toEqual({ id: 7 });
      expect(mockCreateSession).toHaveBeenCalledWith('acme/widgets');
    });

    it('returns synthetic id when client returns null', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockCreateSession.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const session = await storage?.createSession({ project: 'acme/widgets' });

      expect(session).toEqual({ id: -1 });
    });
  });

  describe('endSession()', () => {
    it('delegates to client', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockEndSession.mockResolvedValue(undefined);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.endSession(7, 'Review completed');

      expect(mockEndSession).toHaveBeenCalledWith(7, 'Review completed');
    });

    it('skips call when sessionId is -1 (synthetic session)', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.endSession(-1, 'Summary');

      expect(mockEndSession).not.toHaveBeenCalled();
    });
  });

  // ── listObservations ──

  describe('listObservations()', () => {
    it('calls client.search with empty query', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.listObservations();

      expect(mockSearch).toHaveBeenCalledWith('', undefined, 20);
    });

    it('applies project and limit options', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.listObservations({ project: 'acme/widgets', limit: 5 });

      expect(mockSearch).toHaveBeenCalledWith('', 'acme/widgets', 5);
    });

    it('applies type filter client-side', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, type: 'pattern' }),
        makeEngramObservation({ id: 2, type: 'bugfix' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.listObservations({ type: 'bugfix' });

      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('bugfix');
    });

    it('applies offset client-side', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, title: 'First' }),
        makeEngramObservation({ id: 2, title: 'Second' }),
        makeEngramObservation({ id: 3, title: 'Third' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.listObservations({ offset: 1 });

      expect(results).toHaveLength(2);
      expect(results[0]?.title).toBe('Second');
    });

    it('returns MemoryObservationDetail shape', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({
          id: 1,
          type: 'pattern',
          title: 'Auth',
          content: 'JWT info\n---\nSource: ghagga',
          project: 'acme/widgets',
          topic_key: 'auth-key',
          revision_count: 2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
        }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.listObservations();

      expect(results[0]).toEqual(
        expect.objectContaining({
          id: 1,
          type: 'pattern',
          title: 'Auth',
          content: 'JWT info',
          project: 'acme/widgets',
          topicKey: 'auth-key',
          revisionCount: 2,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-02T00:00:00Z',
        }),
      );
    });
  });

  // ── getObservation / deleteObservation ──

  describe('getObservation()', () => {
    it('uses idMap to resolve IDs', async () => {
      mockHealthCheck.mockResolvedValue(true);
      // First, populate the idMap via searchObservations
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 'engram-uuid-abc' })]);
      mockGetObservation.mockResolvedValue(makeEngramObservation({ id: 'engram-uuid-abc' }));

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      // Search first to populate the idMap
      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const mappedId = searchResults[0]?.id;

      // Now getObservation should resolve the real ID
      await storage?.getObservation(mappedId);

      expect(mockGetObservation).toHaveBeenCalledWith('engram-uuid-abc');
    });

    it('returns null for unknown IDs (not in idMap)', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const result = await storage?.getObservation(999);

      expect(result).toBeNull();
      expect(mockGetObservation).not.toHaveBeenCalled();
    });

    it('returns null when client returns null', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 42 })]);
      mockGetObservation.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const result = await storage?.getObservation(searchResults[0]?.id);

      expect(result).toBeNull();
    });

    it('returns MemoryObservationDetail on success', async () => {
      mockHealthCheck.mockResolvedValue(true);
      const obs = makeEngramObservation({
        id: 42,
        type: 'bugfix',
        title: 'Fix it',
        content: '[severity:high]\nDetails\n---\nSource: ghagga',
      });
      mockSearch.mockResolvedValue([obs]);
      mockGetObservation.mockResolvedValue(obs);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const detail = await storage?.getObservation(searchResults[0]?.id);

      expect(detail).not.toBeNull();
      expect(detail?.type).toBe('bugfix');
      expect(detail?.title).toBe('Fix it');
      expect(detail?.content).toBe('Details');
      expect(detail?.severity).toBe('high');
    });
  });

  describe('deleteObservation()', () => {
    it('uses idMap to resolve IDs', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 42 })]);
      mockDeleteObservation.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      await storage?.deleteObservation(searchResults[0]?.id);

      expect(mockDeleteObservation).toHaveBeenCalledWith(42);
    });

    it('returns false for unknown IDs (not in idMap)', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const result = await storage?.deleteObservation(999);

      expect(result).toBe(false);
      expect(mockDeleteObservation).not.toHaveBeenCalled();
    });

    it('returns true and clears idMap entry on success', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 42 })]);
      mockDeleteObservation.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const mappedId = searchResults[0]?.id;

      const result = await storage?.deleteObservation(mappedId);
      expect(result).toBe(true);

      // After deletion, the ID should no longer be in the map
      const result2 = await storage?.deleteObservation(mappedId);
      expect(result2).toBe(false);
    });

    it('returns false when client delete fails', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 42 })]);
      mockDeleteObservation.mockResolvedValue(false);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const result = await storage?.deleteObservation(searchResults[0]?.id);

      expect(result).toBe(false);
    });
  });

  // ── getStats ──

  describe('getStats()', () => {
    it('maps Engram stats to MemoryStats', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockGetStats.mockResolvedValue({
        total_observations: 100,
        total_sessions: 5,
        projects: ['acme/widgets', 'acme/gadgets'],
      });

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const stats = await storage?.getStats();

      expect(stats).toEqual({
        totalObservations: 100,
        byType: {},
        byProject: {
          'acme/widgets': 0,
          'acme/gadgets': 0,
        },
        oldestObservation: null,
        newestObservation: null,
      });
    });

    it('handles null stats gracefully', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockGetStats.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const stats = await storage?.getStats();

      expect(stats).toEqual({
        totalObservations: 0,
        byType: {},
        byProject: {},
        oldestObservation: null,
        newestObservation: null,
      });
    });

    it('handles stats without projects array', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockGetStats.mockResolvedValue({
        total_observations: 50,
        total_sessions: 2,
      });

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const stats = await storage?.getStats();

      expect(stats.totalObservations).toBe(50);
      expect(stats.byProject).toEqual({});
    });
  });

  // ── clearObservations ──

  describe('clearObservations()', () => {
    it('returns 0 (not supported)', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const result = await storage?.clearObservations();

      expect(result).toBe(0);
    });

    it('logs warning about unsupported operation', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.clearObservations();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('clearObservations is not supported'),
      );
    });

    it('returns 0 even with project option', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const result = await storage?.clearObservations({ project: 'acme/widgets' });

      expect(result).toBe(0);
    });
  });

  // ── close ──

  describe('close()', () => {
    it('is a no-op (does not throw)', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      await expect(storage?.close()).resolves.toBeUndefined();
    });
  });

  // ── idMap trackId conditional ──

  describe('trackId() — idMap deduplication', () => {
    it('does not overwrite existing idMap entry for the same numeric ID', async () => {
      mockHealthCheck.mockResolvedValue(true);
      // First search populates idMap with id 42 → 'original-engram-id'
      mockSearch.mockResolvedValueOnce([
        makeEngramObservation({ id: 'original-engram-id', content: 'A\n---\nSource: ghagga' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const firstResults = await storage?.searchObservations('owner/repo', 'first');
      const mappedId = firstResults[0]?.id;

      // Second search returns an obs that would hash to the same numeric ID
      // (same engram ID string), but with a different engram ID — the map should keep the first one
      mockSearch.mockResolvedValueOnce([
        makeEngramObservation({ id: 'original-engram-id', content: 'B\n---\nSource: ghagga' }),
      ]);

      await storage?.searchObservations('owner/repo', 'second');

      // getObservation should use the original engram ID (the first one tracked)
      mockGetObservation.mockResolvedValue(makeEngramObservation({ id: 'original-engram-id' }));

      await storage?.getObservation(mappedId);

      expect(mockGetObservation).toHaveBeenCalledWith('original-engram-id');
    });

    it('tracks IDs from saveObservation results', async () => {
      mockHealthCheck.mockResolvedValue(true);
      const savedObs = makeEngramObservation({
        id: 'saved-uuid',
        type: 'pattern',
        title: 'Saved',
        content: 'Content\n---\nSource: ghagga',
      });
      mockSave.mockResolvedValue(savedObs);
      mockGetObservation.mockResolvedValue(savedObs);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const result = await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'pattern',
        title: 'Saved',
        content: 'Content',
      });

      // Now getObservation should be able to resolve the saved ID
      await storage?.getObservation(result.id);

      expect(mockGetObservation).toHaveBeenCalledWith('saved-uuid');
    });

    it('tracks IDs from listObservations results', async () => {
      mockHealthCheck.mockResolvedValue(true);
      const obs = makeEngramObservation({
        id: 'listed-uuid',
        content: 'Content\n---\nSource: ghagga',
      });
      mockSearch.mockResolvedValue([obs]);
      mockGetObservation.mockResolvedValue(obs);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const listed = await storage?.listObservations();
      await storage?.getObservation(listed[0]?.id);

      expect(mockGetObservation).toHaveBeenCalledWith('listed-uuid');
    });
  });

  // ── Warning messages ──

  describe('warning messages', () => {
    it('clearObservations warns with exact unsupported message', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.clearObservations();

      expect(warnSpy).toHaveBeenCalledWith(
        '[ghagga:engram] clearObservations is not supported with the Engram backend. ' +
          'Use the "engram" CLI directly for bulk deletion.',
      );
    });

    it('saveObservation warns with exact message on failure', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSave.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.saveObservation({
        project: 'acme/widgets',
        type: 'pattern',
        title: 'Title',
        content: 'Content',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        '[ghagga:engram] saveObservation: Engram save failed, returning synthetic row',
      );
    });

    it('createSession warns with exact message on failure', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockCreateSession.mockResolvedValue(null);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.createSession({ project: 'acme/widgets' });

      expect(warnSpy).toHaveBeenCalledWith(
        '[ghagga:engram] createSession failed, returning synthetic id',
      );
    });

    it('getObservation warns with exact message when ID not in map', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.getObservation(12345);

      expect(warnSpy).toHaveBeenCalledWith(
        '[ghagga:engram] getObservation: ID %d not found in local map. ' +
          'Run searchObservations or listObservations first.',
        12345,
      );
    });

    it('deleteObservation warns with exact message when ID not in map', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.deleteObservation(12345);

      expect(warnSpy).toHaveBeenCalledWith(
        '[ghagga:engram] deleteObservation: ID %d not found in local map.',
        12345,
      );
    });
  });

  // ── endSession -1 edge cases ──

  describe('endSession -1 handling', () => {
    it('does not call client.endSession when sessionId is -1', async () => {
      mockHealthCheck.mockResolvedValue(true);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.endSession(-1, 'Some summary');

      expect(mockEndSession).not.toHaveBeenCalled();
    });

    it('does call client.endSession when sessionId is 0', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockEndSession.mockResolvedValue(undefined);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.endSession(0, 'Some summary');

      expect(mockEndSession).toHaveBeenCalledWith(0, 'Some summary');
    });

    it('does call client.endSession when sessionId is 1', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockEndSession.mockResolvedValue(undefined);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      await storage?.endSession(1, 'Another summary');

      expect(mockEndSession).toHaveBeenCalledWith(1, 'Another summary');
    });
  });

  // ── deleteObservation idMap cleanup ──

  describe('deleteObservation idMap cleanup edge case', () => {
    it('does not remove idMap entry when delete fails', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([makeEngramObservation({ id: 42 })]);
      mockDeleteObservation.mockResolvedValue(false);
      mockGetObservation.mockResolvedValue(makeEngramObservation({ id: 42 }));

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });

      const searchResults = await storage?.searchObservations('owner/repo', 'test');
      const mappedId = searchResults[0]?.id;

      // Delete fails
      const deleted = await storage?.deleteObservation(mappedId);
      expect(deleted).toBe(false);

      // ID should still be in the map — getObservation should still work
      const obs = await storage?.getObservation(mappedId);
      expect(obs).not.toBeNull();
      expect(mockGetObservation).toHaveBeenCalledWith(42);
    });
  });

  // ── listObservations offset edge cases ──

  describe('listObservations offset edge cases', () => {
    it('does not apply offset when offset is 0', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, title: 'First' }),
        makeEngramObservation({ id: 2, title: 'Second' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.listObservations({ offset: 0 });

      expect(results).toHaveLength(2);
    });

    it('does not apply offset when not provided', async () => {
      mockHealthCheck.mockResolvedValue(true);
      mockSearch.mockResolvedValue([
        makeEngramObservation({ id: 1, title: 'First' }),
        makeEngramObservation({ id: 2, title: 'Second' }),
      ]);

      const storage = await EngramMemoryStorage.create({
        host: 'http://localhost:7437',
        timeout: 5000,
      });
      const results = await storage?.listObservations({});

      expect(results).toHaveLength(2);
    });
  });
});
