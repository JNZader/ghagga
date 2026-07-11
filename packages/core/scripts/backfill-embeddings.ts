#!/usr/bin/env -S npx tsx

/**
 * Standalone backfill entry point (design D6, task 6.1/6.3).
 *
 * Runs `backfillEmbeddings` (packages/core/src/memory/backfill.ts) against a
 * local SQLite memory database, resolving the active embedding provider from
 * `EMBEDDING_*` env vars via the shared `resolveEmbeddingConfig` /
 * `createEmbeddingProvider` resolver (same config surface used by every
 * construction site — server, CLI, Action).
 *
 * This file is NOT part of `ghagga-core`'s compiled output (excluded from
 * `tsc`'s `rootDir: src`) — it is a directly-runnable maintenance script,
 * mirroring `scripts/copy-assets.mjs`. Run it with `tsx`:
 *
 *   npx tsx packages/core/scripts/backfill-embeddings.ts --db ~/.config/ghagga/memory.db
 *
 * For the PostgreSQL-backed server database, use the server admin script
 * instead: `pnpm --filter ghagga-server memory:backfill` (apps/server/scripts/backfill-embeddings.ts).
 * The CLI's `ghagga memory backfill` subcommand calls the same
 * `backfillEmbeddings` routine directly (apps/cli/src/commands/memory/backfill.ts)
 * rather than spawning this script, so both entry points always share
 * identical backfill semantics.
 *
 * Flags:
 *   --db <path>       SQLite memory.db path (required)
 *   --batch <n>        Rows per embedBatch() call. Default 100.
 *   --limit <n>        Max total rows to process. Default unlimited.
 *   --re-embed         Also re-embed model/dimension-mismatched rows, not just NULL.
 *   --delay <ms>       Delay between batches (rate/cost control). Default 0.
 */

import { createEmbeddingProvider, resolveEmbeddingConfig } from '../src/embed.js';
import { backfillEmbeddings } from '../src/memory/backfill.js';
import { SqliteMemoryStorage } from '../src/memory/sqlite.js';

interface ParsedArgs {
  db?: string;
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
      case '--db':
        parsed.db = argv[++i];
        break;
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

  if (!args.db) {
    console.error('[ghagga] --db <path> is required (path to the SQLite memory.db file).');
    process.exit(1);
  }

  const config = resolveEmbeddingConfig(process.env);
  const provider = createEmbeddingProvider(config);
  if (!provider || !config.model) {
    console.error(
      '[ghagga] No embedding provider configured (EMBEDDING_PROVIDER=none or unset) — backfill is meaningless with no provider.',
    );
    process.exit(1);
  }

  const storage = await SqliteMemoryStorage.create(args.db, {
    embeddingProvider: provider,
    embeddingModel: config.model,
    embeddingCandidateK: config.candidateK,
  });

  try {
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
  } finally {
    await storage.close();
  }
}

main().catch((error) => {
  console.error('[ghagga] backfill failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
