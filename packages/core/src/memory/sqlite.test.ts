import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embed.js';
import { SqliteMemoryStorage } from './sqlite.js';

// ─── Test Setup ─────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghagga-sqlite-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────

function makeObservationData(
  overrides: Partial<{
    sessionId: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey: string;
    filePaths: string[];
  }> = {},
) {
  return {
    project: 'owner/repo',
    type: 'pattern',
    title: 'Test observation',
    content: 'Some content about auth patterns.',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('SqliteMemoryStorage', () => {
  // ── Schema Initialization ──

  describe('create()', () => {
    it('initializes schema with required tables and FTS5', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;

      // Check memory_sessions table exists
      const sessions = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_sessions'",
      );
      expect(sessions).toHaveLength(1);

      // Check memory_observations table exists
      const observations = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_observations'",
      );
      expect(observations).toHaveLength(1);

      // Check FTS5 virtual table exists
      const fts = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_observations_fts'",
      );
      expect(fts).toHaveLength(1);

      // Check indexes exist
      const indexes = db.exec(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_obs_%'",
      );
      expect(indexes[0]?.values.length).toBeGreaterThanOrEqual(3);

      await storage.close();
    });

    it('migrates a legacy DB (no last_accessed_at column) that already has rows', async () => {
      // Build a pre-migration database: observations table WITHOUT severity /
      // last_accessed_at / embedding, with the FTS index populated via trigger,
      // and one existing row. SQLite forbids non-constant defaults in
      // ALTER TABLE ADD COLUMN, so the old migration always failed here.
      const sqlJsModule = (await import('fts5-sql-bundle')).default;
      const initSqlJs =
        typeof sqlJsModule === 'function'
          ? sqlJsModule
          : (sqlJsModule as unknown as { initSqlJs: typeof sqlJsModule }).initSqlJs;
      const SQL = await initSqlJs();
      const legacy = new SQL.Database();
      legacy.run(`
        CREATE TABLE memory_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER,
          project TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          topic_key TEXT,
          file_paths TEXT DEFAULT '[]',
          content_hash TEXT,
          revision_count INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE memory_observations_fts
          USING fts5(title, content, content='memory_observations', content_rowid='id');
        CREATE TRIGGER obs_fts_insert AFTER INSERT ON memory_observations BEGIN
          INSERT INTO memory_observations_fts(rowid, title, content)
            VALUES (new.id, new.title, new.content);
        END;
        INSERT INTO memory_observations (project, type, title, content, updated_at)
          VALUES ('owner/repo', 'pattern', 'Legacy auth note',
                  'JWT auth validation pattern.', datetime('now', '-1 day'));
      `);
      writeFileSync(dbPath, Buffer.from(legacy.export()));
      legacy.close();

      // Opening with the current backend must add the column and backfill it
      const storage = await SqliteMemoryStorage.create(dbPath);
      // biome-ignore lint/suspicious/noExplicitAny: test access to private db
      const db = (storage as any).db;

      const col = db.exec(
        "SELECT name FROM pragma_table_info('memory_observations') WHERE name = 'last_accessed_at'",
      );
      expect(col).toHaveLength(1);

      // Backfill: last_accessed_at must equal updated_at for the legacy row
      const row = db.exec('SELECT last_accessed_at, updated_at FROM memory_observations')[0]
        ?.values[0];
      expect(row?.[0]).not.toBeNull();
      expect(row?.[0]).toBe(row?.[1]);

      // Queries referencing the migrated column must work (this used to throw)
      const results = await storage.searchObservations('owner/repo', 'auth');
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Legacy auth note');

      await storage.close();
    });

    it('adds embedding_model/embedding_dim columns to a legacy DB with existing rows, both NULL, no error', async () => {
      // Build a pre-migration database: observations table WITHOUT
      // embedding_model / embedding_dim, with one existing row.
      const sqlJsModule = (await import('fts5-sql-bundle')).default;
      const initSqlJs =
        typeof sqlJsModule === 'function'
          ? sqlJsModule
          : (sqlJsModule as unknown as { initSqlJs: typeof sqlJsModule }).initSqlJs;
      const SQL = await initSqlJs();
      const legacy = new SQL.Database();
      legacy.run(`
        CREATE TABLE memory_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER,
          project TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          severity TEXT,
          topic_key TEXT,
          file_paths TEXT DEFAULT '[]',
          content_hash TEXT,
          revision_count INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          embedding BLOB
        );
        CREATE VIRTUAL TABLE memory_observations_fts
          USING fts5(title, content, content='memory_observations', content_rowid='id');
        CREATE TRIGGER obs_fts_insert AFTER INSERT ON memory_observations BEGIN
          INSERT INTO memory_observations_fts(rowid, title, content)
            VALUES (new.id, new.title, new.content);
        END;
        INSERT INTO memory_observations (project, type, title, content)
          VALUES ('owner/repo', 'pattern', 'Pre-embedding note', 'Some note before metadata columns existed.');
      `);
      writeFileSync(dbPath, Buffer.from(legacy.export()));
      legacy.close();

      // Opening with the current backend must add both columns without error
      const storage = await SqliteMemoryStorage.create(dbPath);
      // biome-ignore lint/suspicious/noExplicitAny: test access to private db
      const db = (storage as any).db;

      const cols = db.exec(
        "SELECT name FROM pragma_table_info('memory_observations') WHERE name IN ('embedding_model', 'embedding_dim')",
      );
      expect(cols[0]?.values.map((v: unknown[]) => v[0]).sort()).toEqual([
        'embedding_dim',
        'embedding_model',
      ]);

      // Existing row reads back with both new columns NULL
      const row = db.exec(
        'SELECT embedding_model, embedding_dim FROM memory_observations WHERE title = ?',
        ['Pre-embedding note'],
      )[0]?.values[0];
      expect(row?.[0]).toBeNull();
      expect(row?.[1]).toBeNull();

      // Queries against the table still work post-migration
      const results = await storage.searchObservations('owner/repo', 'note');
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Pre-embedding note');

      await storage.close();
    });

    it('creates embedding_model/embedding_dim as NULL on a fresh DB', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;

      const row = await storage.saveObservation(makeObservationData());

      const result = db.exec(
        `SELECT embedding_model, embedding_dim FROM memory_observations WHERE id = ${row.id}`,
      )[0]?.values[0];
      expect(result?.[0]).toBeNull();
      expect(result?.[1]).toBeNull();

      await storage.close();
    });
  });

  // ── saveObservation — Insert ──

  describe('saveObservation()', () => {
    it('inserts a new observation and returns correct row shape', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const row = await storage.saveObservation(makeObservationData());

      expect(row).toEqual({
        id: expect.any(Number),
        type: 'pattern',
        title: 'Test observation',
        content: 'Some content about auth patterns.',
        filePaths: expect.any(Array),
        severity: null,
      });
      expect(row.id).toBeGreaterThan(0);

      await storage.close();
    });

    it('serializes filePaths as JSON and deserializes on return', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const row = await storage.saveObservation(
        makeObservationData({ filePaths: ['src/auth.ts', 'src/login.ts'] }),
      );

      expect(row.filePaths).toEqual(['src/auth.ts', 'src/login.ts']);

      await storage.close();
    });

    it('defaults filePaths to empty array when not provided', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const row = await storage.saveObservation(makeObservationData());

      expect(row.filePaths).toEqual([]);

      await storage.close();
    });

    it('links observation to session when sessionId is provided', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const session = await storage.createSession({ project: 'owner/repo', prNumber: 1 });
      const row = await storage.saveObservation(makeObservationData({ sessionId: session.id }));

      // Verify via raw SQL
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      const result = db.exec(`SELECT session_id FROM memory_observations WHERE id = ${row.id}`);
      expect(result[0]?.values[0]?.[0]).toBe(session.id);

      await storage.close();
    });
  });

  // ── Content-Hash Dedup ──

  describe('content-hash deduplication', () => {
    it('returns existing row when same content is saved within 15-minute window', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);
      const data = makeObservationData();

      const first = await storage.saveObservation(data);
      const second = await storage.saveObservation(data);

      expect(second.id).toBe(first.id);
      expect(second.title).toBe(first.title);

      await storage.close();
    });

    it('creates new row when same content is saved to different project', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const first = await storage.saveObservation(makeObservationData({ project: 'org/repo-a' }));
      const second = await storage.saveObservation(makeObservationData({ project: 'org/repo-b' }));

      expect(second.id).not.toBe(first.id);

      await storage.close();
    });

    it('respects a custom dedup window of 0 minutes (no dedup)', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath, { dedupWindowMinutes: 0 });
      const data = makeObservationData();

      const first = await storage.saveObservation(data);
      const second = await storage.saveObservation(data);

      // With 0-minute window, dedup should not match — new row created
      expect(second.id).not.toBe(first.id);

      await storage.close();
    });

    it('uses default 15-minute dedup window when no option is provided', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);
      const data = makeObservationData();

      const first = await storage.saveObservation(data);
      const second = await storage.saveObservation(data);

      // Default 15-minute window — same content within window should dedup
      expect(second.id).toBe(first.id);

      await storage.close();
    });

    it('deduplicates within a custom large dedup window', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath, { dedupWindowMinutes: 60 });
      const data = makeObservationData();

      const first = await storage.saveObservation(data);
      const second = await storage.saveObservation(data);

      // 60-minute window — same content within window should dedup
      expect(second.id).toBe(first.id);

      await storage.close();
    });

    it('creates new row when content differs (different hash)', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const first = await storage.saveObservation(
        makeObservationData({ content: 'Version A content' }),
      );
      const second = await storage.saveObservation(
        makeObservationData({ content: 'Version B content' }),
      );

      expect(second.id).not.toBe(first.id);

      await storage.close();
    });
  });

  // ── TopicKey Upsert ──

  describe('topicKey upsert', () => {
    it('updates existing observation when same topicKey and project', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const first = await storage.saveObservation(
        makeObservationData({
          topicKey: 'auth-pattern',
          content: 'Original content',
          title: 'Original title',
        }),
      );

      const second = await storage.saveObservation(
        makeObservationData({
          topicKey: 'auth-pattern',
          content: 'Updated content',
          title: 'Updated title',
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.content).toBe('Updated content');
      expect(second.title).toBe('Updated title');

      await storage.close();
    });

    it('creates new row when same topicKey but different project', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const first = await storage.saveObservation(
        makeObservationData({
          project: 'org/repo-a',
          topicKey: 'shared-key',
        }),
      );

      const second = await storage.saveObservation(
        makeObservationData({
          project: 'org/repo-b',
          topicKey: 'shared-key',
        }),
      );

      expect(second.id).not.toBe(first.id);

      await storage.close();
    });

    it('increments revision_count on upsert', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const first = await storage.saveObservation(
        makeObservationData({
          topicKey: 'evolving-topic',
          content: 'Version 1',
        }),
      );

      // Upsert with new content
      await storage.saveObservation(
        makeObservationData({
          topicKey: 'evolving-topic',
          content: 'Version 2',
        }),
      );

      // Query raw SQL to check revision_count
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      const result = db.exec(
        `SELECT revision_count FROM memory_observations WHERE id = ${first.id}`,
      );
      expect(result[0]?.values[0]?.[0]).toBe(2);

      await storage.close();
    });
  });

  // ── searchObservations ──

  describe('searchObservations()', () => {
    it('finds observations by FTS5 keyword match', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          title: 'Authentication pattern',
          content: 'JWT tokens should be validated on every request.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'authentication JWT');

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Authentication pattern');

      await storage.close();
    });

    it('returns empty array when no match found', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(makeObservationData());

      const results = await storage.searchObservations('owner/repo', 'nonexistent xyz');

      expect(results).toHaveLength(0);

      await storage.close();
    });

    it('scopes results to the specified project', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          project: 'org/project-a',
          title: 'Auth in project A',
          content: 'Auth content for project A.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'org/project-b',
          title: 'Auth in project B',
          content: 'Auth content for project B.',
        }),
      );

      const results = await storage.searchObservations('org/project-a', 'Auth');

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Auth in project A');

      await storage.close();
    });

    it('filters by type when specified', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({ type: 'pattern', content: 'Security pattern found.' }),
      );
      await storage.saveObservation(
        makeObservationData({
          type: 'bugfix',
          title: 'Fixed security bug',
          content: 'Security bugfix applied.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'security', {
        type: 'bugfix',
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('bugfix');

      await storage.close();
    });

    it('respects the limit parameter', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      for (let i = 0; i < 5; i++) {
        await storage.saveObservation(
          makeObservationData({
            title: `Performance observation ${i}`,
            content: `Performance issue number ${i} detected.`,
          }),
        );
      }

      const results = await storage.searchObservations('owner/repo', 'performance', { limit: 2 });

      expect(results).toHaveLength(2);

      await storage.close();
    });

    it('returns empty array for empty query string', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(makeObservationData());

      const results = await storage.searchObservations('owner/repo', '');

      expect(results).toHaveLength(0);

      await storage.close();
    });

    it('returns empty array for whitespace-only query', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(makeObservationData());

      const results = await storage.searchObservations('owner/repo', '   ');

      expect(results).toHaveLength(0);

      await storage.close();
    });

    it('returns correct MemoryObservationRow shape with filePaths', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          filePaths: ['src/auth.ts', 'src/middleware.ts'],
          title: 'Middleware auth',
          content: 'Middleware handles auth validation.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'middleware');

      expect(results[0]).toEqual({
        id: expect.any(Number),
        type: 'pattern',
        title: 'Middleware auth',
        content: 'Middleware handles auth validation.',
        filePaths: ['src/auth.ts', 'src/middleware.ts'],
        severity: null,
        strength: expect.any(Number),
      });

      await storage.close();
    });
  });

  // ── Hybrid Search (BM25 + semantic) ──
  //
  // Real round-trip tests: no DB mocks. Embeddings are serialized into the
  // sql.js BLOB column on save and deserialized from Uint8Array on search,
  // so these tests cover both the deserialization path and the BM25
  // normalization (FTS5 bm25() is MORE NEGATIVE = BETTER).

  describe('hybrid search (real round-trip)', () => {
    /** Deterministic embedding provider: vector depends only on the text */
    function makeEmbeddingProvider(vectorFor: (text: string) => number[]): EmbeddingProvider {
      const dimension = vectorFor('probe').length;
      return {
        dimension,
        embed: async (text: string) => vectorFor(text),
        embedBatch: async (texts: string[]) => texts.map(vectorFor),
      };
    }

    it('semantic match outranks a stronger keyword match (cosine contributes)', async () => {
      // Texts containing 'rotate' (and the query itself) share one vector;
      // everything else is orthogonal — so cosine only rewards the rotate doc.
      const vectorFor = (text: string) => (text.includes('rotate') ? [1, 0, 0] : [0, 1, 0]);
      const storage = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(vectorFor),
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'Credential rotation policy',
          content: 'We rotate secrets regularly.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          title: 'token validation',
          content: 'token token token token parsing and token checks.',
        }),
      );
      // Unrelated filler so FTS5 idf is non-degenerate
      await storage.saveObservation(
        makeObservationData({
          title: 'Database indexing notes',
          content: 'Indexes speed up reads.',
        }),
      );

      // Query matches 'token' (keyword-best doc) AND embeds to the rotate vector
      const hybridResults = await storage.searchObservations('owner/repo', 'token rotate');

      expect(hybridResults.length).toBeGreaterThanOrEqual(2);
      // 0.7 * cosine dominates: the semantic match must rank first even though
      // the token-spam doc is the far better keyword match
      expect(hybridResults[0]?.title).toBe('Credential rotation policy');

      await storage.close();

      // Control: keyword-only search over the SAME data ranks the token doc
      // first — proving cosine (i.e. embedding deserialization) changed the order
      const keywordStorage = await SqliteMemoryStorage.create(dbPath);
      const keywordResults = await keywordStorage.searchObservations('owner/repo', 'token rotate');
      expect(keywordResults[0]?.title).toBe('token validation');
      await keywordStorage.close();
    });

    it('best BM25 match ranks first when cosine ties (normalization not inverted)', async () => {
      // Both keyword-matching texts embed to the same vector → cosine ties
      // between them and ranking is decided by the positional-rank keyword
      // score (design D5). The filler doc embeds orthogonally so it is a
      // valid (but lowest-scoring) cosine-union candidate, not a tie — this
      // also exercises the union surfacing a lexically-disjoint doc (R5.7)
      // without disturbing the original tie-break assertion below.
      const vectorFor = (text: string) => (text.includes('token') ? [1, 0, 0] : [0, 1, 0]);
      const storage = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(vectorFor),
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'token heavy',
          content: 'token token token token token everywhere.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          title: 'token light',
          content: 'a single token mention.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          title: 'Unrelated filler',
          content: 'Nothing relevant here.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'token');

      // The union brings in all 3 (filler now reachable as a vector-only
      // candidate), but its orthogonal embedding + zero keyword score put it
      // last, deterministically.
      expect(results.length).toBe(3);
      // FTS5 bm25() is MORE NEGATIVE = BETTER: the heavy doc must map to the
      // best positional rank (1), not the worst (the old formula gave the
      // best match the WORST normalized score)
      expect(results[0]?.title).toBe('token heavy');
      expect(results[1]?.title).toBe('token light');
      expect(results[2]?.title).toBe('Unrelated filler');

      await storage.close();
    });

    it('skips cosine on dimension mismatch and falls back to BM25 order', async () => {
      // Save with a 3-dim provider...
      const storage3d = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(() => [1, 0, 0]),
      });
      await storage3d.saveObservation(
        makeObservationData({
          title: 'token heavy',
          content: 'token token token token token everywhere.',
        }),
      );
      await storage3d.saveObservation(
        makeObservationData({
          title: 'token light',
          content: 'a single token mention.',
        }),
      );
      await storage3d.close();

      // ...then search with a 4-dim provider: stored vectors must be skipped
      const storage4d = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(() => [1, 0, 0, 0]),
      });
      const results = await storage4d.searchObservations('owner/repo', 'token');

      // No throw, and order falls back to BM25 (cosine contributed 0 for all)
      expect(results[0]?.title).toBe('token heavy');
      await storage4d.close();
    });
  });

  // ── Cosine Union (Phase 3 — spec R5.7-R5.11, design D3-D5) ──
  //
  // Unlike the "hybrid search" re-rank tests above, these exercise the
  // bounded cosine CANDIDATE query itself: a lexically-disjoint observation
  // (no FTS5 match at all) must still be retrievable when it clears the
  // cosine bar, and the `none`-parity acceptance gate proves the keyword-only
  // path never runs the union logic.

  describe('cosine union (Phase 3)', () => {
    function makeEmbeddingProvider(vectorFor: (text: string) => number[]): EmbeddingProvider {
      const dimension = vectorFor('probe').length;
      return {
        dimension,
        embed: async (text: string) => vectorFor(text),
        embedBatch: async (texts: string[]) => texts.map(vectorFor),
      };
    }

    it('[3.7 acceptance gate] none provider: output/order/last_accessed_at identical to the pre-union keyword-only path', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath); // no embeddingProvider

      await storage.saveObservation(
        makeObservationData({
          title: 'Alpha token match',
          content: 'token token token strong match.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({ title: 'Beta token match', content: 'a single token mention.' }),
      );
      // Lexically disjoint from the query — must stay unreachable without a
      // provider, proving no cosine candidate set is ever computed (R5.11).
      await storage.saveObservation(
        makeObservationData({
          title: 'Gamma unrelated',
          content: 'Completely unrelated content, zero overlap.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'token');

      // Exact row/order/shape match — only the two lexical matches, BM25-ordered.
      expect(results).toEqual([
        {
          id: expect.any(Number),
          type: 'pattern',
          title: 'Alpha token match',
          content: 'token token token strong match.',
          filePaths: [],
          severity: null,
          strength: 1,
        },
        {
          id: expect.any(Number),
          type: 'pattern',
          title: 'Beta token match',
          content: 'a single token mention.',
          filePaths: [],
          severity: null,
          strength: 1,
        },
      ]);

      // last_accessed_at updated ONLY for the two returned (lexically matched) rows
      // biome-ignore lint/suspicious/noExplicitAny: test access to private db
      const db = (storage as any).db;
      const unchanged = db.exec(
        "SELECT updated_at, last_accessed_at FROM memory_observations WHERE title = 'Gamma unrelated'",
      )[0]?.values[0];
      expect(unchanged?.[1]).toBe(unchanged?.[0]); // last_accessed_at still equals its initial value

      await storage.close();
    });

    it('[3.8] surfaces a lexically-disjoint semantic match via the cosine union', async () => {
      const vectorFor = (text: string) =>
        text.includes('credential') || text.includes('secret') ? [1, 0, 0] : [0, 1, 0];
      const storage = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(vectorFor),
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'Credential exposure in logs',
          content: 'Application logs printed raw credential values in plaintext.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          title: 'Unrelated filler',
          content: 'Completely unrelated content about database indexing.',
        }),
      );

      // No literal token overlap with either doc — only reachable via cosine.
      // Both docs are embedded (so both are in the bounded cosine candidate
      // set), but 'Credential exposure' ties the query vector while 'Unrelated
      // filler' is orthogonal (cosineSim 0) — it must rank strictly first.
      const results = await storage.searchObservations('owner/repo', 'secret leakage');

      expect(results.some((r) => r.title === 'Credential exposure in logs')).toBe(true);
      expect(results[0]?.title).toBe('Credential exposure in logs');

      await storage.close();
    });

    it('[3.8] dedups a candidate present in both keyword and cosine sets, using its real keyword score', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(() => [1, 0, 0]), // all docs tie on cosine
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'Overlap doc',
          content: 'overlap keyword and cosine both match this doc.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          title: 'Vector-only doc',
          content: 'no lexical overlap here at all.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'overlap');

      // Exactly 2 rows (no duplicate for the doc matched by both sources)
      expect(results).toHaveLength(2);
      // 'Overlap doc' matches keyword AND cosine → real keyword score (1),
      // not the vector-only 0 → higher finalScore → ranks first
      expect(results[0]?.title).toBe('Overlap doc');
      expect(results[1]?.title).toBe('Vector-only doc');

      await storage.close();
    });

    it('[3.8] excludes mixed-dimension rows from the cosine candidate set without error', async () => {
      // Save with a 3-dim provider — this doc has NO lexical overlap with the query
      const storage3d = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(() => [1, 0, 0]),
      });
      await storage3d.saveObservation(
        makeObservationData({
          title: 'Vector-only 3d doc',
          content: 'photonic entanglement drift ratio measurements.',
        }),
      );
      await storage3d.close();

      // Search with a 4-dim provider: the stored 3-dim embedding must be
      // excluded from the cosine candidate set entirely — never surfaced,
      // never thrown (task 3.2 read guard). Query shares no literal token
      // with the doc, so it cannot be reached via the keyword path either.
      const storage4d = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(() => [1, 0, 0, 0]),
      });
      const results = await storage4d.searchObservations('owner/repo', 'zephyr cascade unrelated');

      expect(results).toHaveLength(0);
      await storage4d.close();
    });

    it('[3.8] returns correctly with a partial-backfill mix of NULL and embedded rows', async () => {
      const vectorFor = (text: string) =>
        text.includes('alpha-trigger') || text.includes('beta-trigger') ? [1, 0, 0] : [0, 1, 0];
      const storage = await SqliteMemoryStorage.create(dbPath, {
        embeddingProvider: makeEmbeddingProvider(vectorFor),
      });

      // Embedded row: no literal token overlap with the query — only reachable via cosine
      await storage.saveObservation(
        makeObservationData({
          title: 'Vectorized doc',
          content: 'contains the beta-trigger marker only.',
        }),
      );

      // Simulate a NULL-embedding row (pre-backfill state) that DOES share a
      // literal keyword with the query — reachable only via the keyword path.
      await storage.saveObservation(
        makeObservationData({
          title: 'Legacy keyword doc',
          content: 'this legacy row matches on plainkeyword.',
        }),
      );
      // biome-ignore lint/suspicious/noExplicitAny: test access to private db
      const db = (storage as any).db;
      db.run(
        "UPDATE memory_observations SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL WHERE title = 'Legacy keyword doc'",
      );

      const results = await storage.searchObservations('owner/repo', 'alpha-trigger plainkeyword');

      const titles = results.map((r) => r.title).sort();
      expect(titles).toEqual(['Legacy keyword doc', 'Vectorized doc']);

      await storage.close();
    });
  });

  // ── Session Lifecycle ──

  describe('session lifecycle', () => {
    it('createSession returns an auto-incremented id', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const session1 = await storage.createSession({ project: 'owner/repo', prNumber: 1 });
      const session2 = await storage.createSession({ project: 'owner/repo', prNumber: 2 });

      expect(session1.id).toBeGreaterThan(0);
      expect(session2.id).toBe(session1.id + 1);

      await storage.close();
    });

    it('endSession sets ended_at and summary', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const session = await storage.createSession({ project: 'owner/repo', prNumber: 1 });
      await storage.endSession(session.id, 'Review completed with 3 findings.');

      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      const result = db.exec(
        `SELECT ended_at, summary FROM memory_sessions WHERE id = ${session.id}`,
      );
      expect(result[0]?.values[0]?.[0]).not.toBeNull(); // ended_at is set
      expect(result[0]?.values[0]?.[1]).toBe('Review completed with 3 findings.');

      await storage.close();
    });

    it('createSession accepts optional prNumber', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const session = await storage.createSession({ project: 'owner/repo' });

      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      const result = db.exec(`SELECT pr_number FROM memory_sessions WHERE id = ${session.id}`);
      expect(result[0]?.values[0]?.[0]).toBeNull();

      await storage.close();
    });
  });

  // ── close() and File Persistence ──

  describe('close()', () => {
    it('writes database file to disk', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(makeObservationData());
      await storage.close();

      expect(existsSync(dbPath)).toBe(true);
    });

    it('creates parent directories if they do not exist', async () => {
      const nestedPath = join(tmpDir, 'nested', 'dir', 'memory.db');
      const storage = await SqliteMemoryStorage.create(nestedPath);

      await storage.close();

      expect(existsSync(nestedPath)).toBe(true);
    });

    it('persists data that can be reopened', async () => {
      // Write data and close
      const storage1 = await SqliteMemoryStorage.create(dbPath);
      await storage1.saveObservation(
        makeObservationData({
          title: 'Persistent observation',
          content: 'This should survive close and reopen.',
        }),
      );
      await storage1.close();

      // Reopen and verify data persists
      const storage2 = await SqliteMemoryStorage.create(dbPath);
      const results = await storage2.searchObservations('owner/repo', 'persistent');

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Persistent observation');

      await storage2.close();
    });
  });

  // ── listObservations ──

  describe('listObservations()', () => {
    it('returns all observations newest first when no filters are set', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      // Insert 3 observations, then set distinct timestamps via raw SQL
      // to guarantee ORDER BY created_at DESC produces a deterministic order
      await storage.saveObservation(
        makeObservationData({ title: 'Oldest', content: 'Oldest observation content.' }),
      );
      await storage.saveObservation(
        makeObservationData({ title: 'Middle', content: 'Middle observation content.' }),
      );
      await storage.saveObservation(
        makeObservationData({ title: 'Newest', content: 'Newest observation content.' }),
      );

      // Manually stagger created_at so ordering is deterministic
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      db.run(
        "UPDATE memory_observations SET created_at = '2025-01-01 00:00:00' WHERE title = 'Oldest'",
      );
      db.run(
        "UPDATE memory_observations SET created_at = '2025-01-02 00:00:00' WHERE title = 'Middle'",
      );
      db.run(
        "UPDATE memory_observations SET created_at = '2025-01-03 00:00:00' WHERE title = 'Newest'",
      );

      const results = await storage.listObservations();

      expect(results).toHaveLength(3);
      // newest first (created_at DESC)
      expect(results[0]?.title).toBe('Newest');
      expect(results[1]?.title).toBe('Middle');
      expect(results[2]?.title).toBe('Oldest');

      // Verify shape: each result is a MemoryObservationDetail
      for (const obs of results) {
        expect(obs).toEqual(
          expect.objectContaining({
            id: expect.any(Number),
            type: expect.any(String),
            title: expect.any(String),
            content: expect.any(String),
            project: expect.any(String),
            revisionCount: expect.any(Number),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          }),
        );
      }

      await storage.close();
    });

    it('filters by project when project option is provided', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          title: 'Widget obs',
          content: 'Widget content.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/gadgets',
          title: 'Gadget obs',
          content: 'Gadget content.',
        }),
      );

      const results = await storage.listObservations({ project: 'acme/widgets' });

      expect(results).toHaveLength(1);
      expect(results[0]?.project).toBe('acme/widgets');
      expect(results[0]?.title).toBe('Widget obs');

      await storage.close();
    });

    it('filters by type when type option is provided', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({ type: 'pattern', title: 'Pattern obs', content: 'Pattern content.' }),
      );
      await storage.saveObservation(
        makeObservationData({ type: 'bugfix', title: 'Bugfix obs', content: 'Bugfix content.' }),
      );
      await storage.saveObservation(
        makeObservationData({
          type: 'learning',
          title: 'Learning obs',
          content: 'Learning content.',
        }),
      );

      const results = await storage.listObservations({ type: 'pattern' });

      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('pattern');
      expect(results[0]?.title).toBe('Pattern obs');

      await storage.close();
    });

    it('combines project and type filters', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'bugfix',
          title: 'Widget bugfix',
          content: 'Widget bugfix content.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'pattern',
          title: 'Widget pattern',
          content: 'Widget pattern content.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/gadgets',
          type: 'bugfix',
          title: 'Gadget bugfix',
          content: 'Gadget bugfix content.',
        }),
      );

      const results = await storage.listObservations({ project: 'acme/widgets', type: 'bugfix' });

      expect(results).toHaveLength(1);
      expect(results[0]?.project).toBe('acme/widgets');
      expect(results[0]?.type).toBe('bugfix');
      expect(results[0]?.title).toBe('Widget bugfix');

      await storage.close();
    });

    it('respects custom limit', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      for (let i = 0; i < 5; i++) {
        await storage.saveObservation(
          makeObservationData({
            title: `Observation ${i}`,
            content: `Content for observation ${i}.`,
          }),
        );
      }

      const results = await storage.listObservations({ limit: 2 });

      expect(results).toHaveLength(2);

      await storage.close();
    });

    it('returns empty array when no observations match', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const results = await storage.listObservations();

      expect(results).toEqual([]);

      await storage.close();
    });
  });

  // ── getObservation ──

  describe('getObservation()', () => {
    it('returns full MemoryObservationDetail for an existing observation', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const saved = await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'pattern',
          title: 'OAuth token refresh patterns',
          content: 'Full multi-line content about OAuth.',
          topicKey: 'auth-token-refresh',
          filePaths: ['src/auth.ts', 'lib/token.ts'],
        }),
      );

      const detail = await storage.getObservation(saved.id);

      expect(detail).not.toBeNull();
      expect(detail?.id).toBe(saved.id);
      expect(detail?.type).toBe('pattern');
      expect(detail?.title).toBe('OAuth token refresh patterns');
      expect(detail?.content).toBe('Full multi-line content about OAuth.');
      expect(detail?.filePaths).toEqual(['src/auth.ts', 'lib/token.ts']);
      expect(detail?.project).toBe('acme/widgets');
      expect(detail?.topicKey).toBe('auth-token-refresh');
      expect(detail?.revisionCount).toBe(1);
      expect(detail?.createdAt).toEqual(expect.any(String));
      expect(detail?.updatedAt).toEqual(expect.any(String));

      await storage.close();
    });

    it('returns null for a non-existent observation ID', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const detail = await storage.getObservation(999);

      expect(detail).toBeNull();

      await storage.close();
    });
  });

  // ── deleteObservation ──

  describe('deleteObservation()', () => {
    it('returns true when observation is found and deleted', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const saved = await storage.saveObservation(
        makeObservationData({ title: 'To delete', content: 'Content to delete.' }),
      );

      const result = await storage.deleteObservation(saved.id);

      expect(result).toBe(true);

      // Verify it's gone
      const detail = await storage.getObservation(saved.id);
      expect(detail).toBeNull();

      await storage.close();
    });

    it('returns false when observation ID does not exist', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const result = await storage.deleteObservation(999);

      expect(result).toBe(false);

      await storage.close();
    });

    it('cleans up FTS5 index so searchObservations returns empty after delete', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const saved = await storage.saveObservation(
        makeObservationData({
          title: 'FTS5 cleanup target',
          content: 'Unique xylophone content for FTS5 verification.',
        }),
      );

      // Verify it can be found via search before delete
      const beforeDelete = await storage.searchObservations('owner/repo', 'xylophone');
      expect(beforeDelete).toHaveLength(1);

      // Delete the observation
      await storage.deleteObservation(saved.id);

      // Verify FTS5 is cleaned up — search should return empty
      const afterDelete = await storage.searchObservations('owner/repo', 'xylophone');
      expect(afterDelete).toHaveLength(0);

      await storage.close();
    });
  });

  // ── getStats ──

  describe('getStats()', () => {
    it('returns correct stats for populated database', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      // Insert observations across multiple types and projects
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'pattern',
          title: 'Pattern 1',
          content: 'Pattern content 1.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'pattern',
          title: 'Pattern 2',
          content: 'Pattern content 2.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          type: 'bugfix',
          title: 'Bugfix 1',
          content: 'Bugfix content 1.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/gadgets',
          type: 'learning',
          title: 'Learning 1',
          content: 'Learning content 1.',
        }),
      );

      const stats = await storage.getStats();

      expect(stats.totalObservations).toBe(4);
      expect(stats.byType).toEqual({
        pattern: 2,
        bugfix: 1,
        learning: 1,
      });
      expect(stats.byProject).toEqual({
        'acme/widgets': 3,
        'acme/gadgets': 1,
      });
      expect(stats.oldestObservation).toEqual(expect.any(String));
      expect(stats.newestObservation).toEqual(expect.any(String));

      await storage.close();
    });

    it('returns zeroes and nulls for empty database', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      const stats = await storage.getStats();

      expect(stats.totalObservations).toBe(0);
      expect(stats.byType).toEqual({});
      expect(stats.byProject).toEqual({});
      expect(stats.oldestObservation).toBeNull();
      expect(stats.newestObservation).toBeNull();

      await storage.close();
    });
  });

  // ── clearObservations ──

  describe('clearObservations()', () => {
    it('deletes all observations and returns the count', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({ title: 'Obs 1', content: 'Content 1 for clear.' }),
      );
      await storage.saveObservation(
        makeObservationData({ title: 'Obs 2', content: 'Content 2 for clear.' }),
      );
      await storage.saveObservation(
        makeObservationData({ title: 'Obs 3', content: 'Content 3 for clear.' }),
      );

      const deleted = await storage.clearObservations();

      expect(deleted).toBe(3);

      // Verify DB is empty
      const remaining = await storage.listObservations();
      expect(remaining).toEqual([]);

      await storage.close();
    });

    it('scoped clear deletes only the specified project', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          project: 'acme/widgets',
          title: 'Widget obs',
          content: 'Widget content for clear.',
        }),
      );
      await storage.saveObservation(
        makeObservationData({
          project: 'acme/gadgets',
          title: 'Gadget obs',
          content: 'Gadget content for clear.',
        }),
      );

      const deleted = await storage.clearObservations({ project: 'acme/widgets' });

      expect(deleted).toBe(1);

      // Verify only acme/gadgets remains
      const remaining = await storage.listObservations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.project).toBe('acme/gadgets');

      await storage.close();
    });

    it('cleans up FTS5 index after clear so search returns empty', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          title: 'FTS5 bulk target',
          content: 'Unique zephyr content for bulk FTS5 test.',
        }),
      );

      // Verify searchable before clear
      const beforeClear = await storage.searchObservations('owner/repo', 'zephyr');
      expect(beforeClear).toHaveLength(1);

      await storage.clearObservations();

      // Verify FTS5 is cleaned up — search should return empty
      const afterClear = await storage.searchObservations('owner/repo', 'zephyr');
      expect(afterClear).toHaveLength(0);

      await storage.close();
    });
  });

  // ── FTS5 delete trigger idempotency ──

  describe('FTS5 delete trigger idempotency', () => {
    it('trigger functions correctly after re-opening an existing database', async () => {
      // Phase 1: Create DB, insert observations, close (persist to file)
      const storage1 = await SqliteMemoryStorage.create(dbPath);

      await storage1.saveObservation(
        makeObservationData({
          title: 'Trigger test observation',
          content: 'Unique quasar content for trigger idempotency.',
        }),
      );
      await storage1.saveObservation(
        makeObservationData({
          title: 'Second trigger observation',
          content: 'Another nebula content for trigger test.',
        }),
      );

      await storage1.close();

      // Phase 2: Re-open the SAME file — trigger should already exist via IF NOT EXISTS
      const storage2 = await SqliteMemoryStorage.create(dbPath);

      // Verify both observations are searchable
      const beforeDelete = await storage2.searchObservations('owner/repo', 'quasar');
      expect(beforeDelete).toHaveLength(1);

      // Delete one observation
      const deleted = await storage2.deleteObservation(beforeDelete[0]?.id);
      expect(deleted).toBe(true);

      // FTS5 should be clean — deleted observation no longer searchable
      const afterDelete = await storage2.searchObservations('owner/repo', 'quasar');
      expect(afterDelete).toHaveLength(0);

      // The other observation should still be searchable
      const otherStillExists = await storage2.searchObservations('owner/repo', 'nebula');
      expect(otherStillExists).toHaveLength(1);

      await storage2.close();
    });

    it('schema re-run on existing DB does not error (CREATE TRIGGER IF NOT EXISTS)', async () => {
      // Create and close
      const storage1 = await SqliteMemoryStorage.create(dbPath);
      await storage1.close();

      // Re-open — SCHEMA_SQL runs again; all CREATE ... IF NOT EXISTS should be no-ops
      const storage2 = await SqliteMemoryStorage.create(dbPath);

      // Should not throw; basic operation should work
      const stats = await storage2.getStats();
      expect(stats.totalObservations).toBe(0);

      await storage2.close();
    });
  });

  // ── Memory Decay ──

  describe('memory decay', () => {
    it('returns strength=1.0 for freshly created observations', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          title: 'Fresh finding',
          content: 'This is a fresh finding about authentication.',
        }),
      );

      const results = await storage.searchObservations('owner/repo', 'authentication');
      expect(results).toHaveLength(1);
      expect(results[0]?.strength).toBe(1.0);

      await storage.close();
    });

    it('filters out observations past clearance threshold', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath, {
        decayConfig: {
          dormancyDays: 1,
          decayDays: 5,
          clearanceDays: 10,
          minStrength: 0.1,
        },
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'Old authentication finding',
          content: 'A stale authentication finding.',
        }),
      );

      // Manually backdate the last_accessed_at to 15 days ago
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      db.run("UPDATE memory_observations SET last_accessed_at = datetime('now', '-15 days')");

      const results = await storage.searchObservations('owner/repo', 'authentication');
      expect(results).toHaveLength(0);

      await storage.close();
    });

    it('returns decayed strength for observations in decay window', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath, {
        decayConfig: {
          dormancyDays: 0,
          decayDays: 10,
          clearanceDays: 10,
          minStrength: 0.0,
        },
      });

      await storage.saveObservation(
        makeObservationData({
          title: 'Decaying zeppelin observation',
          content: 'A zeppelin observation in the decay window.',
        }),
      );

      // Backdate to 5 days ago — should be ~0.5 strength
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      db.run("UPDATE memory_observations SET last_accessed_at = datetime('now', '-5 days')");

      const results = await storage.searchObservations('owner/repo', 'zeppelin');
      expect(results).toHaveLength(1);
      expect(results[0]?.strength).toBeGreaterThan(0.3);
      expect(results[0]?.strength).toBeLessThan(0.7);

      await storage.close();
    });

    it('updates last_accessed_at when observation is returned in search', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          title: 'Access tracking quasar',
          content: 'Quasar observation for access tracking test.',
        }),
      );

      // Backdate last_accessed_at
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      db.run("UPDATE memory_observations SET last_accessed_at = datetime('now', '-2 days')");

      // Capture the old value
      const before = db.exec('SELECT last_accessed_at FROM memory_observations LIMIT 1');
      const oldValue = before[0]?.values[0]?.[0] as string;

      // Search should update last_accessed_at
      await storage.searchObservations('owner/repo', 'quasar');

      // Verify last_accessed_at changed (is newer than the old backdated value)
      const after = db.exec('SELECT last_accessed_at FROM memory_observations LIMIT 1');
      const newValue = after[0]?.values[0]?.[0] as string;
      expect(newValue).not.toBe(oldValue);
      expect(new Date(newValue).getTime()).toBeGreaterThan(new Date(oldValue).getTime());

      await storage.close();
    });

    it('topic upsert resets last_accessed_at', async () => {
      const storage = await SqliteMemoryStorage.create(dbPath);

      await storage.saveObservation(
        makeObservationData({
          topicKey: 'decay-topic',
          content: 'Version 1 content',
        }),
      );

      // Backdate
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const db = (storage as any).db;
      db.run("UPDATE memory_observations SET last_accessed_at = datetime('now', '-30 days')");

      // Capture the old value
      const before = db.exec('SELECT last_accessed_at FROM memory_observations LIMIT 1');
      const oldValue = before[0]?.values[0]?.[0] as string;

      // Upsert should reset last_accessed_at
      await storage.saveObservation(
        makeObservationData({
          topicKey: 'decay-topic',
          content: 'Version 2 content',
        }),
      );

      const after = db.exec('SELECT last_accessed_at FROM memory_observations LIMIT 1');
      const newValue = after[0]?.values[0]?.[0] as string;
      expect(new Date(newValue).getTime()).toBeGreaterThan(new Date(oldValue).getTime());

      await storage.close();
    });
  });
});
