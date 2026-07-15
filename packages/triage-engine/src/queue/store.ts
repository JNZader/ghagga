/**
 * Local JSON queue persistence (design.md decision 3 — NOT ghagga-db). One
 * queue file per target repo, under `~/.ghagga-triage/<repo-slug>/queue.json`
 * by default, matching the biogas PoC's `~/.biogas-triage/queue.json` shape
 * generalized to be forge/repo-aware (multi-project safe).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Loads the queue at `queuePath`. Missing file or corrupt JSON -> empty queue (never throws). */
export function loadQueue(queuePath: string): Queue {
  try {
    return JSON.parse(readFileSync(queuePath, 'utf-8')) as Queue;
  } catch {
    return {};
  }
}

/** Persists `queue` to `queuePath`, creating parent directories as needed. */
export function saveQueue(queuePath: string, queue: Queue): void {
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf-8');
}
