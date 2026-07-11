/**
 * Shared utilities for the `ghagga memory` command group.
 *
 * Provides database lifecycle management, confirmation prompts,
 * and plain-text formatting helpers used by all subcommands.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { SqliteMemoryStorage } from 'ghagga-core';
import { getConfigDir } from '../../lib/config.js';
import { resolveCliEmbeddingProvider } from '../../lib/embedding.js';
import {
  formatId as _formatId,
  formatSize as _formatSize,
  formatTable as _formatTable,
  truncate as _truncate,
} from '../../ui/format.js';
import * as tui from '../../ui/tui.js';

// ─── Database Lifecycle ─────────────────────────────────────────

const NO_DB_MESSAGE = 'No memory database found. Run "ghagga review" first to build memory.';

/**
 * Resolve the DB path, check existence, and open storage.
 * Prints a message and exits 0 if the DB file doesn't exist.
 * Returns the storage instance and resolved dbPath.
 */
export async function openMemoryOrExit(): Promise<{
  storage: SqliteMemoryStorage;
  dbPath: string;
}> {
  const configDir = getConfigDir();
  const dbPath = join(configDir, 'memory.db');

  if (!existsSync(dbPath)) {
    tui.log.info(NO_DB_MESSAGE);
    process.exit(0);
  }

  // Provider + model/candidateK threaded from the merged CLI config (design
  // D2, task 5.2) — when unconfigured, `provider` is undefined and
  // `SqliteMemoryStorage` falls back to keyword-only search unchanged.
  const { config, provider } = resolveCliEmbeddingProvider();
  const storage = await SqliteMemoryStorage.create(dbPath, {
    ...(provider
      ? {
          embeddingProvider: provider,
          embeddingModel: config.model,
          embeddingCandidateK: config.candidateK,
        }
      : {}),
  });
  return { storage, dbPath };
}

// ─── Confirmation ───────────────────────────────────────────────

/**
 * Handle confirmation flow for destructive operations.
 *
 * - force=true: returns immediately (no prompt)
 * - Non-TTY without force: prints error, exits 1
 * - TTY without force: prompts, exits 0 on cancel
 */
export async function confirmOrExit(message: string, force: boolean): Promise<void> {
  if (force) return;

  if (!process.stdin.isTTY) {
    tui.log.error('Error: Destructive operation requires --force in non-interactive mode.');
    process.exit(1);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(message);
    if (answer.trim().toLowerCase() !== 'y') {
      tui.log.info('Cancelled.');
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

// ─── Formatting Helpers ─────────────────────────────────────────
// Re-exported from ui/format.js — kept here for backwards compatibility.

/**
 * Format a plain-text table with headers, separator, and padded columns.
 * No ANSI colors — plain text only (CC3).
 */
export function formatTable(headers: string[], rows: string[][], widths: number[]): string {
  return _formatTable(headers, rows, widths);
}

/**
 * Format bytes as human-readable size (AD8).
 * < 1024: "N bytes", < 1MB: "N.N KB", else "N.N MB"
 */
export function formatSize(bytes: number): string {
  return _formatSize(bytes);
}

/**
 * Format observation ID as 8-char zero-padded string (AD5, CC5).
 * ID 42 -> "00000042"
 */
export function formatId(id: number): string {
  return _formatId(id);
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  return _truncate(str, maxLen);
}
