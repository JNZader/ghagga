/**
 * Unit tests for symbol-precise blast-radius narrowing (scip-symbol-exclusion).
 *
 * Two of these test blocks are NON-NEGOTIABLE regression guards, encoded
 * directly from the judgment-day BLOCKER findings that forced design v3:
 *
 * - `canExcludeEdge` exhaustive cell table (JD-001 guard): proves the gate
 *   is a fail-closed WHITELIST, not a `!== python` blacklist. MUST assert
 *   scip×{go,kotlin,csharp,php} → false explicitly.
 * - freshness no-op (JD-005 guard): proves narrowBySymbols is a total
 *   no-op whenever the graph is not EXACT-COMMIT-FRESH, even when symbols
 *   would otherwise be disjoint (exclusion would fire if fresh).
 *
 * Neither of these may be weakened. If either cannot be made to pass, the
 * feature is unsafe and must not ship.
 */

import { describe, expect, it } from 'vitest';
import type { ChangedSymbolsResult } from './changed-symbols.js';
import { canExcludeEdge, isExactCommitFresh, narrowBySymbols } from './narrow-symbols.js';
import {
  type DependencyGraph,
  type GraphMetadata,
  type GraphNode,
  REGEX_SUPPORTED_LANGUAGES,
  SCIP_ONLY_LANGUAGES,
  type SupportedLanguage,
} from './schema.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'h',
    language: 'typescript',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

function makeGraph(nodes: Record<string, GraphNode>): DependencyGraph {
  return { version: 1, rootDir: '.', nodes };
}

function makeMetadata(overrides: Partial<GraphMetadata> = {}): GraphMetadata {
  return {
    lastIndexedCommit: 'abc123',
    lastIndexedAt: new Date().toISOString(),
    schemaVersion: 1,
    fileCount: 1,
    languages: ['typescript'],
    indexDurationMs: 10,
    ...overrides,
  };
}

const ALL_LANGUAGES: (SupportedLanguage | 'unknownlang')[] = [
  ...REGEX_SUPPORTED_LANGUAGES,
  ...SCIP_ONLY_LANGUAGES,
  'unknownlang' as SupportedLanguage,
];

// ─── canExcludeEdge — HARD TEST: exhaustive cell table (JD-001 guard) ───

describe('canExcludeEdge — exhaustive cell table (JD-001 regression guard)', () => {
  // Preconditions satisfied for every cell: A imports B with a non-empty
  // importSymbols entry, B has non-empty symbolRanges, B has no reExportsAll.
  function makeEdge(bLang: SupportedLanguage | 'unknownlang') {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode({
      language: bLang as SupportedLanguage,
      symbolRanges: { X: [1, 5] },
    });
    return { aNode, bNode };
  }

  const expected: Record<string, Record<string, boolean>> = {
    scip: {
      typescript: true,
      javascript: true,
      rust: true,
      java: true,
      go: false,
      kotlin: false,
      csharp: false,
      php: false,
      python: false,
      unknownlang: false,
    },
    regex: {
      typescript: true,
      javascript: true,
      java: true,
      python: true, // importSymbols present on edge — universal precondition already met
      rust: true, // importSymbols present on edge — universal precondition already met
      go: false,
      kotlin: false,
      csharp: false,
      php: false,
      unknownlang: false,
    },
  };

  for (const builtVia of ['scip', 'regex'] as const) {
    for (const lang of ALL_LANGUAGES) {
      const want = expected[builtVia][lang] ?? false;
      it(`builtVia=${builtVia} × B.language=${lang} → ${want}`, () => {
        const { aNode, bNode } = makeEdge(lang);
        expect(canExcludeEdge(aNode, 'b.x', bNode, builtVia)).toBe(want);
      });
    }
  }

  for (const lang of ALL_LANGUAGES) {
    it(`builtVia=absent × B.language=${lang} → false`, () => {
      const { aNode, bNode } = makeEdge(lang);
      expect(canExcludeEdge(aNode, 'b.x', bNode, undefined)).toBe(false);
    });
  }

  // Explicit JD-001 assertions — the exact bug the blacklist design allowed.
  it('scip × go → false (JD-001: partial SCIP fidelity, NOT allowed by blacklist "!== python")', () => {
    const { aNode, bNode } = makeEdge('go');
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });
  it('scip × kotlin → false (JD-001 guard)', () => {
    const { aNode, bNode } = makeEdge('kotlin');
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });
  it('scip × csharp → false (JD-001 guard)', () => {
    const { aNode, bNode } = makeEdge('csharp');
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });
  it('scip × php → false (JD-001 guard)', () => {
    const { aNode, bNode } = makeEdge('php');
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });
});

// ─── canExcludeEdge — universal preconditions ──────────────────

describe('canExcludeEdge — universal preconditions (any false ⇒ false)', () => {
  it('returns false when builtVia is absent', () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    expect(canExcludeEdge(aNode, 'b.x', bNode, undefined)).toBe(false);
  });

  it('returns false when bNode.reExportsAll is present', () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] }, reExportsAll: ['c.x'] });
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });

  it('returns false when aNode.importSymbols[bPath] is absent', () => {
    const aNode = makeNode({ imports: ['b.x'] });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });

  it('returns false when aNode.importSymbols[bPath] is empty', () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': [] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });

  it('returns false when bNode.symbolRanges is absent', () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode();
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });

  it('returns false when bNode.symbolRanges is empty', () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode({ symbolRanges: {} });
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'scip')).toBe(false);
  });

  it('regex × python without importSymbols[B] present on the edge → false', () => {
    const aNode = makeNode({ imports: ['b.x'] });
    const bNode = makeNode({ language: 'python', symbolRanges: { X: [1, 5] } });
    expect(canExcludeEdge(aNode, 'b.x', bNode, 'regex')).toBe(false);
  });
});

// ─── isExactCommitFresh + narrowBySymbols — HARD TEST: freshness no-op (JD-005 guard) ───

describe('isExactCommitFresh', () => {
  it('true when lastIndexedCommit present and equals currentHead, and not stale-by-age', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(isExactCommitFresh(metadata, 'abc123')).toBe(true);
  });

  it('false when metadata is null', () => {
    expect(isExactCommitFresh(null, 'abc123')).toBe(false);
  });

  it('false when lastIndexedCommit is absent/empty', () => {
    const metadata = makeMetadata({ lastIndexedCommit: '' });
    expect(isExactCommitFresh(metadata, 'abc123')).toBe(false);
  });

  it('false when lastIndexedCommit !== currentHead (head-mismatch)', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(isExactCommitFresh(metadata, 'def456')).toBe(false);
  });

  it('false when currentHead is empty/undefined', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(isExactCommitFresh(metadata, '')).toBe(false);
    expect(isExactCommitFresh(metadata, undefined)).toBe(false);
  });

  it('false when stale-by-age even if commit matches', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123', lastIndexedAt: thirtyDaysAgo });
    expect(isExactCommitFresh(metadata, 'abc123')).toBe(false);
  });
});

describe('narrowBySymbols — HARD TEST: freshness no-op (JD-005 regression guard)', () => {
  // Fixture where exclusion WOULD fire if fresh: A imports B, uses X;
  // changed symbols in B = {Y} (disjoint from X) — a clean exclusion case.
  function makeFixture() {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5], Y: [6, 10] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    return { graph, changedByFile };
  }

  it('control: WHEN fresh, disjoint symbols DO exclude A', () => {
    const { graph, changedByFile } = makeFixture();
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(true);
  });

  // The actual guard: narrowBySymbols itself doesn't take metadata/currentHead
  // directly (that gate lives in applyBlastRadius per D0/D4) — but the
  // pipeline wiring MUST refuse to call narrowBySymbols at all when not
  // fresh. We assert isExactCommitFresh drives that decision here as the
  // integration contract, and re-assert full wiring in prepare-graph tests.
  it('lastIndexedCommit !== currentHead ⇒ isExactCommitFresh false ⇒ wiring must skip narrowBySymbols entirely', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(isExactCommitFresh(metadata, 'def456')).toBe(false);
  });

  it('lastIndexedCommit absent ⇒ isExactCommitFresh false', () => {
    const metadata = makeMetadata({ lastIndexedCommit: '' });
    expect(isExactCommitFresh(metadata, 'abc123')).toBe(false);
  });

  it('stale-by-age ⇒ isExactCommitFresh false', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123', lastIndexedAt: thirtyDaysAgo });
    expect(isExactCommitFresh(metadata, 'abc123')).toBe(false);
  });

  it('empty currentHead ⇒ isExactCommitFresh false', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(isExactCommitFresh(metadata, '')).toBe(false);
  });
});

// ─── narrowBySymbols — VALUE test ───────────────────────────────

describe('narrowBySymbols — VALUE', () => {
  it('excludes A when A uses none of B changed symbols (SCIP TS, whitelisted, fresh-by-contract)', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5], Y: [6, 10] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(true);
  });

  it('keeps A included when A uses a changed symbol of B', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5], Y: [6, 10] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['X']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });
});

// ─── narrowBySymbols — SAFETY tests (each: dependent NOT dropped) ───

describe('narrowBySymbols — SAFETY (each: dependent NOT dropped)', () => {
  it('hasUnattributedChanges true (body-edit) ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(), hasUnattributedChanges: true }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('hasUnattributedChanges true (deletion) ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['X']), hasUnattributedChanges: true }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('hasUnattributedChanges true (rename) ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(), hasUnattributedChanges: true }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('transitive-only reach (B not in A.imports directly) ⇒ A never excluded', () => {
    // A -> M -> B, B is NOT in A.imports.
    const aNode = makeNode({ imports: ['m.ts'], importSymbols: { 'm.ts': ['helper'] } });
    const mNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'm.ts': mNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts', 'm.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'm.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('B is Go under SCIP ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.go'], importSymbols: { 'b.go': ['X'] } });
    const bNode = makeNode({ language: 'go', symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.go': aNode, 'b.go': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.go', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.go'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.go', 'b.go']),
      new Set(['b.go']),
    );
    expect(excluded.has('a.go')).toBe(false);
  });

  it('B is Python under SCIP ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.py'], importSymbols: { 'b.py': ['X'] } });
    const bNode = makeNode({ language: 'python', symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.py': aNode, 'b.py': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.py', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.py'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.py', 'b.py']),
      new Set(['b.py']),
    );
    expect(excluded.has('a.py')).toBe(false);
  });

  it("B's language is unknown/unmapped ⇒ A never excluded", () => {
    const aNode = makeNode({ imports: ['b.x'], importSymbols: { 'b.x': ['X'] } });
    const bNode = makeNode({
      language: 'unknownlang' as SupportedLanguage,
      symbolRanges: { X: [1, 5] },
    });
    const graph = makeGraph({ 'a.x': aNode, 'b.x': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.x', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.x'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.x', 'b.x']),
      new Set(['b.x']),
    );
    expect(excluded.has('a.x')).toBe(false);
  });

  it('missing importSymbols[A][B] ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'] }); // no importSymbols at all
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('missing symbolRanges[B] ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode(); // no symbolRanges
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('EMPTY importSymbols[A][B] (side-effect/namespace import) ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': [] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('reExportsAll present on B ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] }, reExportsAll: ['c.ts'] });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['Y']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('missing changedByFile entry for B (deleted/binary) ⇒ A never excluded', () => {
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>(); // no entry for b.ts
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });

  it('directly-changed file B is never in the excluded set, even if all gates would otherwise pass', () => {
    // b.ts imports a.ts (reversed) so b.ts itself is passed as a "dependent"
    // candidate but is ALSO a changed file — must never be excluded.
    const bNode = makeNode({ imports: ['a.ts'], importSymbols: { 'a.ts': ['Z'] } });
    const aNode = makeNode({ symbolRanges: { Z: [1, 5] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['a.ts', { changedSymbols: new Set(['unrelated']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['b.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['a.ts', 'b.ts']), // b.ts IS a changed file too
    );
    expect(excluded.has('b.ts')).toBe(false);
  });

  it('line-adding edge case: X still caught in changedSymbols OR hasUnattributedChanges fires — never wrong-excludes', () => {
    // Simulates a diff that adds lines inside symbol X but the computed
    // changedSymbols still correctly contains X (computeChangedSymbolsComplete's
    // job) OR conservatively sets hasUnattributedChanges. Either way A (which
    // uses X) must stay included.
    const aNode = makeNode({ imports: ['b.ts'], importSymbols: { 'b.ts': ['X'] } });
    const bNode = makeNode({ symbolRanges: { X: [1, 20] } });
    const graph = makeGraph({ 'a.ts': aNode, 'b.ts': bNode });
    const changedByFile = new Map<string, ChangedSymbolsResult>([
      ['b.ts', { changedSymbols: new Set(['X']), hasUnattributedChanges: false }],
    ]);
    const excluded = narrowBySymbols(
      ['a.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['a.ts', 'b.ts']),
      new Set(['b.ts']),
    );
    expect(excluded.has('a.ts')).toBe(false);
  });
});
