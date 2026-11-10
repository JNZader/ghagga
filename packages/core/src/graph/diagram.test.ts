/**
 * Blast-radius diagram renderer + label sanitizer tests
 * (blast-radius-diagram T1.1).
 *
 * Table-driven over the full D6 injection vector set plus the renderer
 * contracts of D7 (sorting, generated ids, emission order, determinism)
 * and D2 (caps + JSON budget). All offline, model-free, deterministic —
 * assertions are on exact bytes, never on snapshot repair.
 */

import { describe, expect, it } from 'vitest';
import {
  assertDiagramJsonBudget,
  clusterOfPath,
  type MermaidEdgeInput,
  type MermaidNodeInput,
  renderMermaidDiagram,
  sanitizeMermaidLabel,
} from './diagram.js';
import {
  BLAST_RADIUS_DIAGRAM_MAX_JSON_CHARS,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_LABEL_CHARS,
  MAX_DIAGRAM_NODES,
} from './schema.js';

// ─── sanitizeMermaidLabel — D6 vector set ───────────────────────

/** Every output char must be allowlisted — or the single trailing `…`. */
const ALLOWLIST_RE = /^[A-Za-z0-9._/+ -]*$/;

describe('sanitizeMermaidLabel', () => {
  it.each([
    // quotes — cannot escape a double-quoted label
    ['evil"label.ts', 'evil_label.ts'],
    ["it's.ts", 'it_s.ts'],
    // backtick — no markdown/mermaid fence tricks
    ['back`tick`.ts', 'back_tick_.ts'],
    // HTML tags/entities — angle brackets collapse; `/` is allowlisted
    // (paths need it) but can never form a tag without `<`/`>`
    ['<script>alert(1)</script>.ts', '_script_alert_1__/script_.ts'],
    ['<img src=x>.ts', '_img src_x_.ts'],
    // edge-syntax injection — `>` is NOT allowlisted, so no `->`/`-->`
    // can survive; `-` itself is allowlisted (kebab-case file names)
    ['a-->b.ts', 'a--_b.ts'],
    ['a->b.ts', 'a-_b.ts'],
    ['a---b.ts', 'a---b.ts'],
    // newline + header injection (\n# heading becomes single-line)
    ['head\ner.ts\n# PWNED', 'head_er.ts__ PWNED'],
    // pipe — mermaid edge-label syntax
    ['x|y.ts', 'x_y.ts'],
    // unicode / emoji (astral char = 2 UTF-16 units → 2 underscores)
    ['café.ts', 'caf_.ts'],
    ['🎉party.ts', '__party.ts'],
    // mermaid keywords as whole paths — safe only because labels are quoted
    ['end', 'end'],
    ['subgraph', 'subgraph'],
    // dotfiles pass through the allowlist unchanged
    ['.gitignore', '.gitignore'],
    ['.env.local', '.env.local'],
    // ordinary nested path round-trips exactly
    ['src/lib/deep/util.test.ts', 'src/lib/deep/util.test.ts'],
  ])('vector %j → %j', (input, expected) => {
    const output = sanitizeMermaidLabel(input);
    expect(output).toBe(expected);
    // Closed-charset property on every vector: allowlisted bytes only.
    expect(ALLOWLIST_RE.test(output.replace(/…$/, ''))).toBe(true);
    // R7 sanitization contract: no raw `-->`, no newline, no quote, ever.
    expect(output).not.toContain('-->');
    expect(output).not.toContain('"');
    expect(output).not.toContain('\n');
  });

  it('caps a 300-char path at 80 chars: 79 allowlisted + the `…` sentinel', () => {
    const path = 'a'.repeat(300);
    const output = sanitizeMermaidLabel(path);
    expect(output).toHaveLength(MAX_DIAGRAM_LABEL_CHARS);
    expect(output.slice(0, -1)).toBe('a'.repeat(MAX_DIAGRAM_LABEL_CHARS - 1));
    expect(output.endsWith('…')).toBe(true);
  });

  it('leaves an exactly-80-char path untouched (boundary: no truncation sentinel)', () => {
    const path = 'b'.repeat(MAX_DIAGRAM_LABEL_CHARS);
    expect(sanitizeMermaidLabel(path)).toBe(path);
  });

  it('truncates AFTER the allowlist pass (truncation never masks hostile bytes)', () => {
    // 200 chars ending in quotes/newlines — the tail that survives must
    // still be allowlisted, and the sentinel is always last.
    const path = `${'c'.repeat(150)}"-->\n<img>`;
    const output = sanitizeMermaidLabel(path);
    expect(output).toHaveLength(MAX_DIAGRAM_LABEL_CHARS);
    expect(output.slice(0, -1)).toMatch(ALLOWLIST_RE);
    expect(output.endsWith('…')).toBe(true);
    expect(output).not.toContain('"');
    expect(output).not.toContain('-->');
    expect(output).not.toContain('\n');
  });
});

describe('clusterOfPath', () => {
  it('returns the first path segment', () => {
    expect(clusterOfPath('src/lib/a.ts')).toBe('src');
  });

  it('returns (root) for root files', () => {
    expect(clusterOfPath('README.md')).toBe('(root)');
  });

  it('sanitizes a hostile top-level directory name', () => {
    // `"` and `>` collapse; `-` survives (allowlisted) but `>` can never
    // form `-->`, and quotes can never escape the subgraph title.
    expect(clusterOfPath('we"ird-->x/a.ts')).toBe('we_ird--_x');
  });
});

// ─── renderMermaidDiagram ───────────────────────────────────────

function node(path: string, role: MermaidNodeInput['role'] = 'dependent'): MermaidNodeInput {
  return { path, role };
}

function edge(from: string, to: string): MermaidEdgeInput {
  return { from, to };
}

describe('renderMermaidDiagram — shape', () => {
  it('empty input → empty diagram (mermaid is the empty string)', () => {
    const diagram = renderMermaidDiagram([], []);
    expect(diagram.mermaid).toBe('');
    expect(diagram.nodes).toEqual([]);
    expect(diagram.edges).toEqual([]);
    expect(diagram.meta.truncated).toBe(false);
  });

  it('assigns ids n0.. by path-asc sort (input order irrelevant)', () => {
    const diagram = renderMermaidDiagram(
      [node('src/z.ts', 'changed'), node('src/a.ts', 'changed'), node('lib/m.ts', 'test')],
      [],
    );
    expect(diagram.nodes.map((n) => n.id)).toEqual(['n0', 'n1', 'n2']);
    expect(diagram.nodes.map((n) => n.label)).toEqual(['lib/m.ts', 'src/a.ts', 'src/z.ts']);
    expect(diagram.nodes.map((n) => n.role)).toEqual(['test', 'changed', 'changed']);
  });

  it('derives clusters: top-level dir, (root) for root files', () => {
    const diagram = renderMermaidDiagram(
      [node('README.md'), node('src/a.ts'), node('lib/u.ts')],
      [],
    );
    expect(diagram.nodes.map((n) => n.cluster)).toEqual(['(root)', 'lib', 'src']);
  });

  it('drops dangling and self edges, keeps internal ones', () => {
    const diagram = renderMermaidDiagram(
      [node('src/a.ts'), node('src/b.ts')],
      [edge('src/a.ts', 'src/b.ts'), edge('src/a.ts', 'nowhere.ts'), edge('src/a.ts', 'src/a.ts')],
    );
    expect(diagram.edges).toEqual([{ from: 'n0', to: 'n1' }]);
  });

  it('dedupes duplicate nodes and duplicate edges', () => {
    const diagram = renderMermaidDiagram(
      [node('src/a.ts', 'changed'), node('src/a.ts', 'dependent')],
      [edge('src/a.ts', 'src/b.ts'), edge('src/a.ts', 'src/b.ts')],
    );
    expect(diagram.nodes).toHaveLength(1);
    expect(diagram.nodes[0]?.role).toBe('changed'); // first occurrence wins
  });

  it('threads stale/exceededCap into meta untouched', () => {
    const diagram = renderMermaidDiagram([node('a.ts')], [], {
      stale: true,
      exceededCap: true,
    });
    expect(diagram.meta.stale).toBe(true);
    expect(diagram.meta.exceededCap).toBe(true);
    expect(diagram.meta.truncated).toBe(false);
  });
});

describe('renderMermaidDiagram — byte-exact emission (D7 order)', () => {
  it('emits header → classDef → subgraphs → class lines → sorted edges', () => {
    const diagram = renderMermaidDiagram(
      [
        node('src/a.ts', 'changed'),
        node('src/b.ts', 'changed'),
        node('lib/util.ts', 'dependent'),
        node('src/a.test.ts', 'test'),
      ],
      [
        edge('src/a.ts', 'lib/util.ts'), // a imports util
        edge('src/page.ts', 'src/a.ts'), // dangling — dropped
        edge('src/b.ts', 'src/a.ts'),
        edge('src/a.test.ts', 'src/a.ts'),
      ],
    );

    // Path-asc id assignment: lib/util.ts=n0, src/a.test.ts=n1,
    // src/a.ts=n2, src/b.ts=n3 ('src/a.test.ts' < 'src/a.ts' — 'e' < 's').
    expect(diagram.mermaid).toBe(
      [
        'flowchart TD',
        '  classDef changed fill:#fef3c7,stroke:#d97706,stroke-width:2px',
        '  classDef dependent fill:#dbeafe,stroke:#2563eb',
        '  classDef test fill:#dcfce7,stroke:#16a34a',
        '  subgraph c0["lib"]',
        '    n0["lib/util.ts"]',
        '  end',
        '  subgraph c1["src"]',
        '    n1["src/a.test.ts"]',
        '    n2["src/a.ts"]',
        '    n3["src/b.ts"]',
        '  end',
        '  class n2,n3 changed',
        '  class n0 dependent',
        '  class n1 test',
        '  n1 --> n2',
        '  n2 --> n0',
        '  n3 --> n2',
      ].join('\n'),
    );
  });

  it('renders (root) files in their own cluster, clusters sorted asc', () => {
    const diagram = renderMermaidDiagram(
      [node('src/a.ts'), node('README.md'), node('lib/u.ts')],
      [],
    );
    const lines = diagram.mermaid.split('\n');
    expect(lines).toContain('  subgraph c0["(root)"]');
    expect(lines).toContain('  subgraph c1["lib"]');
    expect(lines).toContain('  subgraph c2["src"]');
  });

  it('sorts edges by (from-id asc, to-id asc), independent of input order', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const diagram = renderMermaidDiagram(
      paths.map((p) => node(p)),
      [edge('d.ts', 'a.ts'), edge('a.ts', 'c.ts'), edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')],
    );
    expect(diagram.edges).toEqual([
      { from: 'n0', to: 'n1' }, // a → b
      { from: 'n0', to: 'n2' }, // a → c
      { from: 'n1', to: 'n0' }, // b → a
      { from: 'n3', to: 'n0' }, // d → a
    ]);
    const edgeLines = diagram.mermaid.split('\n').filter((l) => l.includes('-->'));
    expect(edgeLines).toEqual(['  n0 --> n1', '  n0 --> n2', '  n1 --> n0', '  n3 --> n0']);
  });

  it('is byte-identical across runs (determinism, no Set iteration in output)', () => {
    const nodes = ['src/z.ts', 'src/a.ts', 'lib/m.ts', 'README.md'].map((p, i) =>
      node(p, i % 2 === 0 ? 'changed' : 'dependent'),
    );
    const edges = [edge('src/z.ts', 'src/a.ts'), edge('src/a.ts', 'lib/m.ts')];
    const first = renderMermaidDiagram([...nodes], [...edges]);
    const second = renderMermaidDiagram([...nodes], [...edges]);
    expect(first.mermaid).toBe(second.mermaid);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('renderMermaidDiagram — caps (D2, defensive)', () => {
  function makeNodes(count: number): MermaidNodeInput[] {
    // 10 per top-level dir → deterministic cluster spread
    return Array.from({ length: count }, (_, i) => node(`d${Math.floor(i / 10)}/f${i}.ts`));
  }

  it(`caps nodes at ${MAX_DIAGRAM_NODES} with truncated + clusterCounts`, () => {
    const nodes = makeNodes(30); // 3 dirs × 10
    const diagram = renderMermaidDiagram(nodes, []);
    expect(diagram.nodes).toHaveLength(MAX_DIAGRAM_NODES);
    expect(diagram.meta.truncated).toBe(true);
    expect(diagram.meta.clusterCounts).toEqual({ d2: 5 }); // last 5 omitted
    // Omitted file names never reach the mermaid output.
    expect(diagram.mermaid).not.toContain('d2/f25.ts');
    expect(diagram.mermaid).not.toContain('d2/f29.ts');
    // Declared node lines: exactly 25 inside subgraphs.
    const declared = diagram.mermaid.split('\n').filter((l) => /^ {4}n\d+\["/.test(l));
    expect(declared).toHaveLength(MAX_DIAGRAM_NODES);
  });

  it(`caps edges at ${MAX_DIAGRAM_EDGES} and sets truncated (edge-only truncation)`, () => {
    // 10 nodes, 90 internal edges → nodes intact, edges cut to 40.
    const nodes = Array.from({ length: 10 }, (_, i) => node(`m${i}.ts`));
    const edges: MermaidEdgeInput[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        if (i !== j) edges.push(edge(`m${i}.ts`, `m${j}.ts`));
      }
    }
    expect(edges).toHaveLength(90);
    const diagram = renderMermaidDiagram(nodes, edges);
    expect(diagram.nodes).toHaveLength(10);
    expect(diagram.edges).toHaveLength(MAX_DIAGRAM_EDGES);
    expect(diagram.meta.truncated).toBe(true);
    expect(diagram.meta.clusterCounts).toBeUndefined(); // no NODE truncation
    // Kept edges are the sorted-first 40.
    const edgeLines = diagram.mermaid.split('\n').filter((l) => l.includes('-->'));
    expect(edgeLines).toHaveLength(MAX_DIAGRAM_EDGES);
  });

  it('satisfies the 10k JSON budget on worst-case input (25×80-char labels + 40 edges)', () => {
    const longDir = 'x'.repeat(40);
    const nodes: MermaidNodeInput[] = Array.from({ length: MAX_DIAGRAM_NODES }, (_, i) =>
      node(`${longDir}/n${i}${'y'.repeat(70)}.ts`, i === 0 ? 'changed' : 'dependent'),
    );
    const edges: MermaidEdgeInput[] = [];
    for (let i = 0; i < MAX_DIAGRAM_NODES && edges.length < MAX_DIAGRAM_EDGES; i++) {
      for (let j = 0; j < MAX_DIAGRAM_NODES && edges.length < MAX_DIAGRAM_EDGES; j++) {
        if (i !== j) edges.push(edge(nodes[i]!.path, nodes[j]!.path));
      }
    }
    const diagram = renderMermaidDiagram(nodes, edges);
    const size = JSON.stringify(diagram).length;
    expect(size).toBeLessThanOrEqual(BLAST_RADIUS_DIAGRAM_MAX_JSON_CHARS);
    expect(() => assertDiagramJsonBudget(diagram)).not.toThrow();
  });
});

describe('assertDiagramJsonBudget', () => {
  it('throws on an oversized synthetic diagram', () => {
    const diagram = renderMermaidDiagram([node('a.ts')], []);
    diagram.mermaid = 'x'.repeat(BLAST_RADIUS_DIAGRAM_MAX_JSON_CHARS); // corrupt post-hoc
    expect(() => assertDiagramJsonBudget(diagram)).toThrow(/JSON budget/);
  });
});
