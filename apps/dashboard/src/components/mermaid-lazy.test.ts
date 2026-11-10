/**
 * Mermaid lazy-loading discipline (blast-radius-diagram T4.4).
 *
 * Static-source assertion of the dashboard-ui spec: "the main bundle
 * MUST NOT include the mermaid package (lazy dynamic import only; static
 * import of mermaid anywhere in the entry graph is a spec violation)".
 *
 * Reads the dashboard sources and asserts:
 *   1. any import of the mermaid package — `from 'mermaid'` (static),
 *      bare `import 'mermaid'` (side-effect), `import('mermaid')`
 *      (dynamic), or a deep specifier like `mermaid/dist/…` — appears
 *      ONLY inside `src/components/MermaidDiagram.tsx` (the module that
 *      IS the lazy chunk);
 *   2. `pages/Reviews.tsx` references that module ONLY via
 *      `lazy(() => import(…))` — never a static import.
 *
 * This is the cheap, CI-fast proxy for the optional `vite build` chunk
 * check (separate mermaid chunk, main chunk unchanged) — the bundler
 * cannot hoist a dependency no entry-reachable module imports statically.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..'); // src/ — this test lives in src/components

/** Recursively collect dashboard source files (.ts/.tsx/.js/.jsx, tests excluded). */
function collectSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSources(full));
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    files.push(full);
  }
  return files;
}

describe('mermaid lazy-loading discipline (dashboard-ui spec)', () => {
  const sources = collectSources(SRC_DIR);

  it('scans a non-empty dashboard source tree', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('mermaid is statically imported ONLY by components/MermaidDiagram.tsx', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, 'utf-8');
      // Any import form resolving to the mermaid package: static
      // `… from 'mermaid'`, bare side-effect `import 'mermaid'`, dynamic
      // `import('mermaid')`, and deep specifiers (`'mermaid/dist/…'`) —
      // all bundle the package into whatever chunk statically reaches them.
      const importsMermaid =
        /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]mermaid(?:\/[^'"]*)?['"]/.test(content);
      if (!importsMermaid) continue;
      if (file.endsWith(join('components', 'MermaidDiagram.tsx'))) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // And the one allowed module really does import it (that static import
    // is what isolates mermaid into the lazy chunk — design D4).
    const renderer = readFileSync(join(SRC_DIR, 'components', 'MermaidDiagram.tsx'), 'utf-8');
    expect(renderer).toMatch(/import\s+mermaid\s+from\s+['"]mermaid['"]/);
  });

  it('Reviews.tsx references MermaidDiagram ONLY through the lazy boundary', () => {
    const reviews = readFileSync(join(SRC_DIR, 'pages', 'Reviews.tsx'), 'utf-8');
    // The lazy boundary exists...
    expect(reviews).toMatch(
      /const MermaidDiagram = lazy\(\(\) => import\('@\/components\/MermaidDiagram'\)\)/,
    );
    // ...and no static import of the module sneaks in.
    expect(reviews).not.toMatch(
      /import\s*(?:\{[^}]*\}|MermaidDiagram|type\s+\w+)[^']*from\s*['"]@\/components\/MermaidDiagram['"]/,
    );
  });

  it('no other source even mentions the MermaidDiagram module (single consumer)', () => {
    for (const file of sources) {
      if (file.endsWith(join('pages', 'Reviews.tsx'))) continue;
      if (file.endsWith(join('components', 'MermaidDiagram.tsx'))) continue;
      expect(
        readFileSync(file, 'utf-8'),
        `${file} must not reference MermaidDiagram`,
      ).not.toContain('MermaidDiagram');
    }
  });

  it('the fixtures this suite relies on exist (guard against tree moves)', () => {
    expect(existsSync(join(SRC_DIR, 'components', 'MermaidDiagram.tsx'))).toBe(true);
    expect(existsSync(join(SRC_DIR, 'pages', 'Reviews.tsx'))).toBe(true);
  });
});
