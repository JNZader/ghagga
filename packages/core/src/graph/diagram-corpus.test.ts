/**
 * Blast-radius diagram golden corpus (blast-radius-diagram T2.4).
 *
 * Fixture cases under `test/fixtures/blast-radius-diagram/<case>/`
 * (mirroring the graph-context corpus precedent):
 *
 *   empty                 — no changed files → no diagram (null)
 *   single-file           — one changed file, no edges
 *   hub-and-spoke         — changed hub + importers + importees
 *   cycle                 — a→b→c→a import cycle (BFS terminates)
 *   exceeded-cap          — 51-file radius → counts-only, NO diagram
 *   stale                 — graphStale=true → meta.stale
 *   unicode-paths         — non-ASCII paths → allowlist-sanitized labels
 *   injection-corpus      — hostile file names (quotes/`-->`/HTML/newline)
 *   50-file-cap-boundary  — exactly-at-cap radius → 25-node truncated diagram
 *
 * Each case: `graph.json` (DependencyGraph), `changed.json`
 * ({ changed: string[], graphStale: boolean }), `expected-diagram.json`
 * (nodes/edges/meta shape, `null` when no diagram), `expected-mermaid.txt`
 * (byte-exact mermaid source, empty when no diagram).
 *
 * The corpus asserts the diagram SHAPE and mermaid BYTES, and runs the
 * builder TWICE per case asserting byte-identical output (explicit sort
 * order, generated stable ids, no `Set` iteration in output).
 *
 * Fixture maintenance: run with GHAGGA_REGEN_BLAST_RADIUS_CORPUS=1 to
 * (re)write the expected files, then review the diff like any golden.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBlastRadius } from './blast-radius.js';
import { buildBlastRadiusDiagramSummary } from './diagram-summary.js';
import type { BlastRadiusDiagram, DependencyGraph } from './schema.js';
import { GRAPH_VERSION, MAX_BLAST_RADIUS_FILES } from './schema.js';

const CORPUS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'blast-radius-diagram',
);

const REGEN = process.env.GHAGGA_REGEN_BLAST_RADIUS_CORPUS === '1';

interface ChangedFile {
  changed: string[];
  graphStale: boolean;
}

interface CorpusCase {
  name: string;
  graph: DependencyGraph;
  changed: string[];
  graphStale: boolean;
}

// Loaded at MODULE level (not beforeAll): the it.each blocks below
// enumerate their case lists at collection time, so `cases` must be
// populated before the suite body runs (same as the graph-context corpus).
const cases: CorpusCase[] = readdirSync(CORPUS_DIR)
  .sort()
  .filter((name) => existsSync(join(CORPUS_DIR, name, 'graph.json')))
  .map((name) => {
    const caseDir = join(CORPUS_DIR, name);
    const graph = JSON.parse(readFileSync(join(caseDir, 'graph.json'), 'utf-8')) as DependencyGraph;
    const changedFile = JSON.parse(
      readFileSync(join(caseDir, 'changed.json'), 'utf-8'),
    ) as ChangedFile;
    return {
      name,
      graph,
      changed: changedFile.changed,
      graphStale: changedFile.graphStale ?? false,
    };
  });

function assemble(corpus: CorpusCase): BlastRadiusDiagram | undefined {
  const result = computeBlastRadius(corpus.graph, corpus.changed, {
    maxFiles: MAX_BLAST_RADIUS_FILES,
  });
  return buildBlastRadiusDiagramSummary(corpus.graph, result, corpus.graphStale);
}

describe('blast-radius diagram golden corpus', () => {
  it('covers all nine designed cases', () => {
    expect(cases.map((c) => c.name)).toEqual([
      '50-file-cap-boundary',
      'cycle',
      'empty',
      'exceeded-cap',
      'hub-and-spoke',
      'injection-corpus',
      'single-file',
      'stale',
      'unicode-paths',
    ]);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s — shape + mermaid bytes', (_name, corpus) => {
    const caseDir = join(CORPUS_DIR, corpus.name);
    const diagram = assemble(corpus);

    const expectedDiagramPath = join(caseDir, 'expected-diagram.json');
    const expectedMermaidPath = join(caseDir, 'expected-mermaid.txt');

    if (REGEN) {
      writeFileSync(
        expectedDiagramPath,
        diagram === undefined ? 'null\n' : `${JSON.stringify(diagram, null, 2)}\n`,
      );
      writeFileSync(expectedMermaidPath, diagram?.mermaid ?? '');
    }

    const expectedDiagram = JSON.parse(
      readFileSync(expectedDiagramPath, 'utf-8'),
    ) as BlastRadiusDiagram | null;
    const expectedMermaid = readFileSync(expectedMermaidPath, 'utf-8');

    if (expectedDiagram === null) {
      expect(diagram).toBeUndefined();
      expect(expectedMermaid).toBe('');
      return;
    }

    expect(diagram).toBeDefined();
    expect(diagram!.nodes).toEqual(expectedDiagram.nodes);
    expect(diagram!.edges).toEqual(expectedDiagram.edges);
    expect(diagram!.meta).toEqual(expectedDiagram.meta);
    // Byte-exact mermaid — no snapshot repair, exact string equality.
    expect(diagram!.mermaid).toBe(expectedMermaid);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s — byte-identical across two runs (determinism)',
    (_name, corpus) => {
      const first = assemble(corpus);
      const second = assemble(corpus);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    },
  );

  it('injection-corpus — no hostile byte reaches the mermaid output', () => {
    const corpus = cases.find((c) => c.name === 'injection-corpus');
    expect(corpus).toBeDefined();
    const mermaid = assemble(corpus!)!.mermaid;
    const labelLines = mermaid.split('\n').filter((l) => /^ {4}n\d+\["/.test(l));
    expect(labelLines.length).toBeGreaterThan(0);
    // Every label line is exactly `    n<id>["<allowlisted label>"]` —
    // quotes cannot be escaped, no `-->`, no HTML, no newline inside.
    for (const line of labelLines) {
      expect(line).toMatch(/^ {4}n\d+\["[A-Za-z0-9._/+ -…]*"\]$/);
    }
    // No HTML angle bracket anywhere in the output (classDefs/edges/ids
    // never legitimately contain one).
    expect(mermaid).not.toContain('<');
    // No injected heading: allowlisted labels cannot carry `#`, and the
    // only legitimate `#`s are hex colors in classDef lines — so no LINE
    // may start with `#`.
    expect(mermaid.split('\n').some((l) => l.startsWith('#'))).toBe(false);
  });

  it('exceeded-cap — no diagram (spec oversize fallback)', () => {
    const corpus = cases.find((c) => c.name === 'exceeded-cap');
    expect(corpus).toBeDefined();
    expect(assemble(corpus!)).toBeUndefined();
  });
});

// Guard: the corpus graph version stays pinned so a GRAPH_VERSION bump
// forces a corpus regeneration instead of silently drifting.
it('corpus graphs use the current GRAPH_VERSION', () => {
  for (const corpus of cases) {
    expect(corpus.graph.version).toBe(GRAPH_VERSION);
  }
});
