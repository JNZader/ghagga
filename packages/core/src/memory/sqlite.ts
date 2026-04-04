/**
 * SQLite-backed memory storage using sql.js (pure WASM).
 *
 * Thread safety: This class is NOT thread-safe. It operates as an in-memory
 * database with manual file persistence via close(). Designed for single-process
 * environments (CLI, GitHub Action).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import initSqlJsModule, { type Database } from 'fts5-sql-bundle';

// CJS/ESM interop: default import of CJS module may be the module object, not the function
const initSqlJs =
  typeof initSqlJsModule === 'function'
    ? initSqlJsModule
    : (initSqlJsModule as unknown as { initSqlJs: typeof initSqlJsModule }).initSqlJs;

import {
  cosineSimilarity,
  deserializeEmbedding,
  type EmbeddingProvider,
  serializeEmbedding,
} from '../embed.js';
import type {
  AuthorTrustScore,
  ListObservationsOptions,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
  NegativeExample,
} from '../types.js';
import { DEFAULT_DECAY_CONFIG, type DecayConfig } from '../types.js';
import { computeStrength } from './decay.js';

/**
 * Extended Database interface — fts5-sql-bundle types omit the params overload
 * for exec(), but the runtime (sql.js core) supports it.
 */
interface DatabaseWithParams extends Database {
  exec(
    sql: string,
    params?: (string | number | Buffer | null)[],
  ): Array<{ columns: string[]; values: unknown[][] }>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    pr_number INTEGER,
    summary TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES memory_sessions(id) ON DELETE CASCADE,
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
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_obs_project ON memory_observations(project);
  CREATE INDEX IF NOT EXISTS idx_obs_topic_key ON memory_observations(topic_key);
  CREATE INDEX IF NOT EXISTS idx_obs_content_hash ON memory_observations(content_hash);
  CREATE INDEX IF NOT EXISTS idx_obs_last_accessed ON memory_observations(last_accessed_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts
    USING fts5(title, content, content='memory_observations', content_rowid='id');

  CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON memory_observations BEGIN
    INSERT INTO memory_observations_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON memory_observations BEGIN
    INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO memory_observations_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON memory_observations BEGIN
    INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
  END;

  -- ── Versioning tables ────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS memory_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES memory_branches(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    branch_id INTEGER NOT NULL REFERENCES memory_branches(id) ON DELETE CASCADE,
    observation_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_branch_observations (
    branch_id INTEGER NOT NULL REFERENCES memory_branches(id) ON DELETE CASCADE,
    observation_id INTEGER NOT NULL REFERENCES memory_observations(id) ON DELETE CASCADE,
    PRIMARY KEY (branch_id, observation_id)
  );

  -- Seed the default "main" branch (idempotent via INSERT OR IGNORE)
  INSERT OR IGNORE INTO memory_branches (id, name, parent_id) VALUES (1, 'main', NULL);

  -- ── Author trust cache ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS author_trust (
    author TEXT PRIMARY KEY,
    score REAL NOT NULL,
    tier TEXT NOT NULL,
    commit_count INTEGER NOT NULL DEFAULT 0,
    first_seen_days_ago INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL
  );

  -- ── Negative examples (dismissed findings) ──────────────────────
  CREATE TABLE IF NOT EXISTS negative_examples (
    finding_hash TEXT PRIMARY KEY,
    context_hash TEXT NOT NULL,
    category TEXT NOT NULL,
    reason TEXT,
    file_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_neg_context_hash ON negative_examples(context_hash);
`;

const DEFAULT_DEDUP_WINDOW_MINUTES = 15;

export interface SqliteMemoryStorageOptions {
  /** Dedup window in minutes. Observations with the same content hash within this window are deduplicated. Defaults to 15. */
  dedupWindowMinutes?: number;

  /** Decay configuration for memory strength. Uses defaults when not provided. */
  decayConfig?: DecayConfig;

  /**
   * Optional embedding provider for hybrid search.
   * When provided, embeddings are stored on save and hybrid BM25+semantic scoring
   * is used for search. When undefined, falls back to keyword-only search.
   */
  embeddingProvider?: EmbeddingProvider;
}

export class SqliteMemoryStorage implements MemoryStorage {
  private dedupWindowMinutes: number;
  private decayConfig: DecayConfig;
  private embeddingProvider: EmbeddingProvider | undefined;

  private constructor(
    private db: DatabaseWithParams,
    private filePath: string,
    options: SqliteMemoryStorageOptions = {},
  ) {
    this.dedupWindowMinutes = options.dedupWindowMinutes ?? DEFAULT_DEDUP_WINDOW_MINUTES;
    this.decayConfig = options.decayConfig ?? DEFAULT_DECAY_CONFIG;
    this.embeddingProvider = options.embeddingProvider;
  }

  /**
   * Expose the underlying database for the versioning layer.
   * Only used by MemoryVersioning — not part of the MemoryStorage interface.
   */
  getDatabase(): DatabaseWithParams {
    return this.db;
  }

  /**
   * Async factory — handles WASM initialization and file loading.
   * If filePath exists, loads the existing DB. Otherwise, creates a fresh one.
   */
  static async create(
    filePath: string,
    options?: SqliteMemoryStorageOptions,
  ): Promise<SqliteMemoryStorage> {
    const SQL = await initSqlJs();

    let db: DatabaseWithParams;
    if (existsSync(filePath)) {
      const buffer = readFileSync(filePath);
      db = new SQL.Database(buffer) as DatabaseWithParams;
    } else {
      db = new SQL.Database() as DatabaseWithParams;
    }

    db.run(SCHEMA_SQL);

    // Migration: add severity column to existing databases
    try {
      db.run('ALTER TABLE memory_observations ADD COLUMN severity TEXT');
    } catch {
      // Column already exists — idempotent migration
    }

    // Migration: add last_accessed_at column for decay tracking
    try {
      db.run(
        "ALTER TABLE memory_observations ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))",
      );
      // Backfill: set last_accessed_at = updated_at for existing rows
      db.run(
        'UPDATE memory_observations SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL OR last_accessed_at = ""',
      );
    } catch {
      // Column already exists — idempotent migration
    }

    // Migration: add embedding column for hybrid search (NULL when no embedding provider)
    try {
      db.run('ALTER TABLE memory_observations ADD COLUMN embedding BLOB');
    } catch {
      // Column already exists — idempotent migration
    }

    return new SqliteMemoryStorage(db, filePath, options);
  }

  async searchObservations(
    project: string,
    query: string,
    options: { limit?: number; type?: string } = {},
  ): Promise<MemoryObservationRow[]> {
    const { limit = 10, type } = options;

    // ── Hybrid search (BM25 + semantic) ──────────────────────────
    if (this.embeddingProvider) {
      return this._hybridSearch(project, query, { limit, type });
    }

    // ── Keyword-only fallback (original behavior) ─────────────────
    // Convert space-separated keywords to FTS5 OR query
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ');

    if (!ftsQuery) return [];

    // Fetch more than limit to account for decay filtering
    const fetchLimit = limit * 3;

    let sql = `
      SELECT o.id, o.type, o.title, o.content, o.file_paths, o.severity, o.last_accessed_at
      FROM memory_observations o
      JOIN memory_observations_fts fts ON fts.rowid = o.id
      WHERE memory_observations_fts MATCH ?
        AND o.project = ?
    `;
    const params: (string | number)[] = [ftsQuery, project];

    if (type) {
      sql += ' AND o.type = ?';
      params.push(type);
    }

    sql += ' ORDER BY bm25(memory_observations_fts) LIMIT ?';
    params.push(fetchLimit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const now = new Date();
    const rows: MemoryObservationRow[] = [];
    const accessedIds: number[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const lastAccessed = row.last_accessed_at ? new Date(row.last_accessed_at as string) : now;
      const strength = computeStrength(lastAccessed, now, this.decayConfig);

      // Filter by minimum strength
      if (strength < this.decayConfig.minStrength) continue;

      const id = row.id as number;
      accessedIds.push(id);

      rows.push({
        id,
        type: row.type as string,
        title: row.title as string,
        content: row.content as string,
        filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : null,
        severity: (row.severity as string) ?? null,
        strength,
      });

      if (rows.length >= limit) break;
    }
    stmt.free();

    // Update last_accessed_at for returned observations
    if (accessedIds.length > 0) {
      const placeholders = accessedIds.map(() => '?').join(',');
      this.db.run(
        `UPDATE memory_observations SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`,
        accessedIds,
      );
    }

    return rows;
  }

  /**
   * Hybrid BM25 + semantic search (70% semantic, 30% keyword).
   * Only called when embeddingProvider is set.
   *
   * Strategy:
   *   1. Run FTS5 to get keyword candidates (up to limit * 5 to have enough for re-ranking)
   *   2. Embed the query
   *   3. For each candidate, deserialize its stored embedding and compute cosine similarity
   *   4. Candidates without embeddings get cosine_sim = 0 (keyword-only score still applies)
   *   5. Combine: final_score = 0.7 * cosine_sim + 0.3 * normalized_bm25
   *   6. Sort descending, apply decay filter, return top-k
   */
  private async _hybridSearch(
    project: string,
    query: string,
    options: { limit: number; type?: string },
  ): Promise<MemoryObservationRow[]> {
    const { limit, type } = options;

    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ');

    if (!ftsQuery) return [];

    // Fetch a larger candidate set for re-ranking
    const fetchLimit = limit * 5;

    let sql = `
      SELECT o.id, o.type, o.title, o.content, o.file_paths, o.severity,
             o.last_accessed_at, o.embedding,
             bm25(memory_observations_fts) AS bm25_score
      FROM memory_observations o
      JOIN memory_observations_fts fts ON fts.rowid = o.id
      WHERE memory_observations_fts MATCH ?
        AND o.project = ?
    `;
    const params: (string | number)[] = [ftsQuery, project];

    if (type) {
      sql += ' AND o.type = ?';
      params.push(type);
    }

    sql += ' ORDER BY bm25(memory_observations_fts) LIMIT ?';
    params.push(fetchLimit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    interface CandidateRow {
      id: number;
      type: string;
      title: string;
      content: string;
      filePaths: string[] | null;
      severity: string | null;
      lastAccessed: Date;
      embedding: Buffer | null;
      bm25Score: number;
    }

    const candidates: CandidateRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      candidates.push({
        id: row.id as number,
        type: row.type as string,
        title: row.title as string,
        content: row.content as string,
        filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : null,
        severity: (row.severity as string) ?? null,
        lastAccessed: row.last_accessed_at ? new Date(row.last_accessed_at as string) : new Date(),
        embedding: row.embedding ? (row.embedding as Buffer) : null,
        bm25Score: row.bm25_score as number,
      });
    }
    stmt.free();

    if (candidates.length === 0) return [];

    // Compute query embedding
    // biome-ignore lint/style/noNonNullAssertion: embeddingProvider is checked by the caller (_hybridSearch is only called when it's set)
    const queryVec = await this.embeddingProvider!.embed(query);

    // BM25 scores from FTS5 are negative (lower = better match).
    // Normalize to [0, 1]: higher is better.
    const bm25Scores = candidates.map((c) => c.bm25Score);
    const minBm25 = Math.min(...bm25Scores);
    const maxBm25 = Math.max(...bm25Scores);
    const bm25Range = maxBm25 - minBm25;

    const now = new Date();
    const scored: Array<{ candidate: CandidateRow; finalScore: number; strength: number }> = [];

    for (const candidate of candidates) {
      const strength = computeStrength(candidate.lastAccessed, now, this.decayConfig);
      if (strength < this.decayConfig.minStrength) continue;

      // Normalize BM25: invert (less negative = better) → [0, 1]
      const normalizedBm25 = bm25Range === 0 ? 1 : (candidate.bm25Score - minBm25) / bm25Range;

      // Cosine similarity from stored embedding (0 if not present)
      let cosineSim = 0;
      if (candidate.embedding) {
        try {
          const storedVec = deserializeEmbedding(candidate.embedding);
          cosineSim = cosineSimilarity(queryVec, storedVec);
        } catch {
          // Malformed embedding — treat as 0
        }
      }

      // 70/30 weighted combination
      const finalScore = 0.7 * cosineSim + 0.3 * normalizedBm25;
      scored.push({ candidate, finalScore, strength });
    }

    // Sort by final score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    const results: MemoryObservationRow[] = [];
    const accessedIds: number[] = [];

    for (const { candidate, strength } of scored) {
      if (results.length >= limit) break;
      accessedIds.push(candidate.id);
      results.push({
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        filePaths: candidate.filePaths,
        severity: candidate.severity,
        strength,
      });
    }

    // Update last_accessed_at for returned observations
    if (accessedIds.length > 0) {
      const placeholders = accessedIds.map(() => '?').join(',');
      this.db.run(
        `UPDATE memory_observations SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`,
        accessedIds,
      );
    }

    return results;
  }

  async saveObservation(data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
    severity?: string;
  }): Promise<MemoryObservationRow> {
    const contentHash = createHash('sha256')
      .update(`${data.type}:${data.title}:${data.content}`)
      .digest('hex');

    // Dedup: check for same content hash within the configured dedup window
    const dedupRows = this.db.exec(
      `
      SELECT id, type, title, content, file_paths FROM memory_observations
      WHERE content_hash = ? AND project = ?
        AND created_at > datetime('now', '-${this.dedupWindowMinutes} minutes')
      LIMIT 1
    `,
      [contentHash, data.project],
    );

    if (dedupRows.length > 0 && dedupRows[0]?.values.length > 0) {
      const row = dedupRows[0]?.values[0];
      if (!row) throw new Error('Unexpected empty row after dedup check');
      const existingId = row[0] as number;

      // If the existing observation is from a different session, reassign it
      if (data.sessionId != null) {
        const existingSessionRows = this.db.exec(
          `SELECT session_id FROM memory_observations WHERE id = ?`,
          [existingId],
        );
        const existingSessionId = existingSessionRows[0]?.values[0]?.[0] as number | null;
        if (existingSessionId !== data.sessionId) {
          this.db.run(
            `UPDATE memory_observations SET session_id = ?, updated_at = datetime('now') WHERE id = ?`,
            [data.sessionId, existingId],
          );
        }
      }

      return {
        id: existingId,
        type: row[1] as string,
        title: row[2] as string,
        content: row[3] as string,
        filePaths: row[4] ? JSON.parse(row[4] as string) : null,
        severity: null,
      };
    }

    // TopicKey upsert
    if (data.topicKey) {
      const existingByTopic = this.db.exec(
        `
        SELECT id FROM memory_observations
        WHERE topic_key = ? AND project = ?
        LIMIT 1
      `,
        [data.topicKey, data.project],
      );

      if (existingByTopic.length > 0 && existingByTopic[0]?.values.length > 0) {
        const existingId = existingByTopic[0]?.values[0]?.[0] as number;
        const filePathsJson = JSON.stringify(data.filePaths ?? []);

        // Compute and store embedding if provider available
        const embeddingBuf = await this._computeEmbeddingBuffer(`${data.title} ${data.content}`);

        const updated = this.db.exec(
          `
          UPDATE memory_observations
          SET content = ?, title = ?, content_hash = ?, file_paths = ?,
              severity = ?, embedding = ?,
              revision_count = revision_count + 1,
              updated_at = datetime('now'),
              last_accessed_at = datetime('now')
          WHERE id = ?
          RETURNING id, type, title, content, file_paths, severity
        `,
          [
            data.content,
            data.title,
            contentHash,
            filePathsJson,
            data.severity ?? null,
            embeddingBuf,
            existingId,
          ],
        );

        const row = updated[0]?.values[0];
        if (!row) throw new Error('Unexpected empty row after topic upsert');
        return {
          id: row[0] as number,
          type: row[1] as string,
          title: row[2] as string,
          content: row[3] as string,
          filePaths: row[4] ? JSON.parse(row[4] as string) : null,
          severity: (row[5] as string) ?? null,
        };
      }
    }

    // New observation — compute embedding if provider available
    const embeddingBuf = await this._computeEmbeddingBuffer(`${data.title} ${data.content}`);
    const filePathsJson = JSON.stringify(data.filePaths ?? []);
    const inserted = this.db.exec(
      `
      INSERT INTO memory_observations
        (session_id, project, type, title, content, severity, topic_key, file_paths, content_hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, type, title, content, file_paths, severity
    `,
      [
        data.sessionId ?? null,
        data.project,
        data.type,
        data.title,
        data.content,
        data.severity ?? null,
        data.topicKey ?? null,
        filePathsJson,
        contentHash,
        embeddingBuf,
      ],
    );

    const row = inserted[0]?.values[0];
    if (!row) throw new Error('Unexpected empty row after insert');

    const newId = row[0] as number;

    // Link new observation to the default "main" branch
    this.db.run(
      'INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id) VALUES (1, ?)',
      [newId],
    );

    return {
      id: newId,
      type: row[1] as string,
      title: row[2] as string,
      content: row[3] as string,
      filePaths: row[4] ? JSON.parse(row[4] as string) : null,
      severity: (row[5] as string) ?? null,
    };
  }

  /**
   * Compute embedding buffer for storage.
   * Returns the serialized float32 Buffer when embeddingProvider is available,
   * or null (no-op) when it is not — enabling graceful degradation.
   */
  private async _computeEmbeddingBuffer(text: string): Promise<Buffer | null> {
    if (!this.embeddingProvider) return null;
    try {
      const vec = await this.embeddingProvider.embed(text);
      return serializeEmbedding(vec);
    } catch {
      // Embedding failure is non-fatal — store NULL and continue
      return null;
    }
  }

  async createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }> {
    const result = this.db.exec(
      `
      INSERT INTO memory_sessions (project, pr_number)
      VALUES (?, ?)
      RETURNING id
    `,
      [data.project, data.prNumber ?? null],
    );

    return { id: result[0]?.values[0]?.[0] as number };
  }

  async endSession(sessionId: number, summary: string): Promise<void> {
    this.db.run(
      `
      UPDATE memory_sessions
      SET ended_at = datetime('now'), summary = ?
      WHERE id = ?
    `,
      [summary, sessionId],
    );
  }

  // ── Management methods ──────────────────────────────────────────

  private mapToDetail(row: Record<string, unknown>): MemoryObservationDetail {
    return {
      id: row.id as number,
      type: row.type as string,
      title: row.title as string,
      content: row.content as string,
      filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : null,
      severity: (row.severity as string) ?? null,
      project: row.project as string,
      topicKey: (row.topic_key as string) ?? null,
      revisionCount: row.revision_count as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async listObservations(
    options: ListObservationsOptions = {},
  ): Promise<MemoryObservationDetail[]> {
    const { project, type, limit = 20, offset = 0 } = options;

    let sql = `
      SELECT id, type, title, content, file_paths, severity, project, topic_key,
             revision_count, created_at, updated_at
      FROM memory_observations
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const rows: MemoryObservationDetail[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(this.mapToDetail(row));
    }
    stmt.free();
    return rows;
  }

  async getObservation(id: number): Promise<MemoryObservationDetail | null> {
    const stmt = this.db.prepare(`
      SELECT id, type, title, content, file_paths, severity, project, topic_key,
             revision_count, created_at, updated_at
      FROM memory_observations
      WHERE id = ?
    `);
    stmt.bind([id]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return this.mapToDetail(row);
  }

  async deleteObservation(id: number): Promise<boolean> {
    this.db.run('DELETE FROM memory_observations WHERE id = ?', [id]);
    return this.db.getRowsModified() > 0;
  }

  async getStats(): Promise<MemoryStats> {
    // Query 1: totals and date range
    const totals = this.db.exec(
      'SELECT COUNT(*) AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memory_observations',
    );
    const totalRow = totals[0]?.values[0];
    const totalObservations = (totalRow?.[0] as number) ?? 0;
    const oldestObservation = (totalRow?.[1] as string) ?? null;
    const newestObservation = (totalRow?.[2] as string) ?? null;

    // Query 2: count by type
    const byTypeResult = this.db.exec(
      'SELECT type, COUNT(*) AS count FROM memory_observations GROUP BY type ORDER BY count DESC',
    );
    const byType: Record<string, number> = {};
    if (byTypeResult.length > 0 && byTypeResult[0]?.values) {
      for (const row of byTypeResult[0].values) {
        byType[row[0] as string] = row[1] as number;
      }
    }

    // Query 3: count by project
    const byProjectResult = this.db.exec(
      'SELECT project, COUNT(*) AS count FROM memory_observations GROUP BY project ORDER BY count DESC',
    );
    const byProject: Record<string, number> = {};
    if (byProjectResult.length > 0 && byProjectResult[0]?.values) {
      for (const row of byProjectResult[0].values) {
        byProject[row[0] as string] = row[1] as number;
      }
    }

    return { totalObservations, byType, byProject, oldestObservation, newestObservation };
  }

  async clearObservations(options: { project?: string } = {}): Promise<number> {
    if (options.project) {
      this.db.run('DELETE FROM memory_observations WHERE project = ?', [options.project]);
    } else {
      this.db.run('DELETE FROM memory_observations');
    }
    return this.db.getRowsModified();
  }

  // ── Author Trust Cache ──────────────────────────────────────────

  /**
   * Retrieve a cached author trust score.
   * Returns null when the author has no entry in the cache.
   */
  getTrustScore(author: string): AuthorTrustScore | null {
    const stmt = this.db.prepare(
      'SELECT author, score, tier, commit_count, first_seen_days_ago, last_updated FROM author_trust WHERE author = ?',
    );
    stmt.bind([author]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();

    return {
      author: row.author as string,
      score: row.score as number,
      tier: row.tier as AuthorTrustScore['tier'],
      commitCount: row.commit_count as number,
      firstSeenDaysAgo: row.first_seen_days_ago as number,
      lastUpdated: new Date(row.last_updated as string),
    };
  }

  /**
   * Insert or replace an author trust score in the cache.
   */
  upsertTrustScore(score: AuthorTrustScore): void {
    this.db.run(
      `INSERT INTO author_trust (author, score, tier, commit_count, first_seen_days_ago, last_updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(author) DO UPDATE SET
         score = excluded.score,
         tier = excluded.tier,
         commit_count = excluded.commit_count,
         first_seen_days_ago = excluded.first_seen_days_ago,
         last_updated = excluded.last_updated`,
      [
        score.author,
        score.score,
        score.tier,
        score.commitCount,
        score.firstSeenDaysAgo,
        score.lastUpdated.toISOString(),
      ],
    );
  }

  // ── Negative Examples ───────────────────────────────────────────

  /**
   * Persist a dismissed finding as a negative example.
   * Uses INSERT OR REPLACE to make saves idempotent.
   */
  saveNegativeExample(example: NegativeExample & { filePath?: string }): void {
    this.db.run(
      `INSERT OR REPLACE INTO negative_examples
         (finding_hash, context_hash, category, reason, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        example.findingHash,
        example.contextHash,
        example.category,
        example.reason ?? null,
        example.filePath ?? null,
      ],
    );
  }

  /**
   * Retrieve all negative examples scoped to a file path.
   * Uses context_hash (SHA256 of filePath) as the lookup key.
   */
  getNegativeExamplesForFile(filePath: string): NegativeExample[] {
    const contextHash = createHash('sha256').update(filePath).digest('hex').slice(0, 16);

    const stmt = this.db.prepare(
      `SELECT finding_hash, context_hash, category, reason, created_at
       FROM negative_examples
       WHERE context_hash = ?`,
    );
    stmt.bind([contextHash]);

    const rows: NegativeExample[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        findingHash: row.finding_hash as string,
        contextHash: row.context_hash as string,
        category: row.category as string,
        reason: (row.reason as string) ?? undefined,
        createdAt: new Date(row.created_at as string),
      });
    }
    stmt.free();
    return rows;
  }

  /**
   * Retrieve all stored negative examples (for listing/management).
   */
  getAllNegativeExamples(): (NegativeExample & { filePath?: string })[] {
    const stmt = this.db.prepare(
      `SELECT finding_hash, context_hash, category, reason, file_path, created_at
       FROM negative_examples
       ORDER BY created_at DESC`,
    );

    const rows: (NegativeExample & { filePath?: string })[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        findingHash: row.finding_hash as string,
        contextHash: row.context_hash as string,
        category: row.category as string,
        reason: (row.reason as string) ?? undefined,
        filePath: (row.file_path as string) ?? undefined,
        createdAt: new Date(row.created_at as string),
      });
    }
    stmt.free();
    return rows;
  }

  /**
   * Delete a negative example by its finding hash.
   * Returns true if a row was deleted, false otherwise.
   */
  deleteNegativeExample(findingHash: string): boolean {
    this.db.run('DELETE FROM negative_examples WHERE finding_hash = ?', [findingHash]);
    return this.db.getRowsModified() > 0;
  }

  async close(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data = this.db.export();
    writeFileSync(this.filePath, Buffer.from(data));
    this.db.close();
  }
}
