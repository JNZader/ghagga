import { describe, expect, it } from 'vitest';
import { buildCallChainFromDiff, extractChangedSymbolsFromDiff } from './call-chain.js';

// ─── Sample Fixtures ─────────────────────────────────────────────

const SAMPLE_DIFF = `
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,7 @@ function validateToken
-function validateToken(token: string): boolean {
+function validateToken(token: string, strict: boolean): boolean {
+  if (strict) return false;
   return token.length > 0;
 }
`;

const AUTH_CONTENT = `
import { hashSecret } from "./crypto";

export function validateToken(token: string, strict: boolean): boolean {
  if (strict) return false;
  return token.length > 0;
}

export function generateToken(userId: string): string {
  return userId + "-token";
}
`;

const CONTROLLER_CONTENT = `
import { validateToken, generateToken } from "./auth";

export async function loginHandler(req: Request): Promise<void> {
  const token = generateToken(req.body.userId);
  validateToken(token, false);
}
`;

const MIDDLEWARE_CONTENT = `
import { validateToken } from "./auth";

export function authMiddleware(token: string): boolean {
  return validateToken(token, true);
}
`;

const CRYPTO_CONTENT = `
export function hashSecret(secret: string): string {
  return secret.split("").reverse().join("");
}
`;

// ─── Tests ───────────────────────────────────────────────────────

describe('buildCallChainFromDiff', () => {
  const fileContents = new Map([
    ['src/auth.ts', AUTH_CONTENT],
    ['src/controller.ts', CONTROLLER_CONTENT],
    ['src/middleware.ts', MIDDLEWARE_CONTENT],
    ['src/crypto.ts', CRYPTO_CONTENT],
  ]);

  it('returns changed symbols from diff', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

    // validateToken was changed in the diff
    const changed = result.changedSymbols.map((n) => n.symbolName);
    expect(changed).toContain('validateToken');
  });

  it('finds affected symbols that call changed symbols', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

    const affectedNames = result.affectedSymbols.map((n) => n.symbolName);
    // loginHandler calls validateToken (indirectly via generateToken chain)
    // authMiddleware calls validateToken directly
    expect(affectedNames).toContain('authMiddleware');
  });

  it('returns a graph with nodes and edges', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

    expect(result.callChainGraph.nodes.length).toBeGreaterThan(0);
    expect(result.callChainGraph.edges.length).toBeGreaterThan(0);
  });

  it('does not exceed max depth of 3', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

    expect(result.depth).toBeLessThanOrEqual(3);
  });

  it('returns empty affected symbols when nothing calls changed symbols', () => {
    const isolatedContents = new Map([
      ['src/isolated.ts', `export function standalone(): void { console.log("hello"); }`],
    ]);
    const isolatedDiff = `
--- a/src/isolated.ts
+++ b/src/isolated.ts
@@ -1 +1 @@ function standalone
-export function standalone(): void { console.log("hello"); }
+export function standalone(): void { console.log("world"); }
`;
    const result = buildCallChainFromDiff(isolatedDiff, isolatedContents);

    expect(result.affectedSymbols).toHaveLength(0);
  });

  it('identifies graph nodes by file and symbol name', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);
    const authNodes = result.callChainGraph.nodes.filter((n) => n.filePath === 'src/auth.ts');

    expect(authNodes.some((n) => n.symbolName === 'validateToken')).toBe(true);
    expect(authNodes.some((n) => n.symbolName === 'generateToken')).toBe(true);
  });

  it('returns graph edges with correct kinds', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);
    const importEdges = result.callChainGraph.edges.filter((e) => e.kind === 'imports');
    const callEdges = result.callChainGraph.edges.filter((e) => e.kind === 'calls');

    expect(importEdges.length).toBeGreaterThan(0);
    expect(callEdges.length).toBeGreaterThan(0);
  });

  it('handles empty diff gracefully', () => {
    const result = buildCallChainFromDiff('', fileContents);

    expect(result.changedSymbols).toHaveLength(0);
    expect(result.depth).toBe(0);
  });

  it('handles empty fileContents gracefully', () => {
    const result = buildCallChainFromDiff(SAMPLE_DIFF, new Map());

    expect(result.callChainGraph.nodes).toHaveLength(0);
    expect(result.callChainGraph.edges).toHaveLength(0);
  });
});

// ─── extractChangedSymbolsFromDiff (now exported for Slice 2 reuse) ─

describe('extractChangedSymbolsFromDiff', () => {
  it('extracts the changed symbol name and file from a unified diff', () => {
    const result = extractChangedSymbolsFromDiff(SAMPLE_DIFF);
    expect(result.has('src/auth.ts')).toBe(true);
    expect(result.get('src/auth.ts')).toContain('validateToken');
  });

  it('is called internally by buildCallChainFromDiff with unchanged behavior post-export', () => {
    // Cross-check: buildCallChainFromDiff's changedSymbols should match
    // exactly what a direct call to extractChangedSymbolsFromDiff reports.
    const direct = extractChangedSymbolsFromDiff(SAMPLE_DIFF);
    const viaBuild = buildCallChainFromDiff(SAMPLE_DIFF, new Map([['src/auth.ts', AUTH_CONTENT]]));

    const directNames = new Set([...(direct.get('src/auth.ts') ?? [])]);
    const builtNames = new Set(
      viaBuild.changedSymbols.filter((s) => s.filePath === 'src/auth.ts').map((s) => s.symbolName),
    );
    expect(builtNames).toEqual(directNames);
  });

  it('returns an empty map for an empty diff', () => {
    const result = extractChangedSymbolsFromDiff('');
    expect(result.size).toBe(0);
  });

  // ─── BUG 1: hunk-header symbol capture must skip modifier keywords ──

  it('hunk context "export const MAX_GRAPH_SIZE_BYTES = " captures the const name, not "export"', () => {
    const diff = `
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -5,1 +5,1 @@ export const MAX_GRAPH_SIZE_BYTES =
-export const MAX_GRAPH_SIZE_BYTES = 20 * 1024 * 1024;
+export const MAX_GRAPH_SIZE_BYTES = 25 * 1024 * 1024;
`;
    const result = extractChangedSymbolsFromDiff(diff);
    const symbols = result.get('src/schema.ts');
    expect(symbols).toContain('MAX_GRAPH_SIZE_BYTES');
    expect(symbols).not.toContain('export');
  });

  it('hunk context "export default function foo()" captures "foo"', () => {
    const diff = `
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@ export default function foo()
-export default function foo() { return 1; }
+export default function foo() { return 2; }
`;
    const result = extractChangedSymbolsFromDiff(diff);
    expect(result.get('src/foo.ts')).toContain('foo');
  });

  it('hunk context Go "func Greet(name string) string" captures "Greet", not "func"', () => {
    const diff = `
--- a/main.go
+++ b/main.go
@@ -1,3 +1,3 @@ func Greet(name string) string
-func Greet(name string) string { return "hi " + name }
+func Greet(name string) string { return "hello " + name }
`;
    const result = extractChangedSymbolsFromDiff(diff);
    const symbols = result.get('main.go');
    expect(symbols).toContain('Greet');
    expect(symbols).not.toContain('func');
  });

  it('hunk context Python "def process(self)" captures "process", not "def"', () => {
    const diff = `
--- a/module.py
+++ b/module.py
@@ -1,3 +1,3 @@ def process(self)
-def process(self): return 1
+def process(self): return 2
`;
    const result = extractChangedSymbolsFromDiff(diff);
    const symbols = result.get('module.py');
    expect(symbols).toContain('process');
    expect(symbols).not.toContain('def');
  });

  it('hunk context Rust "pub fn run()" captures "run", not "pub"', () => {
    const diff = `
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,3 @@ pub fn run()
-pub fn run() { println!("1"); }
+pub fn run() { println!("2"); }
`;
    const result = extractChangedSymbolsFromDiff(diff);
    const symbols = result.get('src/lib.rs');
    expect(symbols).toContain('run');
    expect(symbols).not.toContain('pub');
  });

  it('hunk context bare "someMethod(args) {" captures "someMethod"', () => {
    const diff = `
--- a/src/thing.ts
+++ b/src/thing.ts
@@ -1,3 +1,3 @@ someMethod(args) {
-  someMethod(1);
+  someMethod(2);
`;
    const result = extractChangedSymbolsFromDiff(diff);
    expect(result.get('src/thing.ts')).toContain('someMethod');
  });

  // ─── BUG 2: changed-line detection must cover const/let/var/type/interface/enum ──

  it('changed line "+export const RATE_LIMIT = 5" detects RATE_LIMIT', () => {
    const diff = `
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,2 @@
-export const RATE_LIMIT = 3
+export const RATE_LIMIT = 5
`;
    const result = extractChangedSymbolsFromDiff(diff);
    expect(result.get('src/config.ts')).toContain('RATE_LIMIT');
  });

  it('changed line "+export type Foo = ..." detects Foo', () => {
    const diff = `
--- a/src/types.ts
+++ b/src/types.ts
@@ -1,2 +1,2 @@
-export type Foo = string
+export type Foo = string | number
`;
    const result = extractChangedSymbolsFromDiff(diff);
    expect(result.get('src/types.ts')).toContain('Foo');
  });

  it('changed line "+export interface Bar {" detects Bar', () => {
    const diff = `
--- a/src/types.ts
+++ b/src/types.ts
@@ -1,2 +1,2 @@
-export interface Bar {
+export interface Bar {
`;
    const result = extractChangedSymbolsFromDiff(diff);
    expect(result.get('src/types.ts')).toContain('Bar');
  });

  it('changed line function/class declarations still detected (no regression)', () => {
    const fnDiff = `
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-export function foo() {}
+export function foo(x: number) {}
`;
    expect(extractChangedSymbolsFromDiff(fnDiff).get('src/a.ts')).toContain('foo');

    const clsDiff = `
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-export class Baz {}
+export class Baz { x = 1; }
`;
    expect(extractChangedSymbolsFromDiff(clsDiff).get('src/b.ts')).toContain('Baz');
  });

  it('does NOT falsely add a mid-expression "const local = helper()" as a top-level changed symbol', () => {
    const diff = `
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,3 +1,3 @@ export function wrapper()
 export function wrapper() {
-  const local = helper1();
+  const local = helper2();
 }
`;
    const result = extractChangedSymbolsFromDiff(diff);
    const symbols = result.get('src/c.ts');
    expect(symbols).not.toContain('local');
  });
});
