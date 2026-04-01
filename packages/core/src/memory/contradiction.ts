/**
 * Contradiction detection for memory merge operations.
 *
 * During a branch merge, observations from the source and target branches
 * may conflict — e.g., one says "use prepared statements" while the other
 * says "raw SQL is acceptable here" for the same file and category.
 *
 * This module detects such contradictions by comparing file paths and
 * categories between observation sets.
 */

import type { Contradiction, MemoryObservationRow, VersioningConfig } from '../types.js';
import { DEFAULT_VERSIONING_CONFIG } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Extract the category from an observation's content.
 * Content format: "[SEVERITY] category\nFile: ...\nIssue: ..."
 * Falls back to the observation type if parsing fails.
 */
function extractCategory(obs: MemoryObservationRow): string {
  const firstLine = obs.content.split('\n')[0] ?? '';
  const match = firstLine.match(/^\[[\w]+\]\s*(.+)$/);
  return match?.[1]?.trim().toLowerCase() ?? obs.type.toLowerCase();
}

/**
 * Extract file paths from an observation.
 * Uses the filePaths array if available, otherwise extracts from content.
 */
function extractFiles(obs: MemoryObservationRow): string[] {
  if (obs.filePaths && obs.filePaths.length > 0) {
    return obs.filePaths;
  }

  // Fallback: parse "File: path" from content
  const fileMatch = obs.content.match(/File:\s*(.+?)(?:\n|$)/);
  if (fileMatch?.[1]) {
    // Strip line number suffix (e.g., "src/auth.ts:42" → "src/auth.ts")
    return [fileMatch[1].replace(/:\d+$/, '').trim()];
  }

  return [];
}

/**
 * Compute a similarity score between two observations.
 * Returns a value between 0.0 (no overlap) and 1.0 (perfect match).
 *
 * Factors:
 * - File path overlap (weighted 0.6)
 * - Category match (weighted 0.4)
 */
function computeSimilarity(a: MemoryObservationRow, b: MemoryObservationRow): number {
  let score = 0;

  // File overlap
  const filesA = new Set(extractFiles(a));
  const filesB = new Set(extractFiles(b));
  if (filesA.size > 0 && filesB.size > 0) {
    let overlap = 0;
    for (const f of filesA) {
      if (filesB.has(f)) overlap++;
    }
    const union = new Set([...filesA, ...filesB]).size;
    score += (overlap / union) * 0.6;
  }

  // Category match
  const catA = extractCategory(a);
  const catB = extractCategory(b);
  if (catA === catB) {
    score += 0.4;
  }

  return score;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Detect contradictions between two sets of observations.
 *
 * Two observations are considered contradictory when they target the same
 * file(s) and category but have different severities or conflicting content.
 * The similarity threshold controls how aggressively contradictions are flagged.
 *
 * @param sourceObs - Observations from the source branch (being merged in)
 * @param targetObs - Observations on the target branch (existing)
 * @param config - Versioning configuration with contradiction threshold
 * @returns Array of detected contradictions
 */
export function detectContradictions(
  sourceObs: MemoryObservationRow[],
  targetObs: MemoryObservationRow[],
  config: VersioningConfig = DEFAULT_VERSIONING_CONFIG,
): Contradiction[] {
  const contradictions: Contradiction[] = [];

  for (const src of sourceObs) {
    for (const tgt of targetObs) {
      const similarity = computeSimilarity(src, tgt);

      if (similarity >= config.contradictionThreshold) {
        // Same area — check if they actually conflict (different severity or different content)
        const sevA = src.severity?.toLowerCase() ?? '';
        const sevB = tgt.severity?.toLowerCase() ?? '';
        const severityDiffers = sevA !== sevB && sevA !== '' && sevB !== '';

        const contentDiffers = src.content !== tgt.content;

        if (severityDiffers || contentDiffers) {
          const files = [...new Set([...extractFiles(src), ...extractFiles(tgt)])];
          contradictions.push({
            observationA: src,
            observationB: tgt,
            reason: severityDiffers
              ? `Same area (${files.join(', ')}), conflicting severity: ${sevA} vs ${sevB}`
              : `Same area (${files.join(', ')}), different findings for ${extractCategory(src)}`,
          });
        }
      }
    }
  }

  return contradictions;
}

// Re-export helpers for testing
export { computeSimilarity, extractCategory, extractFiles };
