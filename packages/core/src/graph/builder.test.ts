/**
 * Unit tests for the graph builder.
 *
 * Tests buildGraph() and buildGraphIncremental() with
 * in-memory file maps (no filesystem access).
 */

import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildGraphIncremental,
  detectLanguage,
  isExcludedPath,
  resolveImportPath,
} from './builder.js';
import { GRAPH_VERSION, MAX_GRAPH_SIZE_BYTES } from './schema.js';

// ─── Helper ─────────────────────────────────────────────────────

function makeFiles(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// ─── detectLanguage ─────────────────────────────────────────────

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('App.tsx')).toBe('typescript');
  });

  it('detects JavaScript', () => {
    expect(detectLanguage('server.js')).toBe('javascript');
    expect(detectLanguage('module.mjs')).toBe('javascript');
    expect(detectLanguage('config.cjs')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(detectLanguage('app.py')).toBe('python');
  });

  it('detects Go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('detects Java', () => {
    expect(detectLanguage('App.java')).toBe('java');
  });

  it('detects Rust', () => {
    expect(detectLanguage('main.rs')).toBe('rust');
  });

  it('returns undefined for unsupported extensions', () => {
    expect(detectLanguage('readme.md')).toBeUndefined();
    expect(detectLanguage('style.css')).toBeUndefined();
    expect(detectLanguage('data.json')).toBeUndefined();
  });
});

// ─── isExcludedPath ─────────────────────────────────────────────

describe('isExcludedPath', () => {
  it('excludes node_modules', () => {
    expect(isExcludedPath('node_modules/lodash/index.js')).toBe(true);
  });

  it('excludes .git', () => {
    expect(isExcludedPath('.git/objects/pack')).toBe(true);
  });

  it('excludes vendor', () => {
    expect(isExcludedPath('vendor/github.com/pkg/errors/errors.go')).toBe(true);
  });

  it('does not exclude normal paths', () => {
    expect(isExcludedPath('src/graph/builder.ts')).toBe(false);
  });
});

// ─── resolveImportPath ──────────────────────────────────────────

describe('resolveImportPath', () => {
  const available = new Set(['src/utils.ts', 'src/index.ts', 'src/components/Button.tsx']);

  it('resolves relative import to known file', () => {
    const result = resolveImportPath('src/main.ts', './utils', available);
    expect(result).toBe('src/utils.ts');
  });

  it('returns non-relative imports as-is', () => {
    const result = resolveImportPath('src/main.ts', 'lodash', available);
    expect(result).toBe('lodash');
  });

  it('resolves index file for directory import', () => {
    const available2 = new Set(['src/utils/index.ts']);
    const result = resolveImportPath('src/main.ts', './utils', available2);
    expect(result).toBe('src/utils/index.ts');
  });

  it('resolves .js extension to .ts file', () => {
    const result = resolveImportPath('src/main.ts', './utils.js', available);
    expect(result).toBe('src/utils.ts');
  });
});

// ─── buildGraph ─────────────────────────────────────────────────

describe('buildGraph', () => {
  it('builds graph with correct version and rootDir', () => {
    const files = makeFiles({
      'src/index.ts': 'export const x = 1;',
    });
    const graph = buildGraph('.', files);
    expect(graph.version).toBe(GRAPH_VERSION);
    expect(graph.rootDir).toBe('.');
  });

  it('creates nodes for all supported files', () => {
    const files = makeFiles({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
    });
    const graph = buildGraph('.', files);
    expect(Object.keys(graph.nodes)).toHaveLength(2);
    expect(graph.nodes['src/a.ts']).toBeDefined();
    expect(graph.nodes['src/b.ts']).toBeDefined();
  });

  it('resolves relative imports between files', () => {
    const files = makeFiles({
      'src/a.ts': `import { b } from './b';`,
      'src/b.ts': 'export const b = 1;',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/a.ts']?.imports).toContain('src/b.ts');
  });

  it('never populates symbolRanges (SCIP-only field, scip-symbol-ranges D2)', () => {
    const files = makeFiles({
      'src/a.ts': `function foo() {\n  return 1;\n}\n`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/a.ts']?.symbolRanges).toBeUndefined();
  });

  it('detects correct language for each file', () => {
    const files = makeFiles({
      'main.py': 'def hello(): pass',
      'app.go': 'package main',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['main.py']?.language).toBe('python');
    expect(graph.nodes['app.go']?.language).toBe('go');
  });

  it('skips excluded directories', () => {
    const files = makeFiles({
      'src/a.ts': 'export const a = 1;',
      'node_modules/lodash/index.js': 'module.exports = {};',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/a.ts']).toBeDefined();
    expect(graph.nodes['node_modules/lodash/index.js']).toBeUndefined();
  });

  it('skips unsupported file extensions', () => {
    const files = makeFiles({
      'src/a.ts': 'export const a = 1;',
      'readme.md': '# Hello',
      'style.css': 'body {}',
    });
    const graph = buildGraph('.', files);
    expect(Object.keys(graph.nodes)).toHaveLength(1);
  });

  it('marks test files correctly', () => {
    const files = makeFiles({
      'src/a.ts': 'export const a = 1;',
      'src/a.test.ts': `import { a } from './a';`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/a.ts']?.isTest).toBe(false);
    expect(graph.nodes['src/a.test.ts']?.isTest).toBe(true);
  });

  it('computes unique hashes per file content', () => {
    const files = makeFiles({
      'a.ts': 'const a = 1;',
      'b.ts': 'const b = 2;',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['a.ts']?.hash).not.toBe(graph.nodes['b.ts']?.hash);
  });

  it('computes same hash for same content', () => {
    const files = makeFiles({
      'a.ts': 'const x = 1;',
      'b.ts': 'const x = 1;',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['a.ts']?.hash).toBe(graph.nodes['b.ts']?.hash);
  });

  it('extracts exports from TypeScript files', () => {
    const files = makeFiles({
      'src/utils.ts': `
export function helper() {}
export const CONSTANT = 42;
export class Service {}
`,
    });
    const graph = buildGraph('.', files);
    const exports = graph.nodes['src/utils.ts']?.exports;
    expect(exports).toContain('helper');
    expect(exports).toContain('CONSTANT');
    expect(exports).toContain('Service');
  });

  // ─── Barrel re-export split (D3, D6) ───────────────────────────

  it('buildGraph: barrel node.imports resolves the re-export source, and split fields are populated', () => {
    const files = makeFiles({
      'src/b.ts': `export const X = 1;`,
      'src/index.ts': `export { X } from './b';`,
    });
    const graph = buildGraph('.', files);
    const barrel = graph.nodes['src/index.ts'];
    expect(barrel).toBeDefined();
    expect(barrel?.imports).toContain('src/b.ts');
    expect(barrel?.exports).toEqual([]);
    expect(barrel?.reExportedSymbols).toEqual(['X']);
  });

  it('buildGraphIncremental: barrel node.imports resolves the re-export source, and split fields are populated (parity with buildGraph)', () => {
    const files = makeFiles({
      'src/b.ts': `export const X = 1;`,
      'src/index.ts': `export { X } from './b';`,
    });
    const fullGraph = buildGraph('.', files);

    // Rebuild incrementally from an empty base to prove the incremental
    // path independently derives the same barrel edge + split (D6 parity
    // — the classic "fix one path, miss the other" trap).
    const emptyGraph = { version: GRAPH_VERSION, rootDir: '.', nodes: {} };
    const incrementalGraph = buildGraphIncremental(emptyGraph, files, []);

    const fullBarrel = fullGraph.nodes['src/index.ts'];
    const incrementalBarrel = incrementalGraph.nodes['src/index.ts'];
    expect(incrementalBarrel?.imports).toEqual(fullBarrel?.imports);
    expect(incrementalBarrel?.exports).toEqual(fullBarrel?.exports);
    expect(incrementalBarrel?.reExportedSymbols).toEqual(fullBarrel?.reExportedSymbols);
    expect(incrementalBarrel?.imports).toContain('src/b.ts');
    expect(incrementalBarrel?.reExportedSymbols).toEqual(['X']);
  });

  it('buildGraph: wildcard re-export resolves reExportsAll to the source path in BOTH builders', () => {
    const files = makeFiles({
      'src/b.ts': `export const X = 1;`,
      'src/index.ts': `export * from './b';`,
    });
    const fullGraph = buildGraph('.', files);
    const emptyGraph = { version: GRAPH_VERSION, rootDir: '.', nodes: {} };
    const incrementalGraph = buildGraphIncremental(emptyGraph, files, []);

    expect(fullGraph.nodes['src/index.ts']?.reExportsAll).toEqual(['src/b.ts']);
    expect(incrementalGraph.nodes['src/index.ts']?.reExportsAll).toEqual(['src/b.ts']);
    expect(fullGraph.nodes['src/index.ts']?.imports).toContain('src/b.ts');
  });

  it('a genuine local export in the barrel is unaffected by the split', () => {
    const files = makeFiles({
      'src/b.ts': `export const X = 1;`,
      'src/index.ts': `export const Y = 2;\nexport { X } from './b';`,
    });
    const graph = buildGraph('.', files);
    const barrel = graph.nodes['src/index.ts'];
    expect(barrel?.exports).toEqual(['Y']);
    expect(barrel?.reExportedSymbols).toEqual(['X']);
  });

  it('handles parse errors gracefully (creates minimal node)', () => {
    // Content that might confuse regex — should still create a node
    const files = makeFiles({
      'src/weird.ts': '/* unclosed comment',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/weird.ts']).toBeDefined();
    expect(graph.nodes['src/weird.ts']?.language).toBe('typescript');
  });

  it('handles empty files', () => {
    const files = makeFiles({
      'src/empty.ts': '',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/empty.ts']).toBeDefined();
    expect(graph.nodes['src/empty.ts']?.imports).toEqual([]);
    expect(graph.nodes['src/empty.ts']?.exports).toEqual([]);
  });

  it('builds correct graph for multi-language project', () => {
    const files = makeFiles({
      'src/app.ts': `import { handler } from './handler';`,
      'src/handler.ts': `export function handler() {}`,
      'scripts/deploy.py': `import os\ndef deploy(): pass`,
      'cmd/main.go': `package main\nimport "fmt"\nfunc Main() {}`,
    });
    const graph = buildGraph('.', files);
    expect(Object.keys(graph.nodes)).toHaveLength(4);
    expect(graph.nodes['src/app.ts']?.imports).toContain('src/handler.ts');
  });

  it('skips SCIP-only languages (no regex extractor) without throwing', () => {
    const files = makeFiles({
      'src/app.ts': `export function main() {}`,
      'src/Main.kt': `fun main() { println("hi") }`,
      'src/Program.cs': `class Program { static void Main() {} }`,
      'src/index.php': `<?php function hello() {} ?>`,
    });

    expect(() => buildGraph('.', files)).not.toThrow();
    const graph = buildGraph('.', files);

    // The regex-indexable file is still built.
    expect(graph.nodes['src/app.ts']).toBeDefined();
    // SCIP-only files are dropped from the regex-built graph, not crashed
    // into a bogus node with an undefined extractor.
    expect(graph.nodes['src/Main.kt']).toBeUndefined();
    expect(graph.nodes['src/Program.cs']).toBeUndefined();
    expect(graph.nodes['src/index.php']).toBeUndefined();
  });
});

// ─── importSymbols (Slice 1a — regex builder) ────────────────────

describe('buildGraph importSymbols', () => {
  it('populates importSymbols keyed by the RESOLVED target path for named TS imports', () => {
    const files = makeFiles({
      'src/a.ts': `import { X, Y } from './b';`,
      'src/b.ts': 'export const X = 1;\nexport const Y = 2;',
    });
    const graph = buildGraph('.', files);
    const aNode = graph.nodes['src/a.ts'];
    expect(aNode?.imports).toContain('src/b.ts');
    expect(aNode?.importSymbols?.['src/b.ts']).toEqual(expect.arrayContaining(['X', 'Y']));
    expect(aNode?.importSymbols?.['src/b.ts']).toHaveLength(2);
  });

  it('omits importSymbols for module-only imports without named symbols (Python `import x`, Rust wildcard `use`)', () => {
    // NOTE: unlike a plain `import os`/module-only Rust `use`, Python's
    // `from x import y` and Rust's `use crate::mod::Item` DO carry named
    // symbols (see the dedicated tests below) — the omit-empty rule is
    // per-edge, not per-language.
    const files = makeFiles({
      'scripts/deploy.py': `import os\ndef deploy(): pass`,
      'src/lib.rs': `use std::io::*;\nfn run() {}`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['scripts/deploy.py']?.importSymbols).toBeUndefined();
    expect(graph.nodes['src/lib.rs']?.importSymbols).toBeUndefined();
  });

  it('populates importSymbols for Python `from x import y, z` (named symbols ARE extracted)', () => {
    const files = makeFiles({
      'scripts/deploy.py': `from utils import helper, run\ndef deploy(): pass`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['scripts/deploy.py']?.importSymbols?.utils).toEqual(
      expect.arrayContaining(['helper', 'run']),
    );
  });

  it('populates importSymbols for Rust `use crate::module::Item` (named symbols ARE extracted)', () => {
    const files = makeFiles({
      'src/lib.rs': `use crate::helper::Item;\nfn run() {}`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/lib.rs']?.importSymbols?.['crate::helper']).toEqual(['Item']);
  });

  it('omits importSymbols for Go alias-only imports (no named symbols)', () => {
    const files = makeFiles({
      'cmd/main.go': `package main\nimport "fmt"\nfunc Main() { fmt.Println("hi") }`,
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['cmd/main.go']?.importSymbols).toBeUndefined();
  });

  it('does not alter imports:string[] when importSymbols is populated', () => {
    const files = makeFiles({
      'src/a.ts': `import { X } from './b';`,
      'src/b.ts': 'export const X = 1;',
    });
    const graph = buildGraph('.', files);
    expect(graph.nodes['src/a.ts']?.imports).toEqual(['src/b.ts']);
  });

  it('merges symbols when multiple raw specifiers resolve to the same target', () => {
    const files = makeFiles({
      'src/a.ts': `import { X } from './b';\nimport { Y } from './b.ts';`,
      'src/b.ts': 'export const X = 1;\nexport const Y = 2;',
    });
    const graph = buildGraph('.', files);
    const symbols = graph.nodes['src/a.ts']?.importSymbols?.['src/b.ts'];
    expect(symbols).toEqual(expect.arrayContaining(['X', 'Y']));
  });
});

describe('buildGraphIncremental importSymbols', () => {
  it('populates importSymbols keyed by resolved path via the incremental path', () => {
    const existing = buildGraph(
      '.',
      makeFiles({
        'src/b.ts': 'export const X = 1;\nexport const Y = 2;',
      }),
    );

    const result = buildGraphIncremental(
      existing,
      makeFiles({ 'src/a.ts': `import { X, Y } from './b';` }),
      [],
    );

    const aNode = result.nodes['src/a.ts'];
    expect(aNode?.imports).toContain('src/b.ts');
    expect(aNode?.importSymbols?.['src/b.ts']).toEqual(expect.arrayContaining(['X', 'Y']));
  });

  it('omits importSymbols for non-symbol extractors in the incremental path', () => {
    const existing = buildGraph('.', makeFiles({ 'src/a.ts': 'export const a = 1;' }));
    const result = buildGraphIncremental(
      existing,
      makeFiles({ 'scripts/deploy.py': `import os\ndef deploy(): pass` }),
      [],
    );
    expect(result.nodes['scripts/deploy.py']?.importSymbols).toBeUndefined();
  });
});

// ─── Graph-size sanity (Phase 4.3) ───────────────────────────────

describe('importSymbols graph-size sanity', () => {
  it('a moderately large TS-heavy graph with importSymbols populated stays well under MAX_GRAPH_SIZE_BYTES', () => {
    const entries: Record<string, string> = {};
    const fileCount = 500;
    for (let i = 0; i < fileCount; i++) {
      // Each file imports the previous 3 files by 2 named symbols each —
      // realistic worst case for importSymbols density.
      const deps = [i - 1, i - 2, i - 3].filter((n) => n >= 0);
      const importLines = deps
        .map((n) => `import { symA${n}, symB${n} } from './file${n}';`)
        .join('\n');
      entries[`file${i}.ts`] =
        `${importLines}\nexport const symA${i} = 1;\nexport const symB${i} = 2;\n`;
    }
    const files = new Map(Object.entries(entries));
    const graph = buildGraph('.', files);

    const serializedSize = Buffer.byteLength(JSON.stringify(graph), 'utf-8');
    expect(serializedSize).toBeLessThan(MAX_GRAPH_SIZE_BYTES);

    // Sanity: importSymbols really is populated (not silently empty).
    const populated = Object.values(graph.nodes).filter((n) => n.importSymbols);
    expect(populated.length).toBeGreaterThan(0);
  });
});

// ─── buildGraphIncremental ──────────────────────────────────────

describe('buildGraphIncremental', () => {
  it('keeps unchanged nodes from existing graph', () => {
    const existing = buildGraph(
      '.',
      makeFiles({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
      }),
    );

    const result = buildGraphIncremental(
      existing,
      makeFiles({ 'src/b.ts': 'export const b = 999;' }),
      [],
    );

    // a.ts should be unchanged
    expect(result.nodes['src/a.ts']?.hash).toBe(existing.nodes['src/a.ts']?.hash);
    // b.ts should have a new hash
    expect(result.nodes['src/b.ts']?.hash).not.toBe(existing.nodes['src/b.ts']?.hash);
  });

  it('removes deleted files', () => {
    const existing = buildGraph(
      '.',
      makeFiles({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
      }),
    );

    const result = buildGraphIncremental(existing, new Map(), ['src/b.ts']);
    expect(result.nodes['src/a.ts']).toBeDefined();
    expect(result.nodes['src/b.ts']).toBeUndefined();
  });

  it('adds new files', () => {
    const existing = buildGraph(
      '.',
      makeFiles({
        'src/a.ts': 'export const a = 1;',
      }),
    );

    const result = buildGraphIncremental(
      existing,
      makeFiles({ 'src/c.ts': 'export const c = 3;' }),
      [],
    );

    expect(result.nodes['src/a.ts']).toBeDefined();
    expect(result.nodes['src/c.ts']).toBeDefined();
    expect(Object.keys(result.nodes)).toHaveLength(2);
  });

  it('preserves graph version and rootDir', () => {
    const existing = buildGraph(
      '/project',
      makeFiles({
        'src/a.ts': 'export const a = 1;',
      }),
    );

    const result = buildGraphIncremental(existing, new Map(), []);
    expect(result.version).toBe(GRAPH_VERSION);
    expect(result.rootDir).toBe('/project');
  });

  it('handles simultaneous add, update, and delete', () => {
    const existing = buildGraph(
      '.',
      makeFiles({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
        'src/c.ts': 'export const c = 3;',
      }),
    );

    const result = buildGraphIncremental(
      existing,
      makeFiles({
        'src/b.ts': 'export const b = 999;', // update
        'src/d.ts': 'export const d = 4;', // add
      }),
      ['src/c.ts'], // delete
    );

    expect(result.nodes['src/a.ts']).toBeDefined(); // unchanged
    expect(result.nodes['src/b.ts']).toBeDefined(); // updated
    expect(result.nodes['src/c.ts']).toBeUndefined(); // deleted
    expect(result.nodes['src/d.ts']).toBeDefined(); // added
    expect(Object.keys(result.nodes)).toHaveLength(3);
  });
});
