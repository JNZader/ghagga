import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingProvider } from '../embed.js';
import type { MemoryStorage } from '../types.js';
import { backfillEmbeddings } from './backfill.js';
import { SqliteMemoryStorage } from './sqlite.js';

// ─── Test Setup ─────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghagga-backfill-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────

function makeObservationData(overrides: Partial<{ title: string; content: string }> = {}) {
  return {
    project: 'owner/repo',
    type: 'pattern',
    title: 'Test observation',
    content: 'Some content about auth patterns.',
    ...overrides,
  };
}

/** Reads embedding_model/embedding_dim/embedding-presence directly (test-only introspection). */
function readEmbeddingMeta(
  storage: SqliteMemoryStorage,
  id: number,
): { hasEmbedding: boolean; model: string | null; dim: number | null } {
  const db = storage.getDatabase();
  const result = db.exec(
    'SELECT embedding IS NOT NULL AS has_embedding, embedding_model, embedding_dim FROM memory_observations WHERE id = ?',
    [id],
  );
  const row = result[0]?.values[0];
  if (!row) throw new Error(`No row found for id ${id}`);
  return {
    hasEmbedding: row[0] === 1,
    model: (row[1] as string) ?? null,
    dim: (row[2] as number) ?? null,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('backfillEmbeddings (design D6)', () => {
  it('populates all NULL-embedding rows and persists provider model id + dimension', async () => {
    // No embeddingProvider on the storage itself — rows save with NULL
    // embeddings, exactly the "observation saved before a provider was
    // configured" scenario the backfill targets.
    const storage = await SqliteMemoryStorage.create(dbPath);
    const obs1 = await storage.saveObservation(
      makeObservationData({ title: 'Rotate secrets', content: 'We rotate credentials.' }),
    );
    const obs2 = await storage.saveObservation(
      makeObservationData({ title: 'Auth flow', content: 'JWT validation notes.' }),
    );

    expect(readEmbeddingMeta(storage, obs1.id).hasEmbedding).toBe(false);
    expect(readEmbeddingMeta(storage, obs2.id).hasEmbedding).toBe(false);

    const provider = new FakeEmbeddingProvider(8);
    const result = await backfillEmbeddings(storage, provider, 'fake-model-v1');

    expect(result).toEqual({ totalProcessed: 2, totalBatches: 1 });

    const meta1 = readEmbeddingMeta(storage, obs1.id);
    const meta2 = readEmbeddingMeta(storage, obs2.id);
    expect(meta1).toEqual({ hasEmbedding: true, model: 'fake-model-v1', dim: 8 });
    expect(meta2).toEqual({ hasEmbedding: true, model: 'fake-model-v1', dim: 8 });

    await storage.close();
  });

  it('skips rows that already have a matching-dimension embedding', async () => {
    const provider = new FakeEmbeddingProvider(8);
    // Save WITH the provider already configured — rows get embedded at
    // save time and should be untouched by backfill.
    const storage = await SqliteMemoryStorage.create(dbPath, {
      embeddingProvider: provider,
      embeddingModel: 'fake-model-v1',
    });
    const embedded = await storage.saveObservation(makeObservationData({ title: 'Embedded' }));
    await storage.close();

    // Re-open WITHOUT a provider so saveObservation for the second row
    // leaves a genuine NULL — a realistic "partial backfill" starting state.
    const storage2 = await SqliteMemoryStorage.create(dbPath);
    const unembedded = await storage2.saveObservation(
      makeObservationData({ title: 'Not yet embedded' }),
    );

    const embedBatchSpy = vi.spyOn(provider, 'embedBatch');
    const result = await backfillEmbeddings(storage2, provider, 'fake-model-v1');

    expect(result.totalProcessed).toBe(1);
    // Only the NULL row's text is sent to embedBatch — the already-embedded
    // row's text must never be included.
    expect(embedBatchSpy).toHaveBeenCalledTimes(1);
    expect(embedBatchSpy.mock.calls[0]?.[0]).toEqual([
      'Not yet embedded Some content about auth patterns.',
    ]);
    expect(readEmbeddingMeta(storage2, embedded.id)).toEqual({
      hasEmbedding: true,
      model: 'fake-model-v1',
      dim: 8,
    });
    expect(readEmbeddingMeta(storage2, unembedded.id)).toEqual({
      hasEmbedding: true,
      model: 'fake-model-v1',
      dim: 8,
    });

    await storage2.close();
  });

  it('calls embedBatch ONCE per batch, not once per row (spec: Batched Embedding Calls)', async () => {
    const storage = await SqliteMemoryStorage.create(dbPath);
    for (let i = 0; i < 5; i++) {
      await storage.saveObservation(
        makeObservationData({ title: `Obs ${i}`, content: `Content ${i}` }),
      );
    }

    const provider = new FakeEmbeddingProvider(8);
    const embedBatchSpy = vi.spyOn(provider, 'embedBatch');

    const result = await backfillEmbeddings(storage, provider, 'fake-model-v1', { batchSize: 2 });

    expect(result).toEqual({ totalProcessed: 5, totalBatches: 3 }); // 2 + 2 + 1
    expect(embedBatchSpy).toHaveBeenCalledTimes(3);

    await storage.close();
  });

  it('caps total processed rows at --limit', async () => {
    const storage = await SqliteMemoryStorage.create(dbPath);
    for (let i = 0; i < 5; i++) {
      await storage.saveObservation(
        makeObservationData({ title: `Obs ${i}`, content: `Content ${i}` }),
      );
    }

    const provider = new FakeEmbeddingProvider(8);
    const result = await backfillEmbeddings(storage, provider, 'fake-model-v1', {
      batchSize: 2,
      limit: 3,
    });

    expect(result).toEqual({ totalProcessed: 3, totalBatches: 2 }); // 2 + 1, capped by limit

    await storage.close();
  });

  it('re-run is idempotent: already-matching rows are skipped, only NULL/mismatched rows are re-embedded', async () => {
    const storage = await SqliteMemoryStorage.create(dbPath);
    const obs1 = await storage.saveObservation(makeObservationData({ title: 'One' }));
    const obs2 = await storage.saveObservation(makeObservationData({ title: 'Two' }));

    const provider = new FakeEmbeddingProvider(8);
    const firstRun = await backfillEmbeddings(storage, provider, 'fake-model-v1');
    expect(firstRun.totalProcessed).toBe(2);

    // Add one more NULL row after the first run.
    const obs3 = await storage.saveObservation(makeObservationData({ title: 'Three' }));

    const embedBatchSpy = vi.spyOn(provider, 'embedBatch');
    const secondRun = await backfillEmbeddings(storage, provider, 'fake-model-v1');

    // Only obs3 (still NULL) is re-embedded — obs1/obs2 are matching and skipped.
    expect(secondRun.totalProcessed).toBe(1);
    expect(embedBatchSpy).toHaveBeenCalledTimes(1);
    expect(embedBatchSpy.mock.calls[0]?.[0]).toEqual(['Three Some content about auth patterns.']);

    expect(readEmbeddingMeta(storage, obs1.id).model).toBe('fake-model-v1');
    expect(readEmbeddingMeta(storage, obs2.id).model).toBe('fake-model-v1');
    expect(readEmbeddingMeta(storage, obs3.id).model).toBe('fake-model-v1');

    await storage.close();
  });

  it('without --re-embed, model-mismatched rows are left untouched', async () => {
    const oldProvider = new FakeEmbeddingProvider(8);
    const storage = await SqliteMemoryStorage.create(dbPath, {
      embeddingProvider: oldProvider,
      embeddingModel: 'old-model',
    });
    const obs = await storage.saveObservation(makeObservationData({ title: 'Stale embedding' }));
    expect(readEmbeddingMeta(storage, obs.id).model).toBe('old-model');

    const newProvider = new FakeEmbeddingProvider(8);
    const embedBatchSpy = vi.spyOn(newProvider, 'embedBatch');
    const result = await backfillEmbeddings(storage, newProvider, 'new-model');

    expect(result).toEqual({ totalProcessed: 0, totalBatches: 0 });
    expect(embedBatchSpy).not.toHaveBeenCalled();
    expect(readEmbeddingMeta(storage, obs.id).model).toBe('old-model'); // untouched

    await storage.close();
  });

  it('--re-embed also re-embeds model-mismatched rows', async () => {
    const oldProvider = new FakeEmbeddingProvider(8);
    const storage = await SqliteMemoryStorage.create(dbPath, {
      embeddingProvider: oldProvider,
      embeddingModel: 'old-model',
    });
    const obs = await storage.saveObservation(makeObservationData({ title: 'Stale embedding' }));

    const newProvider = new FakeEmbeddingProvider(8);
    const result = await backfillEmbeddings(storage, newProvider, 'new-model', { reEmbed: true });

    expect(result).toEqual({ totalProcessed: 1, totalBatches: 1 });
    expect(readEmbeddingMeta(storage, obs.id).model).toBe('new-model');

    await storage.close();
  });

  it('resumable after a simulated mid-batch failure: rows committed before the failure stay populated', async () => {
    const storage = await SqliteMemoryStorage.create(dbPath);
    const obs1 = await storage.saveObservation(makeObservationData({ title: 'One' }));
    const obs2 = await storage.saveObservation(makeObservationData({ title: 'Two' }));
    const obs3 = await storage.saveObservation(makeObservationData({ title: 'Three' }));

    const provider = new FakeEmbeddingProvider(8);

    // Simulate a crash on the 2nd row's persistence within a single batch of 3.
    const realUpdate = storage.updateObservationEmbedding.bind(storage);
    let callCount = 0;
    vi.spyOn(storage, 'updateObservationEmbedding').mockImplementation(
      async (id, embedding, model, dim) => {
        callCount++;
        if (callCount === 2) throw new Error('simulated mid-batch failure');
        return realUpdate(id, embedding, model, dim);
      },
    );

    await expect(
      backfillEmbeddings(storage, provider, 'fake-model-v1', { batchSize: 3 }),
    ).rejects.toThrow('simulated mid-batch failure');

    // Row 1 (processed before the throw) is committed; rows 2/3 are not.
    expect(readEmbeddingMeta(storage, obs1.id).hasEmbedding).toBe(true);
    expect(readEmbeddingMeta(storage, obs2.id).hasEmbedding).toBe(false);
    expect(readEmbeddingMeta(storage, obs3.id).hasEmbedding).toBe(false);

    // Restore the real implementation and re-run — resumable, idempotent:
    // only the still-NULL rows (2, 3) are re-embedded.
    vi.mocked(storage.updateObservationEmbedding).mockRestore();
    const embedBatchSpy = vi.spyOn(provider, 'embedBatch');
    const resumed = await backfillEmbeddings(storage, provider, 'fake-model-v1', { batchSize: 3 });

    expect(resumed.totalProcessed).toBe(2);
    expect(embedBatchSpy.mock.calls[0]?.[0]).toEqual([
      'Two Some content about auth patterns.',
      'Three Some content about auth patterns.',
    ]);
    expect(readEmbeddingMeta(storage, obs1.id).hasEmbedding).toBe(true);
    expect(readEmbeddingMeta(storage, obs2.id).hasEmbedding).toBe(true);
    expect(readEmbeddingMeta(storage, obs3.id).hasEmbedding).toBe(true);

    await storage.close();
  });

  it('throws a clear error when the storage backend does not support backfill', async () => {
    const unsupportedStorage: MemoryStorage = {
      searchObservations: vi.fn().mockResolvedValue([]),
      saveObservation: vi.fn(),
      createSession: vi.fn(),
      endSession: vi.fn(),
      close: vi.fn(),
      listObservations: vi.fn(),
      getObservation: vi.fn(),
      deleteObservation: vi.fn(),
      getStats: vi.fn(),
      clearObservations: vi.fn(),
      // listObservationsNeedingEmbedding / updateObservationEmbedding omitted
      // — mirrors EngramMemoryStorage, which has no local embedding column.
    };

    const provider = new FakeEmbeddingProvider(8);
    await expect(backfillEmbeddings(unsupportedStorage, provider, 'fake-model-v1')).rejects.toThrow(
      /does not support backfill/,
    );
  });
});
