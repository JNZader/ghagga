/**
 * `ghagga memory backfill` subcommand.
 *
 * Backfills per-row embeddings for observations saved before an embedding
 * provider was configured, or after a provider/model swap (design D6,
 * task 6.3). Calls the shared `backfillEmbeddings` routine from
 * `ghagga-core` directly — the same routine used by the server admin script
 * (apps/server/scripts/backfill-embeddings.ts) — so both entry points share
 * identical backfill semantics.
 */

import type { Command } from 'commander';
import { backfillEmbeddings } from 'ghagga-core';
import { resolveCliEmbeddingProvider } from '../../lib/embedding.js';
import * as tui from '../../ui/tui.js';
import { openMemoryOrExit } from './utils.js';

export function registerBackfillCommand(parent: Command): void {
  parent
    .command('backfill')
    .description('Backfill embeddings for observations with a missing or stale embedding')
    .option('--batch <n>', 'Rows per embedBatch() call', '100')
    .option('--limit <n>', 'Maximum total rows to process')
    .option(
      '--re-embed',
      'Also re-embed rows whose stored model/dimension mismatches the active provider (not just NULL)',
      false,
    )
    .option('--delay <ms>', 'Delay between batches in milliseconds (rate/cost control)', '0')
    .action(async (opts: { batch: string; limit?: string; reEmbed: boolean; delay: string }) => {
      const { config, provider } = resolveCliEmbeddingProvider();
      if (!provider || !config.model) {
        tui.log.error(
          'No embedding provider configured (EMBEDDING_PROVIDER=none or unset) — backfill is meaningless with no provider. Set EMBEDDING_PROVIDER/EMBEDDING_MODEL/EMBEDDING_BASE_URL first.',
        );
        process.exit(1);
      }

      const { storage } = await openMemoryOrExit();
      try {
        const result = await backfillEmbeddings(storage, provider, config.model, {
          batchSize: parseInt(opts.batch, 10),
          limit: opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined,
          reEmbed: opts.reEmbed,
          delayMs: parseInt(opts.delay, 10),
          onProgress: ({ batch, batchSize, totalProcessed }) => {
            tui.log.message(
              `  batch ${batch}: embedded ${batchSize} rows (${totalProcessed} total)`,
            );
          },
        });

        tui.log.info(
          `Backfill complete: ${result.totalProcessed} rows embedded across ${result.totalBatches} batches.`,
        );
      } finally {
        await storage.close();
      }
    });
}
