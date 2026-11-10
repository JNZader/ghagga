/**
 * Honesty legend for the blast-radius diagram (blast-radius-diagram T4.3).
 *
 * Extracted from the diagram renderer so BOTH failure fallbacks can show it
 * without a static import across the lazy-chunk boundary: the renderer's own
 * render-failure fallback, and the lazy-load failure boundary in
 * pages/Reviews.tsx (a rejected dynamic import can never reach code inside
 * the chunk — the boundary duplicates the fallback around it). This module
 * must stay mermaid-free: pages/Reviews.tsx imports it from the MAIN bundle.
 *
 * Mirrors the review comment's legend: every flag on `meta` is rendered,
 * none silently dropped. Trusted literals + counts only — no file names,
 * no untrusted strings. The flag→note decision tree and wording MIRROR
 * `formatBlastRadiusSection` in `packages/core/src/format.ts` — update
 * the two together (deliberately NOT a shared module: the dashboard must
 * not import core; both render from the same persisted diagram DTO).
 */

import type { BlastRadiusDiagram } from '@ghagga/types';

export function DiagramLegend({ meta }: { meta?: BlastRadiusDiagram['meta'] }) {
  // Defensive default: a corrupt blob without `meta` must render an empty
  // legend, never a TypeError that bricks the page (4R RES-002 — the
  // server guard also shape-checks, this is defense in depth).
  const m: BlastRadiusDiagram['meta'] = meta ?? {
    stale: false,
    exceededCap: false,
    truncated: false,
  };
  const notes: string[] = [];
  if (m.stale) {
    notes.push('Dependency graph is older than 7 days — relationships may be incomplete.');
  }
  if (m.exceededCap) {
    notes.push('Blast radius exceeded the file cap — the full diff was reviewed.');
  }
  if (m.clusterCounts) {
    const omitted = Object.values(m.clusterCounts).reduce((sum, count) => sum + count, 0);
    if (omitted > 0) notes.push(`+${omitted} more files not shown (render cap).`);
  } else if (m.truncated) {
    notes.push('Some edges not shown (render cap).');
  }
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-text-secondary">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

export default DiagramLegend;
