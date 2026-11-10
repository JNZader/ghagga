/**
 * Blast-radius mermaid diagram renderer (blast-radius-diagram T4.3).
 *
 * This module STATICALLY imports mermaid — that is exactly what makes the
 * bundler emit it as its own chunk: the ONLY importer of this module is
 * the lazy() boundary in pages/Reviews.tsx, so reviews without diagram
 * data never fetch the ~1 MB renderer (dashboard-ui spec: "No render and
 * no bundle cost when absent"; a static mermaid import anywhere in the
 * entry graph is a spec violation — pinned by mermaid-lazy.test.ts).
 *
 * Renders the diagram from the SINGLE source the review comment uses —
 * the persisted `diagram.mermaid` string (design D1: no second render
 * path, never re-derived from the node lists), plus the honesty legend
 * built from `diagram.meta` booleans/counts only.
 *
 * Failure honesty (dashboard-ui "Render failure falls back to a code
 * block"): mermaid render errors (parse drift, chunk issues, runtime
 * exceptions) NEVER crash or blank the detail view — they degrade to a
 * read-only `<pre><code>` block showing the mermaid source, which is
 * already on the DTO (zero extra data).
 */

import type { BlastRadiusDiagram } from '@ghagga/types';
import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';
import { DiagramLegend } from './DiagramLegend';

/** `mermaid.initialize` runs once per page load, not per mount. */
let mermaidInitialized = false;

export function MermaidDiagram({ diagram }: { diagram: BlastRadiusDiagram }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    if (!mermaidInitialized) {
      mermaid.initialize({ startOnLoad: false });
      mermaidInitialized = true;
    }

    let cancelled = false;
    setRenderFailed(false);

    // Render id must be unique per call; it never reaches the DTO.
    const renderId = `ghagga-blast-radius-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const renderDiagram = async () => {
      try {
        const { svg } = await mermaid.render(renderId, diagram.mermaid);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!cancelled) setRenderFailed(true);
      }
    };

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [diagram.mermaid]);

  if (renderFailed) {
    return (
      <div data-testid="mermaid-fallback">
        <p className="mb-2 text-xs text-text-secondary">
          diagram could not be rendered — showing the mermaid source instead:
        </p>
        <pre className="max-h-64 overflow-auto rounded-md bg-surface p-3 text-xs">
          <code>{diagram.mermaid}</code>
        </pre>
        <DiagramLegend meta={diagram.meta} />
      </div>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        data-testid="mermaid-container"
        className="overflow-x-auto rounded-md bg-surface p-3"
        role="img"
        aria-label="Blast radius diagram"
      />
      <DiagramLegend meta={diagram.meta} />
    </div>
  );
}

export default MermaidDiagram;
