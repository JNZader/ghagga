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
const initSqlJs = typeof initSqlJsModule === 'function'
  ? initSqlJsModule
  : (initSqlJsModule as unknown as { initSqlJs: typeof initSqlJsModule }).initSqlJs;
import type {
  ListObservationsOptions,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
} from '../types.js';

/**
 * Extended Database interface — fts5-sql-bundle types omit the params overload
 * for exec(), but the runtime (sql.js core) supports it.
 */
interface DatabaseWithParams extends Database {
  exec(
    sql: string,
    params?: (string | number | null)[],
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_obs_project ON memory_observations(project);
  CREATE INDEX IF NOT EXISTS idx_obs_topic_key ON memory_observations(topic_key);
  CREATE INDEX IF NOT EXISTS idx_obs_content_hash ON memory_observations(content_hash);

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
`;

const DEFAULT_DEDUP_WINDOW_MINUTES = 15;

export interface SqliteMemoryStorageOptions {
  /** Dedup window in minutes. Observations with the same content hash within this window are deduplicated. Defaults to 15. */
  dedupWindowMinutes?: number;
}

export class SqliteMemoryStorage implements MemoryStorage {
  private dedupWindowMinutes: number;

  private constructor(
    private db: DatabaseWithParams,
    private filePath: string,
    options: SqliteMemoryStorageOptions = {},
  ) {
    this.dedupWindowMinutes = options.dedupWindowMinutes ?? DEFAULT_DEDUP_WINDOW_MINUTES;
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

    return new SqliteMemoryStorage(db, filePath, options);
  }

  async searchObservations(
    project: string,
    query: string,
    options: { limit?: number; type?: string } = {},
  ): Promise<MemoryObservationRow[]> {
    const { limit = 10, type } = options;

    // Convert space-separated keywords to FTS5 OR query
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ');

    if (!ftsQuery) return [];

    let sql = `
      SELECT o.id, o.type, o.title, o.content, o.file_paths, o.severity
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
    params.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const rows: MemoryObservationRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: row.id as number,
        type: row.type as string,
        title: row.title as string,
        content: row.content as string,
        filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : null,
        severity: (row.severity as string) ?? null,
      });
    }
    stmt.free();

    return rows;
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

        const updated = this.db.exec(
          `
          UPDATE memory_observations
          SET content = ?, title = ?, content_hash = ?, file_paths = ?,
              severity = ?,
              revision_count = revision_count + 1,
              updated_at = datetime('now')
          WHERE id = ?
          RETURNING id, type, title, content, file_paths, severity
        `,
          [data.content, data.title, contentHash, filePathsJson, data.severity ?? null, existingId],
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

    // New observation
    const filePathsJson = JSON.stringify(data.filePaths ?? []);
    const inserted = this.db.exec(
      `
      INSERT INTO memory_observations
        (session_id, project, type, title, content, severity, topic_key, file_paths, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ],
    );

    const row = inserted[0]?.values[0];
    if (!row) throw new Error('Unexpected empty row after insert');
    return {
      id: row[0] as number,
      type: row[1] as string,
      title: row[2] as string,
      content: row[3] as string,
      filePaths: row[4] ? JSON.parse(row[4] as string) : null,
      severity: (row[5] as string) ?? null,
    };
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
