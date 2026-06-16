import type {
  DecayConfig,
  EmbeddingProvider,
  ListObservationsOptions,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
} from 'ghagga-core';
import { computeStrength, DEFAULT_DECAY_CONFIG, normalizeRankRelevance } from 'ghagga-core';
import type { Database, memoryObservations } from 'ghagga-db';
import {
  clearAllMemoryObservations,
  clearMemoryObservationsByProject,
  createMemorySession,
  deleteMemoryObservation,
  endMemorySession,
  getMemoryObservation,
  getMemoryStats,
  listMemoryObservations,
  saveObservation,
  searchObservations,
} from 'ghagga-db';

type ObservationRow = typeof memoryObservations.$inferSelect;

/**
 * PostgreSQL-backed memory storage.
 * Thin adapter wrapping existing ghagga-db query functions.
 *
 * The constructor receives the Drizzle Database instance; each method
 * delegates to the corresponding ghagga-db function and maps the full
 * Drizzle row to the MemoryObservationRow subset expected by core.
 *
 * close() is a no-op — the PostgreSQL connection lifecycle is managed
 * externally by the server (pooled via node-postgres).
 */
export class PostgresMemoryStorage implements MemoryStorage {
  constructor(
    private db: Database,
    private installationId: number,
    /**
     * Optional embedding provider for hybrid search.
     * When provided, embeddings are stored on save and hybrid BM25+semantic
     * scoring (70/30) is used for search. When undefined, falls back to
     * keyword-only tsvector search (original behavior).
     */
    private embeddingProvider?: EmbeddingProvider,
    /**
     * Decay thresholds. Defaults to DEFAULT_DECAY_CONFIG — the SAME source the
     * SQLite backend uses — so the two backends never diverge on strength math.
     */
    private decayConfig: DecayConfig = DEFAULT_DECAY_CONFIG,
  ) {}

  async searchObservations(
    project: string,
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<MemoryObservationRow[]> {
    // Capture the provider locally so the closure does not need to re-narrow `this.X`.
    const provider = this.embeddingProvider;
    const limit = options?.limit ?? 10;
    // Over-fetch by 3x (matching the SQLite backend, sqlite.ts:276) so that
    // dropping decayed rows below does not under-deliver fewer than `limit`.
    const rows = await searchObservations(this.db, project, query, {
      ...options,
      fetchLimit: limit * 3,
      // Pass the embed function for hybrid search when provider is available
      embedFn: provider ? (text: string) => provider.embed(text) : undefined,
    });

    // Apply strength decay identically to the SQLite backend (sqlite.ts:304-323):
    // compute strength from lastAccessedAt, drop rows below minStrength, and
    // attach the strength field so formatMemoryContext renders consistently.
    // NOTE: queries.ts updates lastAccessedAt AFTER selecting, but the returned
    // rows still carry the pre-update timestamp, so this mirrors SQLite's
    // "compute on old value, then bump" ordering.
    // `rows` arrive ordered by RELEVANCE (ts_rank DESC, or hybrid finalScore DESC
    // in ghagga-db searchObservations). The 0-based position is therefore a stable
    // relevance rank; we surface it as a saturating [0,1] relevanceScore for
    // observability. Use the PRE-decay-filter index so a dropped decayed row does
    // not inflate the relevance of later rows.
    const now = new Date();
    const result: MemoryObservationRow[] = [];
    let rank0 = 0;
    for (const row of rows) {
      const relevanceScore = normalizeRankRelevance(rank0);
      rank0++;
      const strength = computeStrength(row.lastAccessedAt, now, this.decayConfig);
      if (strength < this.decayConfig.minStrength) continue;
      result.push({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        filePaths: row.filePaths ?? null,
        severity: row.severity ?? null,
        strength,
        relevanceScore,
      });
      // Cap at the originally-requested limit: we over-fetched only to absorb
      // decay drops, never to return MORE than the caller asked for.
      if (result.length >= limit) break;
    }
    return result;
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
    // Compute embedding when provider is available — NULL otherwise (graceful degradation)
    let embedding: number[] | null = null;
    if (this.embeddingProvider) {
      try {
        embedding = await this.embeddingProvider.embed(`${data.title} ${data.content}`);
      } catch {
        // Embedding failure is non-fatal — store NULL and continue
      }
    }

    const row = await saveObservation(this.db, { ...data, embedding });
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      filePaths: row.filePaths ?? null,
      severity: row.severity ?? null,
    };
  }

  async createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }> {
    const session = await createMemorySession(this.db, data);
    return { id: session.id };
  }

  async endSession(sessionId: number, summary: string): Promise<void> {
    await endMemorySession(this.db, sessionId, summary);
  }

  async close(): Promise<void> {
    // No-op — PostgreSQL connection lifecycle is managed externally
  }

  // ── Management methods ─────────────────────────────────────────

  async listObservations(options?: ListObservationsOptions): Promise<MemoryObservationDetail[]> {
    const rows = await listMemoryObservations(this.db, this.installationId, options);
    return rows.map((row: ObservationRow) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      filePaths: row.filePaths ?? null,
      severity: row.severity ?? null,
      project: row.project,
      topicKey: row.topicKey ?? null,
      revisionCount: row.revisionCount,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:
        row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    }));
  }

  async getObservation(id: number): Promise<MemoryObservationDetail | null> {
    const row = await getMemoryObservation(this.db, this.installationId, id);
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      filePaths: row.filePaths ?? null,
      severity: row.severity ?? null,
      project: row.project,
      topicKey: row.topicKey ?? null,
      revisionCount: row.revisionCount,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:
        row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
  }

  async deleteObservation(id: number): Promise<boolean> {
    return deleteMemoryObservation(this.db, this.installationId, id);
  }

  async getStats(): Promise<MemoryStats> {
    const raw = await getMemoryStats(this.db, this.installationId);
    return {
      totalObservations: raw.totalObservations,
      byType: Object.fromEntries(raw.byType.map((r) => [r.type, r.count])),
      byProject: Object.fromEntries(raw.byProject.map((r) => [r.project, r.count])),
      oldestObservation:
        raw.oldestDate instanceof Date
          ? raw.oldestDate.toISOString()
          : raw.oldestDate
            ? String(raw.oldestDate)
            : null,
      newestObservation:
        raw.newestDate instanceof Date
          ? raw.newestDate.toISOString()
          : raw.newestDate
            ? String(raw.newestDate)
            : null,
    };
  }

  async clearObservations(options?: { project?: string }): Promise<number> {
    if (options?.project) {
      return clearMemoryObservationsByProject(this.db, this.installationId, options.project);
    }
    return clearAllMemoryObservations(this.db, this.installationId);
  }
}
