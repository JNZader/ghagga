import type {
  DecayConfig,
  EmbeddingProvider,
  ListObservationsOptions,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
} from 'ghagga-core';
import { computeStrength, DEFAULT_DECAY_CONFIG } from 'ghagga-core';
import type { Database, memoryObservations } from 'ghagga-db';
import {
  bumpObservationsLastAccessed,
  clearAllMemoryObservations,
  clearMemoryObservationsByProject,
  createMemorySession,
  deleteMemoryObservation,
  endMemorySession,
  getMemoryObservation,
  getMemoryStats,
  listMemoryObservations,
  listObservationsNeedingEmbedding,
  saveObservation,
  searchObservations,
  updateObservationEmbedding,
} from 'ghagga-db';

type ObservationRow = typeof memoryObservations.$inferSelect;

/** Bounded cosine candidate set size (design D4) when not explicitly configured. */
const DEFAULT_EMBEDDING_CANDIDATE_K = 200;

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
    /**
     * Identifier for the active embedding model (e.g. "text-embedding-3-small").
     * Persisted per-row alongside the vector and compared on read (design D3).
     * Mirrors SqliteMemoryStorageOptions.embeddingModel (packages/core/src/memory/sqlite.ts)
     * — supplied by the caller out-of-band since EmbeddingProvider does not
     * expose a model name. When omitted, the read guard only enforces
     * dimension compatibility.
     */
    private embeddingModel?: string,
    /**
     * Bounded cosine candidate set size (design D4). Defaults to 200.
     */
    private embeddingCandidateK: number = DEFAULT_EMBEDDING_CANDIDATE_K,
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
    // The embedding-union options are omitted entirely (not passed as
    // `undefined`-valued keys) when no provider is active, so the call shape
    // to ghagga-db.searchObservations stays byte-for-byte identical to the
    // pre-union contract (spec R5.11).
    const rows = await searchObservations(this.db, project, query, {
      ...options,
      fetchLimit: limit * 3,
      // Pass the embed function for hybrid search when provider is available
      embedFn: provider ? (text: string) => provider.embed(text) : undefined,
      ...(provider
        ? {
            embeddingDimension: provider.dimension,
            embeddingModel: this.embeddingModel,
            embeddingCandidateK: this.embeddingCandidateK,
          }
        : {}),
    });

    // Apply strength decay identically to the SQLite backend (sqlite.ts:577-609):
    // compute strength from lastAccessedAt, drop rows below minStrength over the
    // FULL scored pool, cap at `limit` AFTER decay, and attach the strength field
    // so formatMemoryContext renders consistently. On the union path, queries.ts
    // returns the full, uncapped, un-touched scored pool precisely so this decay
    // filter sees every candidate before the cap (R3-001) — a fresh candidate
    // ranked below the top-N stale ones is still reachable here.
    const now = new Date();
    const result: MemoryObservationRow[] = [];
    for (const row of rows) {
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
      });
      // Cap at the originally-requested limit: we over-fetched only to absorb
      // decay drops, never to return MORE than the caller asked for.
      if (result.length >= limit) break;
    }

    // Touch last_accessed_at for EXACTLY the survivors that passed decay AND
    // made the limit cut — mirroring the SQLite oracle's `accessedIds` scoping
    // (R5.10 / R3-002). This runs ONLY on the union path: queries.ts returns
    // those rows un-touched, so a row dropped by the decay filter above is never
    // freshened (no decay-evasion). The no-provider (keyword-only) path is
    // touched inside queries.ts itself and must NOT be re-touched here, keeping
    // its call shape byte-for-byte identical to the pre-union contract (R5.11).
    if (provider && result.length > 0) {
      await bumpObservationsLastAccessed(
        this.db,
        result.map((r) => r.id),
      );
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
    // Compute embedding (+ its provider metadata) when a provider is
    // available — NULL otherwise (graceful degradation, design D3/task 4.5).
    let embedding: number[] | null = null;
    let embeddingModel: string | null = null;
    let embeddingDim: number | null = null;
    if (this.embeddingProvider) {
      try {
        embedding = await this.embeddingProvider.embed(`${data.title} ${data.content}`);
        embeddingModel = this.embeddingModel ?? null;
        embeddingDim = this.embeddingProvider.dimension;
      } catch (error) {
        // Embedding failure is non-fatal — store NULL and continue (mirrors
        // the SQLite backend's _computeEmbeddingMeta, packages/core/src/memory/sqlite.ts)
        console.warn(
          `[ghagga] embedding computation failed during save — persisting NULL embedding: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const row = await saveObservation(this.db, {
      ...data,
      embedding,
      embeddingModel,
      embeddingDim,
    });
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

  // ── Backfill (design D6) ─────────────────────────────────────────
  // Global (not installation-scoped): the backfill script is a one-time
  // admin maintenance job over the whole table (packages/core/scripts/backfill-embeddings.ts).

  async listObservationsNeedingEmbedding(options: {
    afterId: number;
    limit: number;
    activeModel: string;
    activeDim: number;
    includeMismatched: boolean;
  }): Promise<{ id: number; text: string }[]> {
    return listObservationsNeedingEmbedding(this.db, options);
  }

  async updateObservationEmbedding(
    id: number,
    embedding: number[],
    model: string,
    dim: number,
  ): Promise<void> {
    await updateObservationEmbedding(this.db, id, embedding, model, dim);
  }

  // flush() intentionally omitted: PostgreSQL writes commit per-statement,
  // no in-memory buffering to flush (design D6).
}
