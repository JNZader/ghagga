/**
 * Unit tests for `computeChangedSymbolsComplete` and `findInnermostSymbol`
 * (scip-symbol-ranges D3/D4/D7).
 */

import { describe, expect, it } from 'vitest';
import { computeChangedSymbolsComplete, findInnermostSymbol } from './changed-symbols.js';
import type { DependencyGraph } from './schema.js';
import { GRAPH_VERSION } from './schema.js';

function makeGraph(nodes: DependencyGraph['nodes']): DependencyGraph {
  return { version: GRAPH_VERSION, rootDir: '.', nodes };
}

// ─── findInnermostSymbol (D3) ───────────────────────────────────

describe('findInnermostSymbol', () => {
  it('returns undefined when ranges is undefined', () => {
    expect(findInnermostSymbol(undefined, 5)).toBeUndefined();
  });

  it('returns undefined when the line is outside every range', () => {
    expect(findInnermostSymbol({ Foo: [1, 3] }, 5)).toBeUndefined();
  });

  it('picks the SMALLEST enclosing span — nested method wins over the outer class', () => {
    const ranges = { ClassC: [1, 20], methodM: [5, 10] };
    expect(findInnermostSymbol(ranges, 7)).toBe('methodM');
  });

  it('a line inside the class but between two methods (no nested range) attributes to the class', () => {
    const ranges = { ClassC: [1, 20], methodA: [2, 5], methodB: [15, 18] };
    // Line 10 sits inside ClassC's range but outside both methods.
    expect(findInnermostSymbol(ranges, 10)).toBe('ClassC');
  });

  it('ties on identical span break on smallest start', () => {
    const ranges = { First: [1, 5], Second: [3, 7] };
    // Line 4 falls in both [1,5] (span 4) and [3,7] (span 4) — tie, smallest start wins.
    expect(findInnermostSymbol(ranges, 4)).toBe('First');
  });
});

// ─── computeChangedSymbolsComplete (D4) ─────────────────────────

describe('computeChangedSymbolsComplete', () => {
  it('GOLDEN: a body-only change (signature line unchanged) attributes to the containing symbol', () => {
    // function X spans 1-based lines [1,3]; body-only edit on line 2.
    const graph = makeGraph({
      'src/b.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['X'],
        symbolRanges: { X: [1, 3] },
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
 export function X() {
-  return 1;
+  return 42;
 }
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    const entry = result.get('src/b.ts');
    expect(entry).toBeDefined();
    expect(entry?.changedSymbols.has('X')).toBe(true);
    expect(entry?.hasUnattributedChanges).toBe(false);
  });

  it('a signature-line change is still detected', () => {
    const graph = makeGraph({
      'src/b.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['X'],
        symbolRanges: { X: [1, 3] },
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
-export function X() {
+export function X(arg) {
   return 1;
 }
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    expect(result.get('src/b.ts')?.changedSymbols.has('X')).toBe(true);
  });

  it('nested symbols attribute to the innermost enclosing range (method vs class)', () => {
    // class ClassC spans [1,10]; nested method M spans [3,5].
    const graph = makeGraph({
      'src/c.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['ClassC'],
        symbolRanges: { ClassC: [1, 10], M: [3, 5] },
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -3,3 +3,3 @@
   method M() {
-    return 1;
+    return 2;
   }
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    const entry = result.get('src/c.ts');
    expect(entry?.changedSymbols.has('M')).toBe(true);
    expect(entry?.changedSymbols.has('ClassC')).toBe(false);
  });

  it('a changed line outside every known range sets hasUnattributedChanges (top-level statement/import)', () => {
    const graph = makeGraph({
      'src/d.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['X'],
        symbolRanges: { X: [5, 8] },
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/d.ts b/src/d.ts
--- a/src/d.ts
+++ b/src/d.ts
@@ -1,1 +1,1 @@
-import { old } from './old.js';
+import { fresh } from './fresh.js';
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    const entry = result.get('src/d.ts');
    expect(entry?.hasUnattributedChanges).toBe(true);
    expect(entry?.changedSymbols.size).toBe(0);
  });

  it('LANDMINE (D7/2.7): a pure-deletion hunk (newCount === 0) sets hasUnattributedChanges', () => {
    const graph = makeGraph({
      'src/e.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['X'],
        symbolRanges: { X: [1, 5] },
        calls: [],
        isTest: false,
      },
    });

    // A pure deletion: 2 lines removed, nothing added — newCount 0.
    const diff = `
diff --git a/src/e.ts b/src/e.ts
--- a/src/e.ts
+++ b/src/e.ts
@@ -2,2 +1,0 @@
-  const a = 1;
-  const b = 2;
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    expect(result.get('src/e.ts')?.hasUnattributedChanges).toBe(true);
  });

  it('LANDMINE (D7/2.7): a deleted file (isDeleted, /dev/null new side) sets hasUnattributedChanges', () => {
    const graph = makeGraph({
      'src/f.ts': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: ['X'],
        symbolRanges: { X: [1, 5] },
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/f.ts b/src/f.ts
deleted file mode 100644
--- a/src/f.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-export function X() {
-  return 1;
-}
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    expect(result.get('src/f.ts')?.hasUnattributedChanges).toBe(true);
  });

  it('LANDMINE (D7/2.7): a binary file diff sets hasUnattributedChanges', () => {
    const graph = makeGraph({
      'assets/logo.png': {
        hash: 'h',
        language: 'typescript',
        imports: [],
        exports: [],
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/assets/logo.png b/assets/logo.png
index abc..def 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    expect(result.get('assets/logo.png')?.hasUnattributedChanges).toBe(true);
  });

  it('a file with NO symbolRanges at all (regex graph / C#/PHP) and changed lines → hasUnattributedChanges', () => {
    const graph = makeGraph({
      'src/g.cs': {
        hash: 'h',
        language: 'csharp',
        imports: [],
        exports: ['Qux'],
        // no symbolRanges
        calls: [],
        isTest: false,
      },
    });

    const diff = `
diff --git a/src/g.cs b/src/g.cs
--- a/src/g.cs
+++ b/src/g.cs
@@ -1,1 +1,1 @@
-void Qux() { return; }
+void Qux() { doSomething(); }
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    const entry = result.get('src/g.cs');
    expect(entry?.hasUnattributedChanges).toBe(true);
    expect(entry?.changedSymbols.size).toBe(0);
  });

  it('a file with NO node in the graph at all → hasUnattributedChanges (no ranges to consult)', () => {
    const graph = makeGraph({});
    const diff = `
diff --git a/src/unknown.ts b/src/unknown.ts
--- a/src/unknown.ts
+++ b/src/unknown.ts
@@ -1,1 +1,1 @@
-old();
+new();
`;
    const result = computeChangedSymbolsComplete(diff, graph);
    expect(result.get('src/unknown.ts')?.hasUnattributedChanges).toBe(true);
  });
});
