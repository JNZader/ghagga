/**
 * Unit tests for buildGraphFromScip().
 *
 * Loads the real captured `index.scip` fixture (produced by scip-go against
 * a tiny two-file Go module) and asserts that the mapper resolves the
 * cross-file, full-module-path reference that a regex-based extractor
 * cannot: `main.go` calls `pkg.Greet(...)` via `example.com/fixture/pkg`,
 * and the SCIP symbol ID for `Greet()` is identical in both documents'
 * occurrences (definition in `pkg/greeting.go`, reference in `main.go`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import type { Index } from '@scip-code/scip';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
} from '@scip-code/scip';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../schema.js';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/scip-go-sample/index.scip',
);

function loadFixtureIndex(): Index {
  const bytes = readFileSync(FIXTURE_PATH);
  return parseScipIndex(bytes);
}

describe('parseScipIndex', () => {
  it('parses the real scip-go fixture into an Index with 2 documents', () => {
    const index = loadFixtureIndex();
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['main.go', 'pkg/greeting.go']);
  });
});

describe('buildGraphFromScip', () => {
  it('resolves the cross-file Go module-path reference: main.go imports pkg/greeting.go', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['main.go'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.imports).toContain('pkg/greeting.go');
  });

  it('greeting.go exports Greet', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['pkg/greeting.go'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.exports).toContain('Greet');
  });

  it('drops external/stdlib symbol references (fmt) — no edge produced for them', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['main.go'];
    expect(mainNode).toBeDefined();
    // Only the in-repo target is present; nothing named after the stdlib
    // "fmt" package (which has no Definition anywhere in this index) leaks
    // into imports.
    expect(mainNode?.imports).toEqual(['pkg/greeting.go']);
  });

  it('produces a graph that passes v1 validateGraph()', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);
    expect(validateGraph(graph)).not.toBeNull();
  });

  it('sets calls to [] for every node (v1 fidelity — regex baseline parity)', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);
    for (const node of Object.values(graph.nodes)) {
      expect(node.calls).toEqual([]);
    }
  });

  it('marks isTest false for these non-test fixture files', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);
    expect(graph.nodes['main.go']?.isTest).toBe(false);
    expect(graph.nodes['pkg/greeting.go']?.isTest).toBe(false);
  });

  it('derives rootDir from index.metadata.projectRoot', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);
    expect(graph.rootDir).toBe(index.metadata?.projectRoot);
  });

  it('does not crash and drops non-reference relationship kinds (implementation/type-definition) on a synthetic index', () => {
    // Synthetic index: a symbol whose only linkage to another symbol is via
    // a Relationship (is_implementation / is_type_definition), not a plain
    // reference occurrence. The mapper must ignore Relationship-based links
    // entirely (out of v1 scope) rather than crash or fabricate an edge.
    const defOccurrence = create(OccurrenceSchema, {
      symbol: 'scip-go gomod example.com/synth 0000 `example.com/synth`/Base#',
      symbolRoles: 1, // Definition
    });
    const baseSymbolInfo = create(SymbolInformationSchema, {
      symbol: 'scip-go gomod example.com/synth 0000 `example.com/synth`/Base#',
      displayName: 'Base',
      relationships: [
        {
          symbol: 'scip-go gomod example.com/synth 0000 `example.com/synth`/Impl#',
          isImplementation: true,
          isReference: false,
          isTypeDefinition: false,
          isDefinition: false,
        },
      ],
    });

    const doc = create(DocumentSchema, {
      relativePath: 'base.go',
      language: 'go',
      occurrences: [defOccurrence],
      symbols: [baseSymbolInfo],
    });

    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    expect(() => buildGraphFromScip(index)).not.toThrow();
    const graph = buildGraphFromScip(index);
    expect(graph.nodes['base.go']?.imports).toEqual([]);
    expect(validateGraph(graph)).not.toBeNull();
  });
});
