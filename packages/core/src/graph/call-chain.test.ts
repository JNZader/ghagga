import { describe, expect, it } from "vitest";
import { buildCallChainFromDiff } from "./call-chain.js";

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

describe("buildCallChainFromDiff", () => {
	const fileContents = new Map([
		["src/auth.ts", AUTH_CONTENT],
		["src/controller.ts", CONTROLLER_CONTENT],
		["src/middleware.ts", MIDDLEWARE_CONTENT],
		["src/crypto.ts", CRYPTO_CONTENT],
	]);

	it("returns changed symbols from diff", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

		// validateToken was changed in the diff
		const changed = result.changedSymbols.map((n) => n.symbolName);
		expect(changed).toContain("validateToken");
	});

	it("finds affected symbols that call changed symbols", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

		const affectedNames = result.affectedSymbols.map((n) => n.symbolName);
		// loginHandler calls validateToken (indirectly via generateToken chain)
		// authMiddleware calls validateToken directly
		expect(affectedNames).toContain("authMiddleware");
	});

	it("returns a graph with nodes and edges", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

		expect(result.callChainGraph.nodes.length).toBeGreaterThan(0);
		expect(result.callChainGraph.edges.length).toBeGreaterThan(0);
	});

	it("does not exceed max depth of 3", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);

		expect(result.depth).toBeLessThanOrEqual(3);
	});

	it("returns empty affected symbols when nothing calls changed symbols", () => {
		const isolatedContents = new Map([
			["src/isolated.ts", `export function standalone(): void { console.log("hello"); }`],
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

	it("identifies graph nodes by file and symbol name", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);
		const authNodes = result.callChainGraph.nodes.filter((n) => n.filePath === "src/auth.ts");

		expect(authNodes.some((n) => n.symbolName === "validateToken")).toBe(true);
		expect(authNodes.some((n) => n.symbolName === "generateToken")).toBe(true);
	});

	it("returns graph edges with correct kinds", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, fileContents);
		const importEdges = result.callChainGraph.edges.filter((e) => e.kind === "imports");
		const callEdges = result.callChainGraph.edges.filter((e) => e.kind === "calls");

		expect(importEdges.length).toBeGreaterThan(0);
		expect(callEdges.length).toBeGreaterThan(0);
	});

	it("handles empty diff gracefully", () => {
		const result = buildCallChainFromDiff("", fileContents);

		expect(result.changedSymbols).toHaveLength(0);
		expect(result.depth).toBe(0);
	});

	it("handles empty fileContents gracefully", () => {
		const result = buildCallChainFromDiff(SAMPLE_DIFF, new Map());

		expect(result.callChainGraph.nodes).toHaveLength(0);
		expect(result.callChainGraph.edges).toHaveLength(0);
	});
});
