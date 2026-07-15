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
import { GRAPH_VERSION } from './schema.js';

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
