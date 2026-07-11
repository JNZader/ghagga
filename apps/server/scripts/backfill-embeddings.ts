#!/usr/bin/env -S npx tsx
/**
 * Server admin backfill script (design D6, task 6.3).
 *
 * Runs `backfillEmbeddings` (from `ghagga-core`) against the PostgreSQL
 * server database, resolving the active embedding provider from
 * `EMBEDDING_*` env vars via the SAME resolver used by the review worker's
 * memory construction site (apps/server/src/queues/review.ts) — no
 * server-specific config surface, no drift.
 *
 * Global (not installation-scoped): iterates the whole `memory_observations`
 * table, matching the backfill query's scope (packages/db/src/queries.ts
 * `listObservationsNeedingEmbedding`).
 *
 * Run with: `pnpm --filter @ghagga/server memory:backfill -- --batch 100`
 *
 * Flags:
 *   --batch <n>   Rows per embedBatch() call. Default 100.
 *   --limit <n>   Max total rows to process. Default unlimited.
 *   --re-embed    Also re-embed model/dimension-mismatched rows, not just NULL.
 *   --delay <ms>  Delay between batches (rate/cost control). Default 0.
 */

import { backfillEmbeddings, createEmbeddingProvider, resolveEmbeddingConfig } from 'ghagga-core';
import { createDatabaseFromEnv } from 'ghagga-db';
import { PostgresMemoryStorage } from '../src/memory/postgres.js';

interface ParsedArgs {
  batch: number;
  limit?: number;
  reEmbed: boolean;
  delay: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { batch: 100, reEmbed: false, delay: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--batch':
        parsed.batch = Number(argv[++i]);
        break;
      case '--limit':
        parsed.limit = Number(argv[++i]);
        break;
      case '--re-embed':
        parsed.reEmbed = true;
        break;
      case '--delay':
        parsed.delay = Number(argv[++i]);
        break;
      default:
        console.warn(`[ghagga] Unknown backfill-embeddings.ts argument: ${arg}`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = resolveEmbeddingConfig(process.env);
  const provider = createEmbeddingProvider(config);
  if (!provider || !config.model) {
    console.error(
      '[ghagga] No embedding provider configured (EMBEDDING_PROVIDER=none or unset) — backfill is meaningless with no provider.',
    );
    process.exit(1);
  }

  const db = createDatabaseFromEnv();
  // installationId is irrelevant here — the backfill methods are global
  // (not tenant-scoped), see PostgresMemoryStorage.listObservationsNeedingEmbedding.
  const storage = new PostgresMemoryStorage(
    db,
    0,
    provider,
    undefined,
    config.model,
    config.candidateK,
  );

  const result = await backfillEmbeddings(storage, provider, config.model, {
    batchSize: args.batch,
    limit: args.limit,
    reEmbed: args.reEmbed,
    delayMs: args.delay,
    onProgress: ({ batch, batchSize, totalProcessed }) => {
      console.log(
        `[ghagga] backfill batch ${batch}: embedded ${batchSize} rows (${totalProcessed} total)`,
      );
    },
  });

  console.log(
    `[ghagga] backfill complete: ${result.totalProcessed} rows embedded across ${result.totalBatches} batches.`,
  );
}

main().catch((error) => {
  console.error('[ghagga] backfill failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
