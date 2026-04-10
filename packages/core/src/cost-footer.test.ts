import { describe, expect, it } from "vitest";
import {
	MODEL_PRICING,
	calculateReviewCost,
	formatCostFooter,
	getModelPricing,
} from "./cost-footer.js";

// ── getModelPricing ──

describe("getModelPricing", () => {
	it("finds direct match", () => {
		const p = getModelPricing("gpt-4o");
		expect(p).not.toBeNull();
		expect(p!.inputPerMTok).toBe(2.5);
	});

	it("finds prefix match for versioned models", () => {
		const p = getModelPricing("claude-sonnet-4-20250514");
		expect(p).not.toBeNull();
		expect(p!.inputPerMTok).toBe(3);
	});

	it("finds anthropic opus", () => {
		expect(getModelPricing("claude-opus-4-6")).not.toBeNull();
	});

	it("returns null for unknown model", () => {
		expect(getModelPricing("unknown-model-xyz")).toBeNull();
	});

	it("covers major providers", () => {
		expect(Object.keys(MODEL_PRICING).length).toBeGreaterThanOrEqual(10);
	});
});

// ── calculateReviewCost ──

describe("calculateReviewCost", () => {
	it("estimates cost with 70/30 split", () => {
		const cost = calculateReviewCost(100_000, "claude-sonnet-4-20250514");
		expect(cost.pricingFound).toBe(true);
		expect(cost.estimatedInputTokens).toBe(70_000);
		expect(cost.estimatedOutputTokens).toBe(30_000);
		// 70K * $3/M + 30K * $15/M = $0.21 + $0.45 = $0.66
		expect(cost.costUSD).toBeCloseTo(0.66, 1);
	});

	it("uses explicit input/output when provided", () => {
		const cost = calculateReviewCost(100_000, "gpt-4o", {
			inputTokens: 90_000,
			outputTokens: 10_000,
		});
		// 90K * $2.5/M + 10K * $10/M = $0.225 + $0.1 = $0.325
		expect(cost.costUSD).toBeCloseTo(0.325, 2);
	});

	it("returns 0 cost for free tier models", () => {
		const cost = calculateReviewCost(50_000, "llama-3");
		expect(cost.costUSD).toBe(0);
		expect(cost.pricingFound).toBe(true);
	});

	it("returns 0 cost and pricingFound=false for unknown model", () => {
		const cost = calculateReviewCost(50_000, "unknown-model");
		expect(cost.costUSD).toBe(0);
		expect(cost.pricingFound).toBe(false);
	});

	it("opus costs more than sonnet for same tokens", () => {
		const opus = calculateReviewCost(100_000, "claude-opus-4-6");
		const sonnet = calculateReviewCost(100_000, "claude-sonnet-4-20250514");
		expect(opus.costUSD).toBeGreaterThan(sonnet.costUSD);
	});

	it("handles 0 tokens", () => {
		const cost = calculateReviewCost(0, "gpt-4o");
		expect(cost.costUSD).toBe(0);
		expect(cost.totalTokens).toBe(0);
	});
});

// ── formatCostFooter ──

describe("formatCostFooter", () => {
	it("formats with cost for known model", () => {
		const cost = calculateReviewCost(100_000, "claude-sonnet-4-20250514");
		const footer = formatCostFooter(cost);
		expect(footer).toContain("100K tokens");
		expect(footer).toContain("$");
		expect(footer).toContain("claude-sonnet-4-20250514");
	});

	it("shows 'pricing unavailable' for unknown model", () => {
		const cost = calculateReviewCost(50_000, "unknown-model");
		const footer = formatCostFooter(cost);
		expect(footer).toContain("pricing unavailable");
		expect(footer).toContain("50K tokens");
	});

	it("shows 'free tier' for zero-cost models", () => {
		const cost = calculateReviewCost(50_000, "llama-3");
		const footer = formatCostFooter(cost);
		expect(footer).toContain("free tier");
	});

	it("returns empty string for 0 tokens (static-only)", () => {
		const cost = calculateReviewCost(0, "gpt-4o");
		expect(formatCostFooter(cost)).toBe("");
	});

	it("formats M tokens for large reviews", () => {
		const cost = calculateReviewCost(2_500_000, "claude-opus-4-6");
		const footer = formatCostFooter(cost);
		expect(footer).toContain("2.5M tokens");
	});

	it("uses sub tag for clean PR rendering", () => {
		const cost = calculateReviewCost(10_000, "gpt-4o");
		const footer = formatCostFooter(cost);
		expect(footer).toContain("<sub>");
		expect(footer).toContain("</sub>");
	});
});
