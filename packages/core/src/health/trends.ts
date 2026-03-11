/**
 * Health trend tracking — persistent history for score comparison.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A single health history entry. */
export interface HealthHistoryEntry {
  timestamp: string;
  score: number;
  findingCounts: Record<string, number>;
  toolsRun: string[];
  projectPath: string;
}

/** Trend comparison result. */
export interface HealthTrend {
  previous: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'unchanged' | null;
}

const HISTORY_FILE = 'health-history.json';
const MAX_ENTRIES_PER_PROJECT = 10;

/**
 * Load history entries for a project.
 * Returns [] on missing or corrupt file.
 */
export function loadHistory(configDir: string, projectPath: string): HealthHistoryEntry[] {
  const filePath = join(configDir, HISTORY_FILE);

  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    const all: HealthHistoryEntry[] = JSON.parse(raw);
    if (!Array.isArray(all)) return [];
    return all.filter((e) => e.projectPath === projectPath);
  } catch {
    return [];
  }
}

/**
 * Save a new history entry, pruning to max 10 per project.
 */
export function saveHistory(configDir: string, entry: HealthHistoryEntry): void {
  const filePath = join(configDir, HISTORY_FILE);

  try {
    // Ensure directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Load existing entries
    let all: HealthHistoryEntry[] = [];
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) all = parsed;
      }
    } catch {
      all = [];
    }

    // Add new entry
    all.push(entry);

    // Prune: keep only last MAX_ENTRIES_PER_PROJECT per project
    const grouped = new Map<string, HealthHistoryEntry[]>();
    for (const e of all) {
      const key = e.projectPath;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)?.push(e);
    }

    const pruned: HealthHistoryEntry[] = [];
    for (const entries of grouped.values()) {
      pruned.push(...entries.slice(-MAX_ENTRIES_PER_PROJECT));
    }

    writeFileSync(filePath, JSON.stringify(pruned, null, 2), 'utf-8');
  } catch {
    // Permission denied or other I/O error — silently ignore
  }
}

/**
 * Compute trend from current score vs last history entry.
 */
export function computeTrend(currentScore: number, history: HealthHistoryEntry[]): HealthTrend {
  if (history.length === 0) {
    return { previous: null, delta: null, direction: null };
  }

  const last = history[history.length - 1]!;
  const delta = currentScore - last.score;

  let direction: HealthTrend['direction'];
  if (delta > 0) direction = 'up';
  else if (delta < 0) direction = 'down';
  else direction = 'unchanged';

  return { previous: last.score, delta, direction };
}
