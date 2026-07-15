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
import type { Index, Occurrence } from '@scip-code/scip';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
} from '@scip-code/scip';
import { describe, expect, it, vi } from 'vitest';
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

  it('populates importSymbols on main.go for the resolved reference to pkg/greeting.go — imports unaffected', () => {
    const index = loadFixtureIndex();
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['main.go'];
    expect(mainNode?.imports).toEqual(['pkg/greeting.go']);
    expect(mainNode?.importSymbols?.['pkg/greeting.go']).toBeDefined();
    expect(mainNode?.importSymbols?.['pkg/greeting.go']).toEqual(expect.arrayContaining(['Greet']));
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

describe('buildGraphFromScip — importSymbols dedup (Slice 1b, 3vr regression guard)', () => {
  it('keeps two distinct symbols with the SAME displayName as two separate importSymbols entries (dedup by occ.symbol identity, not displayName)', () => {
    // Two distinct symbol ids in `target.go`, both named "Run" (e.g. two
    // overloaded/differently-scoped `Run` — a realistic same-displayName
    // collision). `caller.go` references BOTH. Deduping by displayName
    // (the abandoned calls[] branch's bug) would collapse this to one
    // entry; deduping by occ.symbol identity must keep both.
    const symbolA = 'scip-go gomod example.com/synth 0000 `example.com/synth/target`/Run#A.';
    const symbolB = 'scip-go gomod example.com/synth 0000 `example.com/synth/target`/Run#B.';

    const targetDoc = create(DocumentSchema, {
      relativePath: 'target.go',
      language: 'go',
      symbols: [
        create(SymbolInformationSchema, { symbol: symbolA, displayName: 'Run' }),
        create(SymbolInformationSchema, { symbol: symbolB, displayName: 'Run' }),
      ],
      occurrences: [
        create(OccurrenceSchema, { symbol: symbolA, symbolRoles: 1 }), // Definition
        create(OccurrenceSchema, { symbol: symbolB, symbolRoles: 1 }), // Definition
      ],
    });

    const callerDoc = create(DocumentSchema, {
      relativePath: 'caller.go',
      language: 'go',
      symbols: [],
      occurrences: [
        create(OccurrenceSchema, { symbol: symbolA, symbolRoles: 0 }), // reference
        create(OccurrenceSchema, { symbol: symbolB, symbolRoles: 0 }), // reference
      ],
    });

    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [targetDoc, callerDoc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    const callerNode = graph.nodes['caller.go'];

    expect(callerNode?.imports).toEqual(['target.go']);
    // imports:string[] stays a single entry (unaffected) — importSymbols
    // carries BOTH distinct "Run" entries.
    expect(callerNode?.importSymbols?.['target.go']).toHaveLength(2);
    expect(callerNode?.importSymbols?.['target.go']).toEqual(['Run', 'Run']);
    expect(validateGraph(graph)).not.toBeNull();
  });

  it('omits importSymbols when a document has no reference occurrences (omit-empty)', () => {
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [
        create(DocumentSchema, { relativePath: 'lonely.go', language: 'go', symbols: [] }),
      ],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(graph.nodes['lonely.go']?.importSymbols).toBeUndefined();
  });
});

describe('buildGraphFromScip — onUnmappedDoc callback (D5)', () => {
  function docWithLanguage(relativePath: string, language: string) {
    return create(DocumentSchema, { relativePath, language, symbols: [], occurrences: [] });
  }

  it('fires onUnmappedDoc for a document whose language cannot be mapped, and drops it', () => {
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [
        docWithLanguage('main.go', 'go'),
        docWithLanguage('unknown.xyz', 'some-unknown-scip-language'),
      ],
      externalSymbols: [],
    });

    const onUnmappedDoc = vi.fn();
    const graph = buildGraphFromScip(index, { onUnmappedDoc });

    expect(graph.nodes['main.go']).toBeDefined();
    expect(graph.nodes['unknown.xyz']).toBeUndefined();
    expect(onUnmappedDoc).toHaveBeenCalledTimes(1);
    expect(onUnmappedDoc).toHaveBeenCalledWith('unknown.xyz', 'some-unknown-scip-language');
  });

  it('does not throw when onUnmappedDoc is omitted — core stays console-free by default', () => {
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [docWithLanguage('unknown.xyz', 'some-unknown-scip-language')],
      externalSymbols: [],
    });

    expect(() => buildGraphFromScip(index)).not.toThrow();
    const graph = buildGraphFromScip(index);
    expect(graph.nodes['unknown.xyz']).toBeUndefined();
  });

  it('maps kotlin/csharp/php SCIP documents to graph nodes (union coverage, D3)', () => {
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [
        docWithLanguage('Main.kt', 'kotlin'),
        docWithLanguage('Program.cs', 'csharp'),
        docWithLanguage('index.php', 'php'),
      ],
      externalSymbols: [],
    });

    const onUnmappedDoc = vi.fn();
    const graph = buildGraphFromScip(index, { onUnmappedDoc });

    expect(graph.nodes['Main.kt']?.language).toBe('kotlin');
    expect(graph.nodes['Program.cs']?.language).toBe('csharp');
    expect(graph.nodes['index.php']?.language).toBe('php');
    expect(onUnmappedDoc).not.toHaveBeenCalled();
  });
});

// ─── symbolRanges capture (scip-symbol-ranges D1/D2/D6) ────────────

describe('buildGraphFromScip — symbolRanges capture', () => {
  function defOccurrence(
    symbol: string,
    extra: {
      enclosingRange?: number[];
      typedEnclosingRange?: Occurrence['typedEnclosingRange'];
    } = {},
  ) {
    return create(OccurrenceSchema, { symbol, symbolRoles: 1, ...extra });
  }

  it('captures a range from flat enclosingRange (go/ts/rust form) and converts 0-based-exclusive → 1-based-inclusive', () => {
    const symbol = 'scip-ts npm pkg 0000 `mod`/Foo#';
    const doc = create(DocumentSchema, {
      relativePath: 'foo.ts',
      language: 'typescript',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Foo' })],
      // SCIP 0-based, end-EXCLUSIVE: startLine=3, endLine=6, endChar=0.
      occurrences: [defOccurrence(symbol, { enclosingRange: [3, 0, 6, 0] })],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    // D6: start1 = 3+1 = 4; endChar===0 → end1 = 6 (not 7).
    expect(graph.nodes['foo.ts']?.symbolRanges).toEqual({ Foo: [4, 6] });
  });

  it('BOUNDARY (LANDMINE 1.7): endChar > 0 shifts end1 by exactly one line vs endChar === 0 — proves the off-by-one conversion is exact', () => {
    const symbolZero = 'scip-ts npm pkg 0000 `mod`/ZeroEnd#';
    const symbolNonZero = 'scip-ts npm pkg 0000 `mod`/NonZeroEnd#';
    const doc = create(DocumentSchema, {
      relativePath: 'boundary.ts',
      language: 'typescript',
      symbols: [
        create(SymbolInformationSchema, { symbol: symbolZero, displayName: 'ZeroEnd' }),
        create(SymbolInformationSchema, { symbol: symbolNonZero, displayName: 'NonZeroEnd' }),
      ],
      occurrences: [
        // endChar === 0 → last in-range line is scipEndLine itself.
        defOccurrence(symbolZero, { enclosingRange: [3, 0, 6, 0] }),
        // endChar > 0 → last in-range line is scipEndLine + 1.
        defOccurrence(symbolNonZero, { enclosingRange: [3, 0, 6, 10] }),
      ],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(graph.nodes['boundary.ts']?.symbolRanges).toEqual({
      ZeroEnd: [4, 6],
      NonZeroEnd: [4, 7],
    });
  });

  it('captures a range from typedEnclosingRange multiLineEnclosingRange (java form)', () => {
    const symbol = 'scip-java maven g:a:1.0 `mod`/Bar#';
    const doc = create(DocumentSchema, {
      relativePath: 'Bar.java',
      language: 'java',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Bar' })],
      occurrences: [
        defOccurrence(symbol, {
          typedEnclosingRange: {
            case: 'multiLineEnclosingRange',
            value: { startLine: 1, startCharacter: 0, endLine: 4, endCharacter: 0 },
          },
        }),
      ],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(graph.nodes['Bar.java']?.symbolRanges).toEqual({ Bar: [2, 4] });
  });

  it('captures a range from typedEnclosingRange singleLineEnclosingRange', () => {
    const symbol = 'scip-java maven g:a:1.0 `mod`/Baz#';
    const doc = create(DocumentSchema, {
      relativePath: 'Baz.java',
      language: 'java',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Baz' })],
      occurrences: [
        defOccurrence(symbol, {
          typedEnclosingRange: {
            case: 'singleLineEnclosingRange',
            value: { line: 9, startCharacter: 0, endCharacter: 20 },
          },
        }),
      ],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    // Single-line: startLine === endLine === 9 (0-based); endChar=20 > 0 → end1 = 10.
    expect(graph.nodes['Baz.java']?.symbolRanges).toEqual({ Baz: [10, 10] });
  });

  it('prefers typedEnclosingRange over the deprecated flat enclosingRange when BOTH are set (SCIP proto precedence)', () => {
    const symbol = 'scip-java maven g:a:1.0 `mod`/Both#';
    const doc = create(DocumentSchema, {
      relativePath: 'Both.java',
      language: 'java',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Both' })],
      occurrences: [
        defOccurrence(symbol, {
          // Deprecated flat form: would resolve to [4, 6] if read.
          enclosingRange: [3, 0, 6, 0],
          // Newer typed form: MUST win — resolves to [21, 23].
          typedEnclosingRange: {
            case: 'multiLineEnclosingRange',
            value: { startLine: 20, startCharacter: 0, endLine: 23, endCharacter: 0 },
          },
        }),
      ],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(graph.nodes['Both.java']?.symbolRanges).toEqual({ Both: [21, 23] });
  });

  it('omits symbolRanges when NEITHER enclosingRange nor typedEnclosingRange is present (never fabricated)', () => {
    const symbol = 'scip-csharp nuget pkg 1.0 `mod`/Qux#';
    const doc = create(DocumentSchema, {
      relativePath: 'Qux.cs',
      language: 'csharp',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Qux' })],
      occurrences: [defOccurrence(symbol)],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(graph.nodes['Qux.cs']?.symbolRanges).toBeUndefined();
  });

  it('unions the min-start..max-end range on displayName collision (overloads)', () => {
    const symbolA = 'scip-ts npm pkg 0000 `mod`/Run#A.';
    const symbolB = 'scip-ts npm pkg 0000 `mod`/Run#B.';
    const doc = create(DocumentSchema, {
      relativePath: 'overload.ts',
      language: 'typescript',
      symbols: [
        create(SymbolInformationSchema, { symbol: symbolA, displayName: 'Run' }),
        create(SymbolInformationSchema, { symbol: symbolB, displayName: 'Run' }),
      ],
      occurrences: [
        defOccurrence(symbolA, { enclosingRange: [1, 0, 3, 0] }), // → [2, 3]
        defOccurrence(symbolB, { enclosingRange: [10, 0, 15, 0] }), // → [11, 15]
      ],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    // Union of the two disjoint ranges: min(2,11)..max(3,15) = [2, 15].
    expect(graph.nodes['overload.ts']?.symbolRanges).toEqual({ Run: [2, 15] });
  });

  it('produces a graph WITH symbolRanges that still passes v1 validateGraph()', () => {
    const symbol = 'scip-ts npm pkg 0000 `mod`/Foo#';
    const doc = create(DocumentSchema, {
      relativePath: 'foo.ts',
      language: 'typescript',
      symbols: [create(SymbolInformationSchema, { symbol, displayName: 'Foo' })],
      occurrences: [defOccurrence(symbol, { enclosingRange: [3, 0, 6, 0] })],
    });
    const index = create(IndexSchema, {
      metadata: { projectRoot: 'file:///synthetic' },
      documents: [doc],
      externalSymbols: [],
    });

    const graph = buildGraphFromScip(index);
    expect(validateGraph(graph)).not.toBeNull();
  });
});
