/**
 * Load-bearing regression test — proof of the shipped-bug fix (D1/D2/D6).
 *
 * Before this change: `export { X } from './b'` (and the wildcard/type-only
 * forms) produced NO graph edge at all. A barrel re-exporting a symbol was
 * therefore invisible to `buildReverseIndex`, so a consumer importing that
 * symbol THROUGH the barrel was silently dropped from `computeBlastRadius`
 * when the true source file changed — a false negative in the blast-radius
 * feature this whole tool exists to compute correctly.
 *
 * This test builds a REAL graph via `buildGraph()` (the actual regex
 * extractor + builder pipeline, not a synthetic fixture) and asserts the
 * barrel-mediated dependent IS included. Confirmed to FAIL before the D1/D2
 * extractor fix (re-verified via `git stash` against the pre-fix extractor
 * — the consumer was excluded, `dependents` was `[]`) and PASS after
 * (dependents contains the consumer). No changes to blast-radius.ts or
 * buildReverseIndex — this is a pure edges-in-the-graph correctness fix
 * (D1: the algorithm was always right, the graph was incomplete).
 */

import { describe, expect, it } from 'vitest';
import { computeBlastRadius } from './blast-radius.js';
import { buildGraph } from './builder.js';

function makeFiles(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('computeBlastRadius — barrel-mediated dependency (load-bearing, proof-of-fix)', () => {
  it('named re-export: consumer importing via the barrel is included when the true source changes', () => {
    const files = makeFiles({
      'src/b.ts': `export function X() { return 1; }`,
      'src/index.ts': `export { X } from './b';`,
      'src/a.ts': `import { X } from './index';\nX();`,
    });
    const graph = buildGraph('.', files);

    const result = computeBlastRadius(graph, ['src/b.ts']);

    // Direct dependent (the barrel itself)
    expect(result.dependents).toContain('src/index.ts');
    // The load-bearing assertion: a.ts, which only imports THROUGH the
    // barrel, must be reached transitively. This is what was missing
    // pre-fix (barrel produced no edge => BFS never reached a.ts).
    expect(result.dependents).toContain('src/a.ts');
    expect(result.files.has('src/a.ts')).toBe(true);
  });

  it('wildcard re-export: consumer importing via the barrel is included when the true source changes', () => {
    const files = makeFiles({
      'src/b.ts': `export function X() { return 1; }`,
      'src/index.ts': `export * from './b';`,
      'src/a.ts': `import { X } from './index';\nX();`,
    });
    const graph = buildGraph('.', files);

    const result = computeBlastRadius(graph, ['src/b.ts']);

    expect(result.dependents).toContain('src/index.ts');
    expect(result.dependents).toContain('src/a.ts');
  });

  it('type-only re-export: consumer importing via the barrel is included when the true source changes', () => {
    const files = makeFiles({
      'src/b.ts': `export type X = { id: string };`,
      'src/index.ts': `export type { X } from './b';`,
      'src/a.ts': `import type { X } from './index';\nconst x: X = { id: '1' };`,
    });
    const graph = buildGraph('.', files);

    const result = computeBlastRadius(graph, ['src/b.ts']);

    expect(result.dependents).toContain('src/index.ts');
    expect(result.dependents).toContain('src/a.ts');
  });

  // ─── Python __init__.py barrel (BL-SCIP-BARREL-PYTHON-RUST) ────
  //
  // Mirrors the TS/JS barrel tests above for Python's `__init__.py`
  // package-barrel convention. Before this fix: `resolveImportPath` had no
  // notion of `__init__.py` as an index file, AND Python's dotted
  // relative-import syntax (`.sub`, `..sub`) was mishandled (treated as a
  // literal path segment rather than package-relative traversal) — so
  // NEITHER the barrel's own re-export edge NOR the consumer's absolute
  // `from pkg import X` edge ever resolved to a real file. A consumer
  // importing a symbol through the package barrel was silently dropped
  // from `computeBlastRadius` when the true submodule changed.
  it('Python package barrel: consumer importing via `pkg/__init__.py` is included when the true submodule changes', () => {
    const files = makeFiles({
      'pkg/sub.py': `def X():\n    return 1`,
      'pkg/__init__.py': `from .sub import X`,
      'consumer.py': `from pkg import X\nX()`,
    });
    const graph = buildGraph('.', files);

    const result = computeBlastRadius(graph, ['pkg/sub.py']);

    // Direct dependent (the barrel itself)
    expect(result.dependents).toContain('pkg/__init__.py');
    // The load-bearing assertion: consumer.py, which only imports THROUGH
    // the barrel via an absolute dotted import, must be reached
    // transitively.
    expect(result.dependents).toContain('consumer.py');
    expect(result.files.has('consumer.py')).toBe(true);
  });
});
