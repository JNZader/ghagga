/**
 * Tests for rankNeighborhoods — the pure lexical+structural ranker over
 * collected file neighborhoods (context-hybrid-ranking Slice 1).
 *
 * Table-driven against the EXACT formula (design §Score Formula):
 *
 *   score = 3·|pathTokens ∩ diffTokens|      // w1: path segments
 *         + 5·|symPool ∩ diffTokens|         // w2: changedSyms ∪ exports
 *         + 2·|impSymTokens ∩ diffTokens|    // w3: graph importSymbols
 *         + (importers.length >= 10 ? 1 : 0) // hub bonus
 *
 * Every row's expected order is derived from HAND-COMPUTED scores in the
 * row comments, with a discriminator element whose score sits between the
 * row's with/without or correct/incorrect variants — a wrong weight or a
 * set-vs-bag bug flips the asserted order, not just a number.
 */

import { describe, expect, it } from 'vitest';
import { rankNeighborhoods } from './neighborhood-rank.js';
import type { FileNeighborhood } from './neighbors.js';
import type { DependencyGraph, GraphNode } from './schema.js';

// ─── Fixture helpers ────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'hash',
    language: 'typescript',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

function makeGraph(nodes: Record<string, GraphNode>): DependencyGraph {
  return { version: 1, rootDir: '/repo', nodes };
}

function makeNeighborhood(overrides: Partial<FileNeighborhood> = {}): FileNeighborhood {
  return {
    file: 'src/a.ts',
    importers: [],
    importees: [],
    exportedSymbols: [],
    isTest: false,
    truncated: false,
    ...overrides,
  };
}

const files = (hoods: FileNeighborhood[]) => hoods.map((n) => n.file);

// ─── Tests ──────────────────────────────────────────────────────

describe('rankNeighborhoods', () => {
  it('returns [] for empty neighborhoods', () => {
    expect(rankNeighborhoods([], 'diff --git', undefined)).toEqual([]);
  });

  it('empty diff text → all scores 0 → input order preserved', () => {
    const a = makeNeighborhood({ file: 'src/a.ts' });
    const b = makeNeighborhood({ file: 'src/b.ts' });
    expect(files(rankNeighborhoods([b, a], '', undefined))).toEqual(['src/b.ts', 'src/a.ts']);
  });

  it.each([
    {
      name: 'echo floor — a changed file path tokens in its own diff header earn the w1 baseline',
      // diff touches src/alpha.ts only:
      //   alpha: w1 = 3·|{src,alpha,ts} ∩ diff| = 9, w2 = 5·|{added,keep}| = 10 → 19
      //   zeta (not in diff): w1 = 3·|{src,ts}| = 6, w2 = 0 (widget absent) → 6
      diff: [
        'diff --git a/src/alpha.ts b/src/alpha.ts',
        '--- a/src/alpha.ts',
        '+++ b/src/alpha.ts',
        '@@ -1,2 +1,3 @@',
        ' const keep = 1',
        '+const added = 2',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/zeta.ts', exportedSymbols: ['widget'] }),
        makeNeighborhood({ file: 'src/alpha.ts', exportedSymbols: ['keep'] }),
      ],
      graph: undefined,
      expected: ['src/alpha.ts', 'src/zeta.ts'],
    },
    {
      name: 'neighbor-path hit counts only when the path appears in a hunk BODY',
      // with the body line: alpha w1 = 3·|{src,alpha,ts,beta}| = 9 > kappa 6
      // header-only diff: alpha w1 = 3·|{src,ts}| = 6 = kappa → kappa first (input order)
      diff: [
        'diff --git a/src/gamma.ts b/src/gamma.ts',
        '--- a/src/gamma.ts',
        '+++ b/src/gamma.ts',
        '@@ -1,1 +1,2 @@',
        '+// see src/beta.ts for details',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/kappa.ts' }),
        makeNeighborhood({ file: 'src/alpha.ts', importers: ['src/beta.ts'] }),
      ],
      graph: undefined,
      expected: ['src/alpha.ts', 'src/kappa.ts'],
    },
    {
      name: 'neighbor-path tokens in header only do NOT score (control for the body row)',
      // same shape minus the body line: alpha = kappa = 6 → input order [kappa, alpha]
      diff: [
        'diff --git a/src/gamma.ts b/src/gamma.ts',
        '--- a/src/gamma.ts',
        '+++ b/src/gamma.ts',
        '@@ -1,1 +1,1 @@',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/kappa.ts' }),
        makeNeighborhood({ file: 'src/alpha.ts', importers: ['src/beta.ts'] }),
      ],
      graph: undefined,
      expected: ['src/kappa.ts', 'src/alpha.ts'],
    },
    {
      name: 'cross-file export mention — A earns w2 from B hunk calling A export (anti-echo)',
      // hero is NOT in the diff at all:
      //   hero:  w1 = 3·|{src,ts,consumer}| = 9, w2 = 5·|{herofn}| = 5 → 14
      //   consumer (the changed file): w1 = 3·|{src,consumer,ts,hero}∩| = 9, w2 = 0 → 9
      diff: [
        'diff --git a/src/consumer.ts b/src/consumer.ts',
        '--- a/src/consumer.ts',
        '+++ b/src/consumer.ts',
        '@@ -1,1 +1,2 @@',
        '+result = heroFn(input)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/consumer.ts', importees: ['src/hero.ts'] }),
        makeNeighborhood({
          file: 'src/hero.ts',
          importers: ['src/consumer.ts'],
          exportedSymbols: ['heroFn'],
        }),
      ],
      graph: undefined,
      expected: ['src/hero.ts', 'src/consumer.ts'],
    },
    {
      name: 'path-space mismatch — file absent from changedSyms falls back to exportedSymbols for w2',
      // same fixture as the anti-echo row: hero has no changedSyms entry (its
      // path never appears in a +++ header) yet its exports still score w2
      diff: [
        'diff --git a/src/consumer.ts b/src/consumer.ts',
        '--- a/src/consumer.ts',
        '+++ b/src/consumer.ts',
        '@@ -1,1 +1,2 @@',
        '+result = heroFn(input)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/consumer.ts' }),
        makeNeighborhood({ file: 'src/hero.ts', exportedSymbols: ['heroFn'] }),
      ],
      graph: undefined,
      expected: ['src/hero.ts', 'src/consumer.ts'],
    },
    {
      name: 'importSymbol overlap scores w3 with the graph (alpha 11 > qm 10)',
      // alpha: w1 = 3·|{src,alpha,ts}| = 9, w3 = 2·|{sharedutil}| = 2 → 11
      // qm.py: w1 = 0 (qm/py absent from diff), w2 = 5·|{m1,m2}| = 10 → 10
      diff: [
        'diff --git a/src/alpha.ts b/src/alpha.ts',
        '--- a/src/alpha.ts',
        '+++ b/src/alpha.ts',
        '@@ -1,2 +1,4 @@',
        '+callSite(sharedUtil)',
        '+m1(m2)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'qm.py', exportedSymbols: ['m1', 'm2'] }),
        makeNeighborhood({ file: 'src/alpha.ts', importees: ['src/dep.ts'] }),
      ],
      graph: makeGraph({
        'src/alpha.ts': makeNode({
          imports: ['src/dep.ts'],
          importSymbols: { 'src/dep.ts': ['sharedUtil'] },
        }),
        'src/dep.ts': makeNode(),
        'qm.py': makeNode({ language: 'python' }),
      }),
      expected: ['src/alpha.ts', 'qm.py'],
    },
    {
      name: 'graph omitted → w3 = 0 while w1 still scores (alpha 9 < qm 10)',
      // identical inputs minus the graph: alpha loses its w3=2, drops to 9
      diff: [
        'diff --git a/src/alpha.ts b/src/alpha.ts',
        '--- a/src/alpha.ts',
        '+++ b/src/alpha.ts',
        '@@ -1,2 +1,4 @@',
        '+callSite(sharedUtil)',
        '+m1(m2)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'qm.py', exportedSymbols: ['m1', 'm2'] }),
        makeNeighborhood({ file: 'src/alpha.ts', importees: ['src/dep.ts'] }),
      ],
      graph: undefined,
      expected: ['qm.py', 'src/alpha.ts'],
    },
    {
      name: 'symbol-sparse node (no importSymbols key) → w3 = 0, same as graph omitted',
      diff: [
        'diff --git a/src/alpha.ts b/src/alpha.ts',
        '--- a/src/alpha.ts',
        '+++ b/src/alpha.ts',
        '@@ -1,2 +1,4 @@',
        '+callSite(sharedUtil)',
        '+m1(m2)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'qm.py', exportedSymbols: ['m1', 'm2'] }),
        makeNeighborhood({ file: 'src/alpha.ts', importees: ['src/dep.ts'] }),
      ],
      graph: makeGraph({
        'src/alpha.ts': makeNode({ imports: ['src/dep.ts'] }), // no importSymbols — Python/Rust shape
        'src/dep.ts': makeNode(),
        'qm.py': makeNode({ language: 'python' }),
      }),
      expected: ['qm.py', 'src/alpha.ts'],
    },
    {
      name: 'hub bonus — 10 importers (+1) breaks an otherwise-exact tie',
      // header-only diff: hub w1 = 3·|{src,ts}| = 6 + 1 = 7; plain w1 = 6
      // importers i1..i10 / p1..p2 add no diff-token hits
      diff: [
        'diff --git a/src/gamma.ts b/src/gamma.ts',
        '--- a/src/gamma.ts',
        '+++ b/src/gamma.ts',
        '@@ -1,1 +1,1 @@',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/plain.ts', importers: ['src/p1.ts', 'src/p2.ts'] }),
        makeNeighborhood({
          file: 'src/hub.ts',
          importers: [
            'src/i1.ts',
            'src/i2.ts',
            'src/i3.ts',
            'src/i4.ts',
            'src/i5.ts',
            'src/i6.ts',
            'src/i7.ts',
            'src/i8.ts',
            'src/i9.ts',
            'src/i10.ts',
          ],
        }),
      ],
      graph: undefined,
      expected: ['src/hub.ts', 'src/plain.ts'],
    },
    {
      name: '9 importers → no hub bonus, tie keeps diff (input) order',
      // same shape one importer short: 6 = 6, plain first in input stays first
      diff: [
        'diff --git a/src/gamma.ts b/src/gamma.ts',
        '--- a/src/gamma.ts',
        '+++ b/src/gamma.ts',
        '@@ -1,1 +1,1 @@',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/plain.ts', importers: ['src/p1.ts', 'src/p2.ts'] }),
        makeNeighborhood({
          file: 'src/hub.ts',
          importers: [
            'src/i1.ts',
            'src/i2.ts',
            'src/i3.ts',
            'src/i4.ts',
            'src/i5.ts',
            'src/i6.ts',
            'src/i7.ts',
            'src/i8.ts',
            'src/i9.ts',
          ],
        }),
      ],
      graph: undefined,
      expected: ['src/plain.ts', 'src/hub.ts'],
    },
    {
      name: 'stability — 3+ equal scores keep input order, not path order',
      // header-only diff for src/gamma.ts: x/y/z each w1 = 3·|{ts}| = 3
      diff: [
        'diff --git a/src/gamma.ts b/src/gamma.ts',
        '--- a/src/gamma.ts',
        '+++ b/src/gamma.ts',
        '@@ -1,1 +1,1 @@',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'z.ts' }),
        makeNeighborhood({ file: 'y.ts' }),
        makeNeighborhood({ file: 'x.ts' }),
      ],
      graph: undefined,
      expected: ['z.ts', 'y.ts', 'x.ts'],
    },
    {
      name: 'unique-token sets — repeated tokens in the diff cannot inflate w2',
      // alpha: w1 = 9, w2 = 5·|{widget}| = 5 (widget repeated 3× in the hunk) → 14
      // mm: w1 = 3·|{src,mm,ts}| = 9, w2 = 5·|{n1,n2}| = 10 → 19
      // if repetition counted, alpha = 9 + 15 = 24 > 19 and the order would flip
      diff: [
        'diff --git a/src/alpha.ts b/src/alpha.ts',
        '--- a/src/alpha.ts',
        '+++ b/src/alpha.ts',
        '@@ -1,1 +1,2 @@',
        '+widget(widget, widget)',
        'diff --git a/src/mm.ts b/src/mm.ts',
        '--- a/src/mm.ts',
        '+++ b/src/mm.ts',
        '@@ -1,1 +1,2 @@',
        '+n1(n2)',
      ].join('\n'),
      hoods: [
        makeNeighborhood({ file: 'src/alpha.ts', exportedSymbols: ['widget'] }),
        makeNeighborhood({ file: 'src/mm.ts', exportedSymbols: ['n1', 'n2'] }),
      ],
      graph: undefined,
      expected: ['src/mm.ts', 'src/alpha.ts'],
    },
  ])('$name', ({ hoods, diff, graph, expected }) => {
    const ranked = rankNeighborhoods(hoods, diff, graph);
    expect(files(ranked)).toEqual(expected);
  });

  it('is pure — returns a new array of the SAME element references without mutating input', () => {
    const a = makeNeighborhood({ file: 'src/a.ts', exportedSymbols: ['widget'] });
    const b = makeNeighborhood({ file: 'src/b.ts' });
    const input = [b, a];
    const inputSnapshot = JSON.stringify(input);

    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      '+widget()',
    ].join('\n');
    const ranked = rankNeighborhoods(input, diff, undefined);

    expect(ranked).not.toBe(input); // new array
    expect(ranked).toHaveLength(input.length);
    expect(ranked).toContain(a); // same references (toContain uses ===)
    expect(ranked).toContain(b);
    expect(input.map((n) => n.file)).toEqual(['src/b.ts', 'src/a.ts']); // order untouched
    expect(JSON.stringify(input)).toBe(inputSnapshot); // no mutation
  });

  it('determinism — repeated runs produce identical output', () => {
    const hoods = [
      makeNeighborhood({ file: 'src/b.ts' }),
      makeNeighborhood({ file: 'src/a.ts', exportedSymbols: ['widget'] }),
    ];
    const diff = '+++ b/src/a.ts\n+widget()';
    const first = files(rankNeighborhoods(hoods, diff, undefined));
    const second = files(rankNeighborhoods(hoods, diff, undefined));
    expect(second).toEqual(first);
  });
});
