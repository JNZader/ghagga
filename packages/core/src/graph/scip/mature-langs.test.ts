/**
 * Unit tests for buildGraphFromScip() against the Tier B mature-language
 * fixtures (TS/JS, Python, Rust) — mirrors builder.test.ts's Go coverage,
 * proving the mapper is language-agnostic (it only reads
 * Index.documents/symbols/occurrences, never anything Go-specific).
 *
 * Each fixture is a real captured `index.scip`, produced by running the
 * real indexer against a tiny two-file sample with one cross-file
 * reference (see test/fixtures/scip-<lang>-sample/).
 *
 * Python (scip-python 0.6.6) is SKIPPED: the indexer ran successfully
 * (exit 0, no errors) against multiple fixture shapes (pyproject.toml,
 * pyrightconfig.json, with/without a git repo, with/without a venv,
 * single-file and package forms) but emitted 0 documents every time —
 * see apply-progress notes. The Python registry entry itself still ships;
 * only the fixture capture is deferred.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');

function loadFixtureIndex(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('buildGraphFromScip — TypeScript/JavaScript (scip-typescript fixture)', () => {
  it('parses the real scip-typescript fixture into an Index with 2 documents', () => {
    const index = loadFixtureIndex('scip-ts-sample');
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['main.ts', 'pkg/greeting.ts']);
  });

  it('resolves the cross-file relative-import reference: main.ts imports pkg/greeting.ts', () => {
    const index = loadFixtureIndex('scip-ts-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['main.ts'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.language).toBe('typescript');
    expect(mainNode?.imports).toContain('pkg/greeting.ts');
  });

  it('pkg/greeting.ts exports a symbol for greet (scip-typescript emits the raw SCIP symbol id, not a display name, for this construct)', () => {
    const index = loadFixtureIndex('scip-ts-sample');
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['pkg/greeting.ts'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.exports.some((e) => e.includes('greet'))).toBe(true);
  });
});

describe('buildGraphFromScip — Rust (rust-analyzer fixture)', () => {
  it('parses the real rust-analyzer fixture into an Index with 2 documents', () => {
    const index = loadFixtureIndex('scip-rust-sample');
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['src/greeting.rs', 'src/main.rs']);
  });

  it('resolves the cross-file module reference: src/main.rs imports src/greeting.rs', () => {
    const index = loadFixtureIndex('scip-rust-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['src/main.rs'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.language).toBe('rust');
    expect(mainNode?.imports).toContain('src/greeting.rs');
  });

  it('src/greeting.rs exports greet', () => {
    const index = loadFixtureIndex('scip-rust-sample');
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['src/greeting.rs'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.exports).toContain('greet');
  });
});

// TODO(sdd/extend-scip-languages): scip-python 0.6.6 produced 0 documents
// against every fixture shape attempted in this environment (Node 25.8.1 /
// Python 3.14.5) despite exiting 0 with no errors. Capture this fixture
// out-of-band (e.g. against an older Python/pyright combination, or after
// filing an upstream scip-python issue) and un-skip.
describe.skip('buildGraphFromScip — Python (scip-python fixture) [DEFERRED: capture failed]', () => {
  it('resolves the cross-file import reference: main.py imports pkg/greeting.py', () => {
    const index = loadFixtureIndex('scip-python-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['main.py'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.imports).toContain('pkg/greeting.py');
  });
});
