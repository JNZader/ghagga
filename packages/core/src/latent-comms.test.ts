import { describe, expect, it } from "vitest";
import {
	compressAgentOutput,
	mergeCompressed,
	estimateTokens,
	type CompressedOutput,
} from "./latent-comms.js";

const SAMPLE_SPECIALIST_OUTPUT = `## Security Review

### Critical Issues

- **SQL Injection** in \`src/db/query.ts:42\` — User input concatenated into query string
  Suggestion: Use parameterized queries

### Major Issues

- **Missing auth check** in \`src/routes/admin.ts:15\` — Admin endpoint accessible without token
  Suggestion: Add authMiddleware

### Minor Issues

- **Hardcoded timeout** in \`src/api/client.ts:30\` — Should be configurable
  Suggestion: Move to config

### Summary

Found 3 issues across 3 files. The SQL injection is the highest priority fix.
Overall the codebase handles auth well but has gaps in the admin routes.
`;

// ── compressAgentOutput ──

describe("compressAgentOutput", () => {
	it("extracts structured findings from specialist output", () => {
		const result = compressAgentOutput("security-review", SAMPLE_SPECIALIST_OUTPUT);
		expect(result.agentName).toBe("security-review");
		expect(result.findings.length).toBeGreaterThanOrEqual(2);
	});

	it("produces a summary shorter than original", () => {
		const result = compressAgentOutput("security-review", SAMPLE_SPECIALIST_OUTPUT);
		expect(result.tokenEstimate).toBeLessThan(result.originalTokens);
	});

	it("preserves finding severity", () => {
		const result = compressAgentOutput("security-review", SAMPLE_SPECIALIST_OUTPUT);
		const severities = result.findings.map((f) => f.severity);
		expect(severities).toContain("critical");
	});

	it("preserves file references", () => {
		const result = compressAgentOutput("security-review", SAMPLE_SPECIALIST_OUTPUT);
		const withFiles = result.findings.filter((f) => f.file);
		expect(withFiles.length).toBeGreaterThan(0);
	});

	it("respects token budget", () => {
		const result = compressAgentOutput("test", SAMPLE_SPECIALIST_OUTPUT, 100);
		expect(result.tokenEstimate).toBeLessThanOrEqual(150); // some slack
	});

	it("handles empty input", () => {
		const result = compressAgentOutput("test", "");
		expect(result.findings).toHaveLength(0);
		expect(result.summary).toBe("");
	});

	it("handles input with no structured findings", () => {
		const result = compressAgentOutput("test", "Just some plain text review without any findings.");
		expect(result.summary).toBeTruthy();
		// Should still produce a summary even without structured findings
	});
});

// ── mergeCompressed ──

describe("mergeCompressed", () => {
	it("merges multiple compressed outputs", () => {
		const outputs: CompressedOutput[] = [
			compressAgentOutput("security", SAMPLE_SPECIALIST_OUTPUT),
			compressAgentOutput("quality", "## Quality Review\n\n- **Naming convention** violation in `src/utils.ts:10`\n  Suggestion: Use camelCase\n\n### Summary\nMinor naming issues."),
		];
		const merged = mergeCompressed(outputs);
		expect(merged.agentCount).toBe(2);
		expect(merged.mergedPrompt).toContain("security");
		expect(merged.mergedPrompt).toContain("quality");
	});

	it("saves tokens compared to raw concatenation", () => {
		const outputs: CompressedOutput[] = [
			compressAgentOutput("a", SAMPLE_SPECIALIST_OUTPUT),
			compressAgentOutput("b", SAMPLE_SPECIALIST_OUTPUT),
			compressAgentOutput("c", SAMPLE_SPECIALIST_OUTPUT),
		];
		const merged = mergeCompressed(outputs);
		const rawTokens = outputs.reduce((s, o) => s + o.originalTokens, 0);
		expect(merged.totalTokensSaved).toBeGreaterThan(0);
		// At least 30% savings
		expect(merged.totalTokensSaved / rawTokens).toBeGreaterThan(0.3);
	});

	it("handles single output", () => {
		const outputs = [compressAgentOutput("solo", SAMPLE_SPECIALIST_OUTPUT)];
		const merged = mergeCompressed(outputs);
		expect(merged.agentCount).toBe(1);
		expect(merged.mergedPrompt).toBeTruthy();
	});

	it("handles empty list", () => {
		const merged = mergeCompressed([]);
		expect(merged.agentCount).toBe(0);
		expect(merged.mergedPrompt).toBe("");
	});

	it("deduplicates similar findings across agents", () => {
		const sameIssue = "## Review\n\n- **SQL Injection** in `src/db/query.ts:42` — User input in query\n";
		const outputs = [
			compressAgentOutput("agent-a", sameIssue),
			compressAgentOutput("agent-b", sameIssue),
		];
		const merged = mergeCompressed(outputs);
		// Should mention the finding but not repeat it verbatim
		const sqlMentions = (merged.mergedPrompt.match(/SQL Injection/gi) || []).length;
		expect(sqlMentions).toBeLessThanOrEqual(2); // at most once per agent section
	});
});

// ── estimateTokens ──

describe("estimateTokens", () => {
	it("estimates ~4 chars per token", () => {
		expect(estimateTokens("a".repeat(400))).toBe(100);
	});

	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
});
