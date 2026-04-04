/**
 * `ghagga dismiss` command.
 *
 * Saves a dismissed finding as a negative example in the memory database
 * so the review pipeline will suppress it in future reviews.
 *
 * Usage:
 *   ghagga dismiss <finding-hash> --category <name> [--file <path>] [--reason <text>]
 *   ghagga dismiss list
 *   ghagga dismiss remove <finding-hash>
 */

import { Command } from 'commander';
import { fingerprintContext, type SqliteMemoryStorage } from 'ghagga-core';
import * as tui from '../ui/tui.js';
import { formatTable, openMemoryOrExit, truncate } from './memory/utils.js';

export const dismissCommand = new Command('dismiss')
  .description('Dismiss a finding so it does not appear in future reviews')
  .argument('[finding-hash]', 'Finding hash to dismiss')
  .option('--file <path>', 'File path the finding was reported on')
  .option('--category <name>', 'Finding category (e.g., "security", "style")')
  .option('--reason <text>', 'Optional reason for dismissal')
  .action(
    async (
      findingHash: string | undefined,
      opts: { file?: string; category?: string; reason?: string },
    ) => {
      // If no hash provided, show help
      if (!findingHash) {
        dismissCommand.help();
        return;
      }

      if (!opts.category) {
        tui.log.error('Error: --category is required (e.g., --category security)');
        process.exit(1);
      }

      const { storage } = await openMemoryOrExit();
      try {
        const filePath = opts.file;
        const contextHash = filePath
          ? fingerprintContext(filePath)
          : fingerprintContext(findingHash); // fallback: hash of the hash itself

        (storage as SqliteMemoryStorage).saveNegativeExample({
          findingHash,
          contextHash,
          category: opts.category,
          reason: opts.reason,
          filePath,
          createdAt: new Date(),
        });

        tui.log.success(
          `✓ Finding dismissed — will not appear in future reviews\n  hash: ${findingHash}\n  category: ${opts.category}${opts.reason ? `\n  reason: ${opts.reason}` : ''}`,
        );
      } finally {
        await storage.close();
      }
    },
  );

// ─── dismiss list ────────────────────────────────────────────────

dismissCommand
  .command('list')
  .description('List all dismissed findings')
  .action(async () => {
    const { storage } = await openMemoryOrExit();
    try {
      const examples = (storage as SqliteMemoryStorage).getAllNegativeExamples();

      if (examples.length === 0) {
        tui.log.info('No dismissed findings.');
        return;
      }

      const headers = ['Hash', 'Category', 'File', 'Reason', 'Date'];
      const widths = [12, 16, 30, 24, 12];

      const rows = examples.map((ex) => [
        ex.findingHash.slice(0, 10),
        truncate(ex.category, 14),
        truncate(ex.filePath ?? '(global)', 28),
        truncate(ex.reason ?? '—', 22),
        ex.createdAt.toISOString().slice(0, 10),
      ]);

      tui.log.message(formatTable(headers, rows, widths));
    } finally {
      await storage.close();
    }
  });

// ─── dismiss remove ──────────────────────────────────────────────

dismissCommand
  .command('remove <finding-hash>')
  .description('Re-enable a previously dismissed finding')
  .action(async (findingHash: string) => {
    const { storage } = await openMemoryOrExit();
    try {
      const deleted = (storage as SqliteMemoryStorage).deleteNegativeExample(findingHash);
      if (deleted) {
        tui.log.success('✓ Dismissal removed — finding will appear in future reviews');
      } else {
        tui.log.info(`No dismissed finding found with hash: ${findingHash}`);
      }
    } finally {
      await storage.close();
    }
  });
