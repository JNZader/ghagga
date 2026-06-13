import { describe, expect, it } from 'vitest';
import { type EntityChangeKind, extractSemanticDiff } from './index.js';

// ─── Sample Diffs ────────────────────────────────────────────────

const DIFF_FUNCTION_ADDED = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,8 @@
 export const x = 1;
+
+export function newHelper(input: string): string {
+  return input.trim();
+}
`;

const DIFF_FUNCTION_REMOVED = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,2 @@
 export const x = 1;
-
-export function oldHelper(input: string): string {
-  return input.trim();
-}
`;

const DIFF_FUNCTION_MODIFIED = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,5 @@
-export function processData(data: string): string {
+export function processData(data: string, opts?: Options): string {
   return data.trim();
 }
`;

const DIFF_CLASS_ADDED = `diff --git a/src/services/auth.ts b/src/services/auth.ts
index abc..def 100644
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -1,3 +1,7 @@
 import { something } from './x';
+
+class AuthService {
+  private token: string = '';
+}
`;

const DIFF_IMPORT_ADDED = `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 import { foo } from './foo';
+import { bar } from './bar';
 export { foo };
`;

const DIFF_TYPE_ADDED = `diff --git a/src/types.ts b/src/types.ts
index abc..def 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -1,3 +1,6 @@
 export type Foo = string;
+
+export interface NewConfig {
+  timeout: number;
+}
`;

const DIFF_MULTI_FILE = `diff --git a/src/a.ts b/src/a.ts
index abc..def 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
+export function alpha(): void {}
 export const x = 1;
diff --git a/src/b.ts b/src/b.ts
index ghi..jkl 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
-export function beta(): void {}
+export function beta(opts: Options): void {}
`;

// ─── Tests ───────────────────────────────────────────────────────

describe('extractSemanticDiff — function_added', () => {
  it('detects a new function in added lines', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_ADDED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('function_added' as EntityChangeKind);
  });

  it('sets correct name for added function', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_ADDED);
    const fn = result.changes.find((c) => c.kind === 'function_added');
    expect(fn?.name).toBe('newHelper');
  });

  it('includes file path', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_ADDED);
    expect(result.changes[0]?.filePath).toContain('foo.ts');
  });
});

describe('extractSemanticDiff — function_removed', () => {
  it('detects a removed function', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_REMOVED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('function_removed' as EntityChangeKind);
  });

  it('sets correct name for removed function', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_REMOVED);
    const fn = result.changes.find((c) => c.kind === 'function_removed');
    expect(fn?.name).toBe('oldHelper');
  });
});

describe('extractSemanticDiff — function_modified', () => {
  it('detects a modified function (same name, changed signature)', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_MODIFIED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('function_modified' as EntityChangeKind);
  });

  it('includes both old and new signatures', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_MODIFIED);
    const fn = result.changes.find((c) => c.kind === 'function_modified');
    expect(fn?.oldSignature).toContain('processData(data: string)');
    expect(fn?.newSignature).toContain('processData(data: string, opts');
  });
});

describe('extractSemanticDiff — class_added', () => {
  it('detects a new class', () => {
    const result = extractSemanticDiff(DIFF_CLASS_ADDED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('class_added' as EntityChangeKind);
  });

  it('captures class name', () => {
    const result = extractSemanticDiff(DIFF_CLASS_ADDED);
    const cls = result.changes.find((c) => c.kind === 'class_added');
    expect(cls?.name).toBe('AuthService');
  });
});

describe('extractSemanticDiff — import_added', () => {
  it('detects an added import', () => {
    const result = extractSemanticDiff(DIFF_IMPORT_ADDED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('import_added' as EntityChangeKind);
  });

  it('summary reports ONLY "1 import added" — no phantom "1 import modified" (double-count bug)', () => {
    const result = extractSemanticDiff(DIFF_IMPORT_ADDED);
    expect(result.summary).toBe('1 import added');
  });
});

describe('extractSemanticDiff — import_modified', () => {
  const DIFF_IMPORT_MODIFIED = `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,2 @@
-import { foo } from './foo';
+import { foo, baz } from './foo';
 export { foo };
`;

  it('reports a changed import line (same module) as import_modified, not import_removed', () => {
    const result = extractSemanticDiff(DIFF_IMPORT_MODIFIED);
    expect(result.changes.map((c) => c.kind)).toEqual(['import_modified' as EntityChangeKind]);
    expect(result.changes[0]?.oldSignature).toBe("import { foo } from './foo';");
    expect(result.changes[0]?.newSignature).toBe("import { foo, baz } from './foo';");
    expect(result.summary).toBe('1 import modified');
  });
});

describe('extractSemanticDiff — export_added / export_modified', () => {
  const DIFF_EXPORT_ADDED = `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,2 @@
 const x = 1;
+export const VERSION = '1.0';
`;

  const DIFF_EXPORT_MODIFIED = `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,1 @@
-export const VERSION = '1.0';
+export const VERSION = '2.0';
`;

  it('summary reports ONLY "1 export added" — no phantom "1 export modified" (double-count bug)', () => {
    const result = extractSemanticDiff(DIFF_EXPORT_ADDED);
    expect(result.changes.map((c) => c.kind)).toEqual(['export_added' as EntityChangeKind]);
    expect(result.summary).toBe('1 export added');
  });

  it('reports a changed plain export (same name) as export_modified, not export_removed', () => {
    const result = extractSemanticDiff(DIFF_EXPORT_MODIFIED);
    expect(result.changes.map((c) => c.kind)).toEqual(['export_modified' as EntityChangeKind]);
    expect(result.summary).toBe('1 export modified');
  });
});

describe('extractSemanticDiff — class_modified', () => {
  const DIFF_CLASS_MODIFIED = `diff --git a/src/services/auth.ts b/src/services/auth.ts
index abc..def 100644
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -1,3 +1,3 @@
-export class AuthService {
+export class AuthService extends BaseService {
   private token: string = '';
 }
`;

  it('reports a modified class as class_modified, not function_modified', () => {
    const result = extractSemanticDiff(DIFF_CLASS_MODIFIED);
    const cls = result.changes.find((c) => c.name === 'AuthService');
    expect(cls?.kind).toBe('class_modified' as EntityChangeKind);
    expect(cls?.oldSignature).toBe('export class AuthService {');
    expect(cls?.newSignature).toBe('export class AuthService extends BaseService {');
  });

  it('summary counts it under class, never function', () => {
    const result = extractSemanticDiff(DIFF_CLASS_MODIFIED);
    expect(result.summary).toBe('1 class modified');
  });
});

describe('extractSemanticDiff — type_added', () => {
  it('detects a new interface or type alias', () => {
    const result = extractSemanticDiff(DIFF_TYPE_ADDED);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('type_added' as EntityChangeKind);
  });
});

describe('extractSemanticDiff — multi-file diff', () => {
  it('processes multiple files independently', () => {
    const result = extractSemanticDiff(DIFF_MULTI_FILE);
    const files = [...new Set(result.changes.map((c) => c.filePath))];
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('detects function_added in first file and function_modified in second', () => {
    const result = extractSemanticDiff(DIFF_MULTI_FILE);
    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain('function_added' as EntityChangeKind);
    expect(kinds).toContain('function_modified' as EntityChangeKind);
  });
});

describe('extractSemanticDiff — summary', () => {
  it('produces a human-readable summary', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_MODIFIED);
    expect(result.summary).toMatch(/function modified/);
  });

  it("returns 'no entity-level changes detected' for empty diff", () => {
    const result = extractSemanticDiff('');
    expect(result.summary).toBe('no entity-level changes detected');
  });

  it('summary counts match actual changes', () => {
    const result = extractSemanticDiff(DIFF_FUNCTION_ADDED);
    const addedCount = result.changes.filter((c) => c.kind === 'function_added').length;
    expect(result.summary).toContain(`${addedCount} function added`);
  });
});

describe('extractSemanticDiff — empty / edge cases', () => {
  it('handles empty diff string', () => {
    const result = extractSemanticDiff('');
    expect(result.changes).toHaveLength(0);
  });

  it('handles diff with no declarations', () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # Title
+Some new paragraph text here.
`;
    const result = extractSemanticDiff(diff);
    expect(result.changes).toHaveLength(0);
  });
});

// ─── Arrow pattern tightening (wire-semantic-diff D5) ────────────
//
// The const/let/var function pattern requires `function` or a same-line `=>`.
// Both sides are pinned: parenthesized non-function initializers (casts) must
// NOT classify as functions, and legitimate arrows MUST keep being detected.

const arrowDiff = (line: string) => `diff --git a/src/arrow.ts b/src/arrow.ts
index abc..def 100644
--- a/src/arrow.ts
+++ b/src/arrow.ts
@@ -1,2 +1,3 @@
 const existing = 1;
+${line}
`;

describe('extractSemanticDiff — arrow pattern tightening', () => {
  it('does NOT classify a parenthesized cast initializer as function_added', () => {
    const result = extractSemanticDiff(
      arrowDiff(
        '  const coverageComplete = (row.metadata as { coverageComplete?: unknown } | null)',
      ),
    );
    expect(result.changes.filter((c) => c.kind.startsWith('function_'))).toHaveLength(0);
  });

  it('does NOT classify a top-level parenthesized non-function initializer as function_added', () => {
    const result = extractSemanticDiff(arrowDiff('const total = (a + b) * c;'));
    expect(result.changes).toHaveLength(0);
  });

  it('still detects a paren-params arrow: const f = (a) => ...', () => {
    const result = extractSemanticDiff(arrowDiff('const handler = (a) => a + 1;'));
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'handler' }),
    ]);
  });

  it('still detects a bare single-param arrow: const f = x => x', () => {
    const result = extractSemanticDiff(arrowDiff('const identity = x => x;'));
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'identity' }),
    ]);
  });

  it('still detects a return-type-annotated arrow: (a: string): Foo =>', () => {
    const result = extractSemanticDiff(
      arrowDiff('export const make = (a: string): Foo => ({ a });'),
    );
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'make' }),
    ]);
  });

  it('still detects an async arrow: export const handler = async (req) =>', () => {
    const result = extractSemanticDiff(
      arrowDiff('export const handler = async (req) => req.body;'),
    );
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'handler' }),
    ]);
  });

  it('still detects a function expression: const f = function () {}', () => {
    const result = extractSemanticDiff(arrowDiff('const legacy = function () { return 1; };'));
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'legacy' }),
    ]);
  });

  it('documented limitation: multiline arrow with `=>` on the next line is not detected', () => {
    const result = extractSemanticDiff(arrowDiff('const multi = (veryLongParamA, veryLongParamB)'));
    expect(result.changes.filter((c) => c.kind.startsWith('function_'))).toHaveLength(0);
  });
});

// ─── Generic arrow prefix (wire-semantic-diff B1.5) ──────────────
//
// The const-assignment function pattern accepts an OPTIONAL generic prefix
// before paren-params (`<T>(x) =>`). The prefix is `<[^(]*>` — it cannot
// contain `(` — so `<` comparisons stay out and the cast false positive
// stays closed. Both sides are pinned here.

describe('extractSemanticDiff — generic arrow prefix', () => {
  it('detects a generic arrow: const f = <T>(x: T) => x', () => {
    const result = extractSemanticDiff(arrowDiff('const identity = <T>(x: T) => x;'));
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'identity' }),
    ]);
  });

  it('detects a constrained generic arrow: const f = <T extends object>(x: T) => x', () => {
    const result = extractSemanticDiff(
      arrowDiff('export const pick = <T extends object>(x: T) => x;'),
    );
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'pick' }),
    ]);
  });

  it('detects an async generic arrow with return type: async <T>(x: T): Promise<T> =>', () => {
    const result = extractSemanticDiff(arrowDiff('const load = async <T>(x: T): Promise<T> => x;'));
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'load' }),
    ]);
  });

  it('detects a nested generic constraint without parens: <T extends Record<string, K>>', () => {
    const result = extractSemanticDiff(
      arrowDiff('const keys = <T extends Record<string, unknown>>(o: T) => Object.keys(o);'),
    );
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'function_added', name: 'keys' }),
    ]);
  });

  it('does NOT classify a `<` comparison initializer: const a = x < y', () => {
    const result = extractSemanticDiff(arrowDiff('const isSmaller = x < y;'));
    expect(result.changes).toHaveLength(0);
  });

  it('does NOT re-open the cast false positive: const x = (row.metadata as Foo).bar', () => {
    const result = extractSemanticDiff(
      arrowDiff('const meta = (row.metadata as { id?: string } | null)?.id;'),
    );
    expect(result.changes.filter((c) => c.kind.startsWith('function_'))).toHaveLength(0);
  });

  it('documented limitation: generic constraint containing parens (<T extends () => void>) is not detected', () => {
    const result = extractSemanticDiff(
      arrowDiff('const call = <T extends () => void>(cb: T) => cb();'),
    );
    expect(result.changes.filter((c) => c.kind.startsWith('function_'))).toHaveLength(0);
  });
});
