/**
 * Lazy-chunk failure boundary tests (resilience B2).
 *
 * React.lazy CACHES a rejected dynamic import: after a deploy invalidates
 * chunk hashes (stale HTML → 404 on the hashed chunk URL), every mount of
 * the lazy diagram renderer rethrows. Without the LOCAL boundary in
 * Reviews.tsx the error escalates to the app-level boundary and replaces
 * the ENTIRE page including nav. These tests pin the containment:
 *
 *   1. a rejected lazy import degrades to the fenced mermaid source
 *      fallback while everything AROUND the boundary keeps rendering;
 *   2. a resetKey change (opening a different review) clears the cached
 *      error so later reviews are not poisoned by the earlier failure.
 *
 * The real lazy component is never imported here — the boundary is
 * exercised with a locally-constructed rejecting lazy() and a throwing
 * child, which is exactly the error shape lazy remounts produce.
 */

import type { BlastRadiusDiagram } from '@ghagga/types';
import { render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagramLoadBoundary } from './Reviews';

const diagram: BlastRadiusDiagram = {
  mermaid: 'flowchart TD\n  n0["src/a.ts"]',
  nodes: [{ id: 'n0', label: 'src/a.ts', role: 'changed', cluster: 'src' }],
  edges: [],
  meta: { stale: true, exceededCap: false, truncated: false },
};

/** A lazy component whose chunk "failed to load" — rejection is cached by React. */
const UnreachableLazy = lazy(() =>
  Promise.reject(new TypeError('Failed to fetch dynamically imported module: chunk-404.js')),
);

/** Page skeleton around the boundary — this must SURVIVE the chunk failure. */
function PageWithLazyDiagram() {
  return (
    <div>
      <nav data-testid="page-nav">Reviews nav</nav>
      <main>
        <DiagramLoadBoundary diagram={diagram} resetKey={1}>
          <Suspense fallback={<div>loading…</div>}>
            <UnreachableLazy />
          </Suspense>
        </DiagramLoadBoundary>
      </main>
      <footer data-testid="page-footer">page footer</footer>
    </div>
  );
}

let chunkAvailable = false;

/** Throws like a cached lazy rejection until `chunkAvailable` flips. */
function ChunkChild() {
  if (!chunkAvailable) throw new TypeError('Failed to fetch dynamically imported module');
  return <div data-testid="renderer-mounted">renderer mounted</div>;
}

beforeEach(() => {
  // React logs boundary-caught errors to console.error — expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagramLoadBoundary (lazy chunk failure)', () => {
  it('rejected lazy import → fenced mermaid source fallback, page around it does NOT crash', async () => {
    render(<PageWithLazyDiagram />);

    const fallback = await screen.findByTestId('mermaid-fallback');
    expect(fallback).toBeInTheDocument();
    // The fallback shows the mermaid source verbatim (already on the DTO).
    expect(document.querySelector('pre code')?.textContent).toContain('flowchart TD');
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    // The honesty legend still renders from meta.
    expect(screen.getByText(/older than 7 days/)).toBeInTheDocument();
    // Containment: everything OUTSIDE the boundary keeps rendering.
    expect(screen.getByTestId('page-nav')).toBeInTheDocument();
    expect(screen.getByTestId('page-footer')).toBeInTheDocument();
  });

  it('resetKey change clears the cached error — a new mount renders instead of a stale fallback', () => {
    chunkAvailable = false;
    const { rerender } = render(
      <DiagramLoadBoundary diagram={diagram} resetKey={1}>
        <ChunkChild />
      </DiagramLoadBoundary>,
    );
    expect(screen.getByTestId('mermaid-fallback')).toBeInTheDocument();

    // Same conditions under a NEW resetKey (different review) — the cached
    // error must be gone, so the (now healthy) child mounts.
    chunkAvailable = true;
    rerender(
      <DiagramLoadBoundary diagram={diagram} resetKey={2}>
        <ChunkChild />
      </DiagramLoadBoundary>,
    );

    expect(screen.getByTestId('renderer-mounted')).toBeInTheDocument();
    expect(screen.queryByTestId('mermaid-fallback')).not.toBeInTheDocument();
  });
});
