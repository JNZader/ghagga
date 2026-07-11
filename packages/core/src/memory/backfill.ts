/**
 * Backfill mechanism for per-row embeddings (design D6, spec: "Backfill of
 * NULL-Embedding Observations").
 *
 * Reusable across every storage backend that implements the backfill
 * extension of `MemoryStorage` (`SqliteMemoryStorage`, `PostgresMemoryStorage`).
 * Iterates observations needing an embedding in id-ordered batches, calls
 * the active provider's `embedBatch` ONCE per batch (never N `embed()` calls
 * — spec: "Batched Embedding Calls"), and persists the result.
 *
 * Idempotent + resumable: each batch is selected fresh from storage via
 * `listObservationsNeedingEmbedding`, which only ever matches NULL-embedding
 * rows (plus model/dimension-mismatched rows when `reEmbed` is set) — a row
 * already embedded with a matching model/dimension is never re-selected. A
 * failure mid-run (network error, process crash) leaves all rows updated
 * before the failure committed (SQLite: flushed to disk after each
 * successfully completed batch via `storage.flush()`; PostgreSQL: each
 * `UPDATE` commits per-statement, no explicit transaction) — re-running this
 * function picks up exactly where it left off with no duplicate work.
 */

import type { EmbeddingProvider } from '../embed.js';
import type { MemoryStorage } from '../types.js';

export interface BackfillOptions {
  /** Rows processed per `embedBatch()` call. Defaults to 100 (design D6). */
  batchSize?: number;
  /** Max total rows to process across the whole run. Unlimited when omitted. */
  limit?: number;
  /**
   * Also re-embed rows whose stored `embedding_model`/`embedding_dim`
   * mismatches the active provider — not just NULL-embedding rows. Use
   * after a provider/model swap (design D6, task 8.3 rollout note).
   * Defaults to false.
   */
  reEmbed?: boolean;
  /** Delay (ms) between batches — rate/cost control for paid API providers. Defaults to 0. */
  delayMs?: number;
  /** Optional progress callback, invoked after each successfully committed batch. */
  onProgress?: (progress: { batch: number; batchSize: number; totalProcessed: number }) => void;
}

export interface BackfillResult {
  totalProcessed: number;
  totalBatches: number;
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * Run the backfill against `storage`, using `provider` as the active
 * embedding provider and `activeModel` as the model id to persist alongside
 * each embedding.
 *
 * Throws if `storage` doesn't implement the backfill extension methods
 * (`listObservationsNeedingEmbedding` / `updateObservationEmbedding`) — e.g.
 * `EngramMemoryStorage`, which has no local embedding column to backfill.
 */
export async function backfillEmbeddings(
  storage: MemoryStorage,
  provider: EmbeddingProvider,
  activeModel: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const listNeeding = storage.listObservationsNeedingEmbedding;
  const updateEmbedding = storage.updateObservationEmbedding;
  if (!listNeeding || !updateEmbedding) {
    throw new Error(
      '[ghagga] This memory storage backend does not support backfill (no local embedding columns).',
    );
  }
  // Bind after the presence check so TS narrows the optional methods to
  // defined function types for the rest of this function.
  const listObservationsNeedingEmbedding = listNeeding.bind(storage);
  const updateObservationEmbedding = updateEmbedding.bind(storage);

  const {
    batchSize = DEFAULT_BATCH_SIZE,
    limit,
    reEmbed = false,
    delayMs = 0,
    onProgress,
  } = options;

  let afterId = 0;
  let totalProcessed = 0;
  let totalBatches = 0;

  while (true) {
    if (limit !== undefined && totalProcessed >= limit) break;
    const remaining = limit !== undefined ? limit - totalProcessed : batchSize;
    const currentBatchSize = Math.min(batchSize, remaining);
    if (currentBatchSize <= 0) break;

    const rows = await listObservationsNeedingEmbedding({
      afterId,
      limit: currentBatchSize,
      activeModel,
      activeDim: provider.dimension,
      includeMismatched: reEmbed,
    });

    if (rows.length === 0) break;

    const embeddings = await provider.embedBatch(rows.map((row) => row.text));
    if (embeddings.length !== rows.length) {
      throw new Error(
        `[ghagga] embedBatch returned ${embeddings.length} vectors for ${rows.length} inputs — mismatched batch response.`,
      );
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const embedding = embeddings[i];
      await updateObservationEmbedding(row.id, embedding, activeModel, provider.dimension);
      afterId = row.id;
    }

    if (typeof storage.flush === 'function') {
      await storage.flush();
    }

    totalBatches += 1;
    totalProcessed += rows.length;
    onProgress?.({ batch: totalBatches, batchSize: rows.length, totalProcessed });

    if (rows.length < currentBatchSize) break; // drained — fewer rows than requested

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { totalProcessed, totalBatches };
}
