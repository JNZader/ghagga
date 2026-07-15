/**
 * TASK 4.5 (HIGH-RISK #3) — per-language graph-resolution validation.
 *
 * `computeBlastRadius` from ghagga-core only finds a dependent if the
 * importer's raw import specifier was RESOLVED to a project-relative file
 * path by `resolveImportPath` (builder.ts). That resolver only rewrites
 * specifiers that literally start with `.` (relative paths) — it does
 * nothing for absolute/package-qualified import styles (Java's dotted
 * package path, Rust's `crate::`/`std::` paths, Go's module paths).
 *
 * This test builds a tiny in-fixture sample tree per language, with a
 * seed file imported by a dependent, and asserts EMPIRICALLY whether
 * `computeBlastRadius(graph, [seed])` finds that dependent. The result
 * gates `GRAPH_RESOLVABLE_LANGUAGES` (locate/expand.ts) — `graphExpand`
 * must never be enabled for a language this test shows unresolved.
 *
 * RESULT (original triage-engine branch): only TypeScript and JavaScript
 * resolve. Python, Rust, Java, and Go all failed to resolve — each used an
 * import-specifier style resolveImportPath was never designed to handle
 * (module/package paths or a `.`-prefixed convention that isn't a joinable
 * relative path).
 *
 * UPDATE (landed onto main, BL-SCIP-LOCATE-INTEGRATION Phase A): ghagga-core's
 * resolver was rewritten as a registry-driven multi-language SCIP indexer
 * (#317/#321) since this test was authored. Re-running these tests against
 * current core shows Python relative imports (`.seed` style) NOW resolve.
 * Rust, Java, and Go still do not (re-confirmed below). `GRAPH_RESOLVABLE_LANGUAGES`
 * intentionally still only lists `ts`/`js` here — expanding it to include `py`
 * is a follow-up feature decision, out of scope for landing this package.
 */

import { buildGraph, computeBlastRadius } from 'ghagga-core';
import { describe, expect, it } from 'vitest';
import { GRAPH_RESOLVABLE_LANGUAGES } from './expand.js';

describe('per-language graph resolution (task 4.5)', () => {
  it('TypeScript: relative import resolves seed -> dependent', () => {
    const files = new Map<string, string>([
      ['src/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/dependent.ts', "import { seed } from './seed';\nexport const x = seed();\n"],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['src/seed.ts']);
    expect(result.dependents).toContain('src/dependent.ts');
  });

  it('JavaScript: relative import resolves seed -> dependent', () => {
    const files = new Map<string, string>([
      ['src/seed.js', 'export function seed() { return 1; }\n'],
      ['src/dependent.js', "import { seed } from './seed';\nexport const x = seed();\n"],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['src/seed.js']);
    expect(result.dependents).toContain('src/dependent.js');
  });

  it('Python: relative import now resolves seed -> dependent (ghagga-core SCIP graph rewrite, #317/#321)', () => {
    // Originally (when this test was authored on the triage-engine branch), the
    // TS/JS-import-style resolver in builder.ts could not map `.seed` (Python's
    // package-relative-module convention) to `pkg/seed.py`. Since then, ghagga-core's
    // main branch replaced the resolver with a registry-driven multi-language SCIP
    // indexer (#317, wired into blast-radius in #321) that DOES resolve this case.
    // Re-verified empirically against current ghagga-core when landing triage-engine
    // onto main (Phase A of BL-SCIP-LOCATE-INTEGRATION). Python is NOT yet added to
    // GRAPH_RESOLVABLE_LANGUAGES here — that is a deliberate follow-up decision, not
    // a mechanical drift fix; this test only documents the new resolver capability.
    const files = new Map<string, string>([
      ['pkg/seed.py', 'def seed():\n    return 1\n'],
      ['pkg/dependent.py', 'from .seed import seed\n\nx = seed()\n'],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['pkg/seed.py']);
    expect(result.dependents).toContain('pkg/dependent.py');
  });

  it('Rust: `use` path does NOT resolve seed -> dependent (module-path style, not relative)', () => {
    const files = new Map<string, string>([
      ['src/seed.rs', 'pub fn seed() -> i32 { 1 }\n'],
      ['src/dependent.rs', 'use crate::seed::seed;\n\nfn dependent() -> i32 { seed() }\n'],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['src/seed.rs']);
    expect(result.dependents).not.toContain('src/dependent.rs');
  });

  it('Java: fully-qualified import does NOT resolve seed -> dependent (dotted package path, not relative)', () => {
    const files = new Map<string, string>([
      ['src/main/java/com/acme/Seed.java', 'package com.acme;\n\npublic class Seed {}\n'],
      [
        'src/main/java/com/acme/Dependent.java',
        'package com.acme;\n\nimport com.acme.Seed;\n\npublic class Dependent {}\n',
      ],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['src/main/java/com/acme/Seed.java']);
    expect(result.dependents).not.toContain('src/main/java/com/acme/Dependent.java');
  });

  it('Go: module-path import does NOT resolve seed -> dependent (known gap, confirmed by PoC)', () => {
    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
    ]);
    const graph = buildGraph('/fixture', files);
    const result = computeBlastRadius(graph, ['pkg/seed/seed.go']);
    expect(result.dependents).not.toContain('pkg/dependent/dependent.go');
  });

  it('GRAPH_RESOLVABLE_LANGUAGES matches the empirically-confirmed resolvable set exactly', () => {
    // Only TypeScript and JavaScript use `./relative` ES-module import specifiers,
    // the ONE style `resolveImportPath` (builder.ts) actually resolves to a project
    // file path. Python's `.`-prefixed relative modules, Rust's `crate::`/module
    // paths, Java's dotted package imports, and Go's module paths are all left
    // unresolved by the generic resolver — confirmed empirically above.
    expect([...GRAPH_RESOLVABLE_LANGUAGES].sort()).toEqual(['js', 'ts']);
  });

  it('GRAPH_RESOLVABLE_LANGUAGES never includes go', () => {
    expect(GRAPH_RESOLVABLE_LANGUAGES.has('go')).toBe(false);
  });
});
