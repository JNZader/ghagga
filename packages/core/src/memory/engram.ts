/**
 * Engram-backed memory storage.
 *
 * Implements the MemoryStorage interface by mapping each method to HTTP
 * calls against Engram's REST API (localhost:7437). Uses native fetch()
 * with no external dependencies.
 *
 * Graceful degradation: the async factory performs a health check. If
 * Engram is unreachable it returns null so the caller can fall back to
 * SQLite. During operation, individual method calls catch HTTP errors
 * and return safe defaults — the review never fails because of Engram.
 */

import type {
  ListObservationsOptions,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
} from '../types.js';
import { EngramClient } from './engram-client.js';
import {
  toEngramSaveData,
  toMemoryObservationDetail,
  toMemoryObservationRow,
} from './engram-mapping.js';
import type { EngramConfig } from './engram-types.js';

export class EngramMemoryStorage implements MemoryStorage {
  private client: EngramClient;

  /**
   * Maps GHAGGA numeric IDs → Engram original IDs (string | number).
   * Populated by searchObservations(), listObservations(), and saveObservation().
   * Used by getObservation() and deleteObservation() to resolve the real Engram ID.
   */
  private idMap = new Map<number, string | number>();

  private constructor(client: EngramClient) {
    this.client = client;
  }

  // ─── Factory ────────────────────────────────────────────────────

  /**
   * Async factory — creates an instance after verifying Engram is reachable.
   *
   * Config resolution order:
   *   1. Explicit `config` parameter
   *   2. Environment variables (GHAGGA_ENGRAM_HOST, GHAGGA_ENGRAM_TIMEOUT)
   *   3. Defaults (http://localhost:7437, 5000ms)
   *
   * Returns null if Engram is not reachable (caller should fall back to SQLite).
   */
  static async create(config?: Partial<EngramConfig>): Promise<EngramMemoryStorage | null> {
    const fullConfig: EngramConfig = {
      host: config?.host ?? process.env.GHAGGA_ENGRAM_HOST ?? 'http://localhost:7437',
      timeout: config?.timeout ?? Number(process.env.GHAGGA_ENGRAM_TIMEOUT ?? '5') * 1000,
    };

    const client = new EngramClient(fullConfig);
    const healthy = await client.healthCheck();

    if (!healthy) {
      console.warn(
        '[ghagga:engram] Engram server not reachable at %s — falling back to SQLite',
        fullConfig.host,
      );
      return null;
    }

    return new EngramMemoryStorage(client);
  }

  // ─── Hot-path methods ───────────────────────────────────────────

  async searchObservations(
    project: string,
    query: string,
    options: { limit?: number; type?: string } = {},
  ): Promise<MemoryObservationRow[]> {
    const { limit = 10, type } = options;

    // The `type` filter is applied CLIENT-SIDE (Engram's REST search exposes no
    // server-side type predicate). If we only fetched `limit` rows, a real
    // type-matched duplicate sitting at position limit+1 — behind `limit`
    // keyword matches of OTHER types — would be silently dropped before the
    // filter ever sees it. So when a type filter is present we OVER-FETCH from
    // the server (limit * 3, mirroring the Postgres/SQLite adapters'
    // fetchLimit = limit*3 over-fetch in postgres.ts:64 / sqlite.ts:281), then
    // filter by type and slice back to `limit`. Without a type filter there is
    // nothing to drop, so we fetch exactly `limit`.
    const fetchLimit = type ? limit * 3 : limit;

    const results = await this.client.search(query, project, fetchLimit);

    let mapped = results.map((obs) => {
      const row = toMemoryObservationRow(obs);
      this.trackId(row.id, obs.id);
      return row;
    });

    // Client-side type filter (Engram may not support it natively), then slice
    // back to the caller's requested `limit` — we over-fetched only to absorb
    // other-typed rows ahead of the matches, never to return MORE than asked.
    if (type) {
      mapped = mapped.filter((r) => r.type === type).slice(0, limit);
    }

    return mapped;
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
    const payload = toEngramSaveData(data);
    const result = await this.client.save(payload);

    if (!result) {
      // Graceful degradation: return a synthetic row so the pipeline continues
      console.warn('[ghagga:engram] saveObservation: Engram save failed, returning synthetic row');
      return {
        id: -1,
        type: data.type,
        title: data.title,
        content: data.content,
        filePaths: data.filePaths ?? null,
        severity: data.severity ?? null,
      };
    }

    const row = toMemoryObservationRow(result);
    this.trackId(row.id, result.id);
    return row;
  }

  // ─── Session methods ────────────────────────────────────────────

  async createSession(data: { project: string; prNumber?: number }): Promise<{ id: number }> {
    const sessionId = await this.client.createSession(data.project);

    if (sessionId == null) {
      console.warn('[ghagga:engram] createSession failed, returning synthetic id');
      return { id: -1 };
    }

    return { id: sessionId };
  }

  async endSession(sessionId: number, summary: string): Promise<void> {
    // Skip if session was never properly created
    if (sessionId === -1) return;

    await this.client.endSession(sessionId, summary);
  }

  /** No-op — HTTP connections don't need explicit cleanup. */
  async close(): Promise<void> {
    // Nothing to clean up for HTTP-based storage
  }

  // ─── Management methods ─────────────────────────────────────────

  async listObservations(
    options: ListObservationsOptions = {},
  ): Promise<MemoryObservationDetail[]> {
    const { project, type, limit = 20 } = options;

    // Use search with empty query to list all observations
    const results = await this.client.search('', project, limit);

    let mapped = results.map((obs) => {
      const detail = toMemoryObservationDetail(obs);
      this.trackId(detail.id, obs.id);
      return detail;
    });

    // Client-side type filter
    if (type) {
      mapped = mapped.filter((r) => r.type === type);
    }

    // Client-side offset (Engram may not support it natively)
    if (options.offset && options.offset > 0) {
      mapped = mapped.slice(options.offset);
    }

    return mapped;
  }

  async getObservation(id: number): Promise<MemoryObservationDetail | null> {
    const realId = this.idMap.get(id);

    if (realId == null) {
      console.warn(
        '[ghagga:engram] getObservation: ID %d not found in local map. ' +
          'Run searchObservations or listObservations first.',
        id,
      );
      return null;
    }

    const obs = await this.client.getObservation(realId);
    if (!obs) return null;

    return toMemoryObservationDetail(obs);
  }

  async deleteObservation(id: number): Promise<boolean> {
    const realId = this.idMap.get(id);

    if (realId == null) {
      console.warn('[ghagga:engram] deleteObservation: ID %d not found in local map.', id);
      return false;
    }

    const deleted = await this.client.deleteObservation(realId);
    if (deleted) {
      this.idMap.delete(id);
    }
    return deleted;
  }

  async getStats(): Promise<MemoryStats> {
    const stats = await this.client.getStats();

    if (!stats) {
      return {
        totalObservations: 0,
        byType: {},
        byProject: {},
        oldestObservation: null,
        newestObservation: null,
      };
    }

    // Map Engram stats to GHAGGA's MemoryStats shape
    const byProject: Record<string, number> = {};
    if (stats.projects) {
      for (const p of stats.projects) {
        byProject[p] = 0; // Engram doesn't provide per-project counts in stats
      }
    }

    return {
      totalObservations: stats.total_observations,
      byType: {}, // Engram stats endpoint doesn't break down by type
      byProject,
      oldestObservation: null, // Not provided by Engram stats
      newestObservation: null, // Not provided by Engram stats
    };
  }

  /**
   * Not supported by the Engram HTTP API.
   * Use the `engram` CLI directly for bulk operations.
   */
  async clearObservations(_options?: { project?: string }): Promise<number> {
    console.warn(
      '[ghagga:engram] clearObservations is not supported with the Engram backend. ' +
        'Use the "engram" CLI directly for bulk deletion.',
    );
    return 0;
  }

  // ─── Internal helpers ───────────────────────────────────────────

  /**
   * Track the mapping between a GHAGGA numeric ID and the original Engram ID.
   * This allows getObservation() and deleteObservation() to resolve the real ID.
   */
  private trackId(numericId: number, engramId: string | number): void {
    if (!this.idMap.has(numericId)) {
      this.idMap.set(numericId, engramId);
    }
  }
}
