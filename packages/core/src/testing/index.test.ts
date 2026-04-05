import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewInput, ReviewResult } from "../types.js";
import { assertTrace, loadTrace, recordTrace, type ReviewTrace } from "./index.js";

// ─── Fixture helpers ─────────────────────────────────────────────

function makeMinimalInput(): ReviewInput {
	return {
		diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
		mode: "simple",
		settings: {
			enableSemgrep: false,
			enableTrivy: false,
			enableCpd: false,
			enableMemory: false,
			customRules: [],
			ignorePatterns: [],
			reviewLevel: "normal",
		},
	};
}

function makeMinimalResult(): ReviewResult {
	return {
		status: "PASSED",
		summary: "No issues found.",
		findings: [
			{
				severity: "high",
				category: "security",
				file: "src/auth.ts",
				message: "Possible SQL injection in query builder",
				source: "ai",
			},
			{
				severity: "low",
				category: "style",
				file: "src/utils.ts",
				message: "Prefer const over let",
				source: "semgrep",
			},
		],
		staticAnalysis: {
			semgrep: { status: "skipped", findings: [], executionTimeMs: 0 },
			trivy: { status: "skipped", findings: [], executionTimeMs: 0 },
			cpd: { status: "skipped", findings: [], executionTimeMs: 0 },
		},
		memoryContext: null,
		metadata: {
			mode: "simple",
			provider: "none",
			model: "static-only",
			tokensUsed: 0,
			executionTimeMs: 100,
			toolsRun: [],
			toolsSkipped: [],
		},
	};
}

function makeTrace(overrides: Partial<ReviewTrace> = {}): ReviewTrace {
	return {
		input: makeMinimalInput(),
		output: makeMinimalResult(),
		recordedAt: new Date().toISOString(),
		label: "test-trace",
		...overrides,
	};
}

// ─── recordTrace / loadTrace round-trip ─────────────────────────

describe("recordTrace + loadTrace", () => {
	it("persists and restores a trace with correct fields", async () => {
		const trace = makeTrace({ label: "round-trip-test" });
		const path = join(tmpdir(), `ghagga-trace-${Date.now()}.json`);

		await recordTrace(trace, path);
		const loaded = await loadTrace(path);

		expect(loaded.label).toBe("round-trip-test");
		expect(loaded.output.status).toBe("PASSED");
		expect(loaded.output.findings).toHaveLength(2);
	});

	it("throws when loading a non-existent file", async () => {
		await expect(loadTrace("/tmp/does-not-exist-ghagga.json")).rejects.toThrow();
	});
});

// ─── assertTrace ────────────────────────────────────────────────

describe("assertTrace — mustFind", () => {
	it("passes when required finding is present by category", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "security finding",
				mustFind: [{ category: "security" }],
			},
		]);
		expect(result.passed).toBe(true);
		expect(result.failures).toHaveLength(0);
	});

	it("passes when required finding matches all provided matchers", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "exact finding",
				mustFind: [
					{
						filePath: "src/auth.ts",
						category: "security",
						severity: "high",
						messageContains: "SQL injection",
					},
				],
			},
		]);
		expect(result.passed).toBe(true);
	});

	it("fails when required finding is missing", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "missing finding",
				mustFind: [{ category: "performance" }],
			},
		]);
		expect(result.passed).toBe(false);
		expect(result.failures[0]).toContain("mustFind");
		expect(result.failures[0]).toContain("missing finding");
	});
});

describe("assertTrace — mustNotFind", () => {
	it("passes when forbidden finding is absent", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "no performance",
				mustFind: [{ category: "security" }],
				mustNotFind: [{ category: "performance" }],
			},
		]);
		expect(result.passed).toBe(true);
	});

	it("fails when forbidden finding is present", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "no style findings allowed",
				mustFind: [{ category: "security" }],
				mustNotFind: [{ category: "style" }],
			},
		]);
		expect(result.passed).toBe(false);
		expect(result.failures[0]).toContain("mustNotFind");
	});

	it("collects multiple failures at once", async () => {
		const trace = makeTrace();
		const result = await assertTrace(trace, [
			{
				label: "multiple failures",
				mustFind: [{ category: "performance" }, { category: "bug" }],
				mustNotFind: [{ category: "style" }],
			},
		]);
		expect(result.passed).toBe(false);
		// 2 mustFind failures + 1 mustNotFind failure
		expect(result.failures.length).toBeGreaterThanOrEqual(3);
	});
});
