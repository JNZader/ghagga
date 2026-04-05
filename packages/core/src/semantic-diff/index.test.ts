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
