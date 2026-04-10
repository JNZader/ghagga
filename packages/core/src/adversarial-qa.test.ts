import { describe, expect, it } from "vitest";
import {
	formatQAResult,
	runQALoop,
	type CriticFn,
	type CriticResult,
	type FixerFn,
} from "./adversarial-qa.js";

// ── Mock functions ──

function makeCritic(scores: number[]): CriticFn {
	let call = 0;
	return () => {
		const score = scores[call] ?? scores[scores.length - 1]!;
		call++;
		return {
			score,
			issues:
				score < 80
					? [
							{
								id: `issue-${call}`,
								severity: "major" as const,
								description: `Issue from round ${call}`,
								resolved: false,
							},
						]
					: [],
			summary: `Score: ${score}`,
		};
	};
}

function makeFixer(resolveCount: number): FixerFn {
	return (content, issues) => ({
		content: content + "\n// fixed",
		result: {
			issuesAttempted: issues.length,
			issuesResolved: Math.min(resolveCount, issues.length),
			changes: issues.slice(0, resolveCount).map((i) => ({
				issueId: i.id,
				action: "fixed",
			})),
		},
	});
}

// ── Tests ──

describe("runQALoop", () => {
	it("passes on first round when score is high", async () => {
		const result = await runQALoop(
			"good code",
			makeCritic([90]),
			makeFixer(0),
		);
		assert(result.passed);
		assert(result.rounds.length === 1);
		assert(result.finalScore === 90);
	});

	it("iterates until score passes", async () => {
		const result = await runQALoop(
			"bad code",
			makeCritic([40, 60, 85]),
			makeFixer(1),
		);
		assert(result.passed);
		assert(result.finalScore === 85);
		assert(result.rounds.length === 3);
	});

	it("stops at max rounds", async () => {
		const result = await runQALoop(
			"terrible code",
			makeCritic([20, 30, 40]),
			makeFixer(1),
			{ maxRounds: 3, passThreshold: 80, stopOnNoProgress: false },
		);
		assert(!result.passed);
		assert(result.rounds.length === 3);
	});

	it("stops early when no progress", async () => {
		const result = await runQALoop(
			"stuck code",
			makeCritic([30, 30, 30]),
			makeFixer(0), // resolves nothing
			{ maxRounds: 5, passThreshold: 80, stopOnNoProgress: true },
		);
		assert(!result.passed);
		// Should stop after round 1 (critic + fixer with 0 resolved)
		assert(result.rounds.length <= 2);
	});

	it("tracks total issues found and resolved", async () => {
		const result = await runQALoop(
			"code",
			makeCritic([50, 85]),
			makeFixer(1),
		);
		expect(result.totalIssuesFound).toBeGreaterThan(0);
		expect(result.totalIssuesResolved).toBeGreaterThan(0);
	});

	it("fixer result is null on final round", async () => {
		const result = await runQALoop(
			"code",
			makeCritic([90]),
			makeFixer(1),
		);
		expect(result.rounds[0]!.fixerResult).toBeNull();
	});
});

describe("formatQAResult", () => {
	it("shows PASSED for passing result", async () => {
		const result = await runQALoop("code", makeCritic([90]), makeFixer(0));
		const text = formatQAResult(result);
		expect(text).toContain("PASSED");
		expect(text).toContain("90/100");
	});

	it("shows FAILED for failing result", async () => {
		const result = await runQALoop(
			"code",
			makeCritic([30]),
			makeFixer(0),
			{ maxRounds: 1, passThreshold: 80, stopOnNoProgress: false },
		);
		const text = formatQAResult(result);
		expect(text).toContain("FAILED");
	});

	it("shows round details", async () => {
		const result = await runQALoop(
			"code",
			makeCritic([50, 85]),
			makeFixer(1),
		);
		const text = formatQAResult(result);
		expect(text).toContain("Round 1");
		expect(text).toContain("Round 2");
	});
});

function assert(condition: boolean, msg?: string) {
	expect(condition).toBe(true);
}
