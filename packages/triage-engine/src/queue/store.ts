/**
 * Local JSON queue persistence (design.md decision 3 — NOT ghagga-db). One
 * queue file per target repo, under `~/.ghagga-triage/<repo-slug>/queue.json`
 * by default, matching the biogas PoC's `~/.biogas-triage/queue.json` shape
 * generalized to be forge/repo-aware (multi-project safe).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IssueDraft } from '../types/draft.js';

/** Queue keyed by issue iid (string). */
export type Queue = Record<string, IssueDraft>;

const DEFAULT_QUEUE_BASE_DIR = join(homedir(), '.ghagga-triage');

/** `owner/name` -> a filesystem-safe slug (`owner-name`). */
export function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export interface QueuePathOptions {
  /** Overrides the default `~/.ghagga-triage` base directory (mainly for tests). */
  baseDir?: string;
}

export function defaultQueuePath(repo: string, options: QueuePathOptions = {}): string {
  const base = options.baseDir ?? DEFAULT_QUEUE_BASE_DIR;
  return join(base, repoSlug(repo), 'queue.json');
}

/**
 * Loads the queue at `queuePath`. A MISSING file is a fresh queue (`{}`). A file
 * that EXISTS but is corrupt is NOT silently discarded — it throws loudly,
 * because returning `{}` over a corrupt-but-present queue would drop every draft,
 * including `POSTED` idempotency state (risking a re-post). Repair or delete the
 * file deliberately; never let a transient corruption erase the queue.
 */
export function loadQueue(queuePath: string): Queue {
  let raw: string;
  try {
    raw = readFileSync(queuePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err; // permission/IO error — surface it, don't mask a real fault as an empty queue
  }
  try {
    return JSON.parse(raw) as Queue;
  } catch (err) {
    throw new Error(
      `Refusing to load a corrupt triage queue at ${queuePath}: ${(err as Error).message}. ` +
        'The file exists but is not valid JSON; loading it as empty would drop every draft ' +
        '(including POSTED state and its de-dup guard). Inspect and repair, or remove it deliberately.',
    );
  }
}

/**
 * Persists `queue` to `queuePath`, creating parent directories as needed. The
 * write is ATOMIC (temp file + rename) so a crash or full disk mid-write never
 * truncates the live queue — the rename either fully replaces it or leaves the
 * previous good file untouched.
 */
export function saveQueue(queuePath: string, queue: Queue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  const tmp = `${queuePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, 'utf-8');
  renameSync(tmp, queuePath); // atomic on POSIX
}
