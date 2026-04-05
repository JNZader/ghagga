import { describe, expect, it } from "vitest";
import { detectFlood } from "./index.js";

describe("detectFlood", () => {
	const base = {
		authorLogin: "alice",
		prTitle: "Refactor authentication layer",
		prBody: "This PR refactors the authentication layer to use JWT tokens.",
		linesChanged: 100,
		recentPrCount: 1,
	};

	it("returns full recommendation for clean PRs", () => {
		const result = detectFlood(base);
		expect(result.isFlood).toBe(false);
		expect(result.signals).toHaveLength(0);
		expect(result.recommendation).toBe("full");
	});

	it("detects [bot] suffix and recommends skip", () => {
		const result = detectFlood({ ...base, authorLogin: "dependabot[bot]" });
		expect(result.isFlood).toBe(true);
		expect(result.recommendation).toBe("skip");
		expect(result.signals[0]?.type).toBe("bot");
		expect(result.signals[0]?.confidence).toBe(1.0);
	});

	it("detects bot suffix without brackets and recommends skip", () => {
		const result = detectFlood({ ...base, authorLogin: "renovatebot" });
		expect(result.isFlood).toBe(true);
		expect(result.recommendation).toBe("skip");
		expect(result.signals[0]?.type).toBe("bot");
	});

	it("detects mass PRs (recentPrCount > 5) and recommends lightweight", () => {
		const result = detectFlood({ ...base, recentPrCount: 10 });
		expect(result.isFlood).toBe(true);
		expect(result.recommendation).toBe("lightweight");
		const signal = result.signals.find((s) => s.type === "mass_prs");
		expect(signal).toBeDefined();
		expect(signal?.confidence).toBe(0.9);
	});

	it("does NOT flag recentPrCount exactly at threshold (5)", () => {
		const result = detectFlood({ ...base, recentPrCount: 5 });
		expect(result.signals.find((s) => s.type === "mass_prs")).toBeUndefined();
	});

	it("detects huge diff (linesChanged > 5000) and recommends lightweight", () => {
		const result = detectFlood({ ...base, linesChanged: 6000 });
		expect(result.isFlood).toBe(true);
		expect(result.recommendation).toBe("lightweight");
		const signal = result.signals.find((s) => s.type === "huge_diff");
		expect(signal).toBeDefined();
		expect(signal?.confidence).toBe(0.8);
	});

	it("does NOT flag huge_diff at exactly 5000 lines", () => {
		const result = detectFlood({ ...base, linesChanged: 5000 });
		expect(result.signals.find((s) => s.type === "huge_diff")).toBeUndefined();
	});

	it("detects empty description with generic title and recommends lightweight", () => {
		const result = detectFlood({
			...base,
			prBody: null,
			prTitle: "fix authentication",
		});
		expect(result.isFlood).toBe(true);
		expect(result.recommendation).toBe("lightweight");
		const signal = result.signals.find((s) => s.type === "empty_description");
		expect(signal).toBeDefined();
		expect(signal?.confidence).toBe(0.7);
	});

	it("does NOT flag empty description when title is descriptive", () => {
		const result = detectFlood({
			...base,
			prBody: null,
			prTitle: "Refactor the entire authentication flow to use stateless JWT tokens",
		});
		expect(result.signals.find((s) => s.type === "empty_description")).toBeUndefined();
	});

	it("does NOT flag empty description when body is present", () => {
		const result = detectFlood({
			...base,
			prBody: "This PR fixes a critical bug",
			prTitle: "fix bug",
		});
		expect(result.signals.find((s) => s.type === "empty_description")).toBeUndefined();
	});

	it("bot takes priority over other signals for recommendation", () => {
		const result = detectFlood({
			...base,
			authorLogin: "dependabot[bot]",
			recentPrCount: 20,
			linesChanged: 10000,
		});
		expect(result.recommendation).toBe("skip");
		expect(result.signals.length).toBeGreaterThanOrEqual(2);
	});

	it("accumulates multiple non-bot signals", () => {
		const result = detectFlood({
			...base,
			recentPrCount: 10,
			linesChanged: 6000,
		});
		expect(result.signals.length).toBeGreaterThanOrEqual(2);
		expect(result.recommendation).toBe("lightweight");
	});
});
