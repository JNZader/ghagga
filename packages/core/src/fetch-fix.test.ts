import { describe, expect, it } from "vitest";
import {
	createAutoFixer,
	extractSuggestion,
	fetchAndFix,
	formatFetchFixReport,
	groupByFile,
	isAutoFixable,
	parseCommentSeverity,
	parseFixRequest,
	type ReviewComment,
} from "./fetch-fix.js";

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
	return {
		id: 1,
		body: "This looks wrong",
		path: "src/app.ts",
		line: 10,
		author: "reviewer",
		createdAt: "2026-01-01T00:00:00Z",
		resolved: false,
		...overrides,
	};
}

// ── Severity parsing ──

describe("parseCommentSeverity", () => {
	it("detects critical from security keyword", () => {
		expect(parseCommentSeverity("This is a security vulnerability")).toBe("critical");
	});

	it("detects major from bug keyword", () => {
		expect(parseCommentSeverity("This will cause a bug in production")).toBe("major");
	});

	it("detects nit from nit keyword", () => {
		expect(parseCommentSeverity("nit: rename this variable")).toBe("nit");
	});

	it("defaults to minor", () => {
		expect(parseCommentSeverity("Maybe change this")).toBe("minor");
	});
});

// ── Suggestion extraction ──

describe("extractSuggestion", () => {
	it("extracts suggestion block", () => {
		const body = "Fix this:\n```suggestion\nconst x = 42;\n```\nThanks";
		expect(extractSuggestion(body)).toBe("const x = 42;");
	});

	it("returns null when no suggestion", () => {
		expect(extractSuggestion("Just a comment")).toBeNull();
	});
});

// ── Auto-fixable detection ──

describe("isAutoFixable", () => {
	it("true when has suggestion block", () => {
		const comment = makeComment({
			body: "Fix:\n```suggestion\nnew code\n```",
		});
		expect(isAutoFixable(comment)).toBe(true);
	});

	it("false when no suggestion", () => {
		expect(isAutoFixable(makeComment())).toBe(false);
	});
});

// ── Fix request parsing ──

describe("parseFixRequest", () => {
	it("parses comment into fix request", () => {
		const comment = makeComment({
			body: "security: This endpoint is exposed\n```suggestion\nauth(req)\n```",
			path: "src/routes.ts",
			line: 42,
		});
		const req = parseFixRequest(comment);
		expect(req.file).toBe("src/routes.ts");
		expect(req.line).toBe(42);
		expect(req.severity).toBe("critical");
		expect(req.autoFixable).toBe(true);
		expect(req.suggestedFix).toBe("auth(req)");
	});
});

// ── Group by file ──

describe("groupByFile", () => {
	it("groups requests by file", () => {
		const requests = [
			parseFixRequest(makeComment({ path: "a.ts", id: 1 })),
			parseFixRequest(makeComment({ path: "b.ts", id: 2 })),
			parseFixRequest(makeComment({ path: "a.ts", id: 3 })),
		];
		const groups = groupByFile(requests);
		expect(groups.size).toBe(2);
		expect(groups.get("a.ts")).toHaveLength(2);
		expect(groups.get("b.ts")).toHaveLength(1);
	});
});

// ── Auto fixer ──

describe("createAutoFixer", () => {
	it("fixes comments with suggestions", () => {
		const fixer = createAutoFixer();
		const results = fixer("src/app.ts", [
			{
				commentId: 1,
				file: "src/app.ts",
				line: 10,
				issue: "Fix this",
				suggestedFix: "const x = 42;",
				severity: "minor",
				autoFixable: true,
			},
		]);
		expect(results[0]!.status).toBe("fixed");
	});

	it("marks non-fixable as manual", () => {
		const fixer = createAutoFixer();
		const results = fixer("src/app.ts", [
			{
				commentId: 2,
				file: "src/app.ts",
				line: 20,
				issue: "Refactor this",
				suggestedFix: null,
				severity: "major",
				autoFixable: false,
			},
		]);
		expect(results[0]!.status).toBe("manual");
	});
});

// ── Integration ──

describe("fetchAndFix", () => {
	it("processes comments end-to-end", async () => {
		const comments: ReviewComment[] = [
			makeComment({
				id: 1,
				body: "nit: rename\n```suggestion\nconst renamed = true;\n```",
				path: "src/a.ts",
			}),
			makeComment({
				id: 2,
				body: "This needs refactoring",
				path: "src/b.ts",
			}),
			makeComment({
				id: 3,
				body: "Already done",
				path: "src/c.ts",
				resolved: true,
			}),
		];

		const report = await fetchAndFix(comments, createAutoFixer(), 42);
		expect(report.prNumber).toBe(42);
		expect(report.totalComments).toBe(3);
		expect(report.fixRequests).toHaveLength(2); // resolved one excluded
		expect(report.fixedCount).toBe(1); // only the suggestion one
		expect(report.manualCount).toBe(1); // the refactoring one
	});

	it("handles empty comments", async () => {
		const report = await fetchAndFix([], createAutoFixer(), 1);
		expect(report.fixRequests).toHaveLength(0);
		expect(report.fixedCount).toBe(0);
	});
});

// ── Formatting ──

describe("formatFetchFixReport", () => {
	it("shows summary", async () => {
		const report = await fetchAndFix(
			[
				makeComment({
					body: "fix\n```suggestion\nnew\n```",
					path: "a.ts",
				}),
			],
			createAutoFixer(),
			99,
		);
		const text = formatFetchFixReport(report);
		expect(text).toContain("PR #99");
		expect(text).toContain("Auto-fixed");
	});

	it("shows no comments message", async () => {
		const report = await fetchAndFix([], createAutoFixer(), 1);
		const text = formatFetchFixReport(report);
		expect(text).toContain("No unresolved comments");
	});
});
