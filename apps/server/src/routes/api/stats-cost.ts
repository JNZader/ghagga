/**
 * Cost stats API route:
 *   GET /api/v1/stats/cost?period=7d
 *
 * Returns aggregated token and review counts broken down by model, mode,
 * and repository for the requested time window.
 */

import type { Database } from "ghagga-db";
import { getReviewCostStats } from "ghagga-db";
import { Hono } from "hono";
import type { AuthUser } from "../../middleware/auth.js";
import { generateErrorId, logger } from "./utils.js";

// ─── Types ───────────────────────────────────────────────────────

type Period = "7d" | "30d" | "90d";

interface CostStats {
	period: Period;
	totalTokens: number;
	totalReviews: number;
	byModel: Record<string, { tokens: number; reviews: number }>;
	byMode: Record<string, { tokens: number; reviews: number }>;
	byRepo: Array<{ fullName: string; tokens: number; reviews: number }>;
	estimatedCostUsd: number;
}

const PERIOD_DAYS: Record<Period, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
};

// ─── Router factory ──────────────────────────────────────────────

export function createStatsCostRouter(db: Database) {
	const router = new Hono();

	// ── GET /api/v1/stats/cost ─────────────────────────────────
	router.get("/api/v1/stats/cost", async (c) => {
		const user = c.get("user") as AuthUser;
		const rawPeriod = (c.req.query("period") ?? "7d") as string;

		if (!["7d", "30d", "90d"].includes(rawPeriod)) {
			return c.json(
				{
					error: "VALIDATION_ERROR",
					message: "Invalid period. Allowed values: 7d, 30d, 90d",
				},
				400,
			);
		}

		const period = rawPeriod as Period;
		const days = PERIOD_DAYS[period];

		try {
			const rows = await getReviewCostStats(db, user.installationIds, days);

			if (rows.length === 0) {
				const empty: CostStats = {
					period,
					totalTokens: 0,
					totalReviews: 0,
					byModel: {},
					byMode: {},
					byRepo: [],
					estimatedCostUsd: 0,
				};
				return c.json({ data: empty });
			}

			// ── Pivot rows into the response shape ─────────────────
			let totalTokens = 0;
			let totalReviews = 0;
			const byModel: Record<string, { tokens: number; reviews: number }> = {};
			const byMode: Record<string, { tokens: number; reviews: number }> = {};
			const byRepoMap = new Map<string, { tokens: number; reviews: number }>();

			for (const row of rows) {
				totalTokens += row.tokens;
				totalReviews += row.count;

				// by model
				if (row.model) {
					const m = byModel[row.model] ?? { tokens: 0, reviews: 0 };
					m.tokens += row.tokens;
					m.reviews += row.count;
					byModel[row.model] = m;
				}

				// by mode
				const mode = byMode[row.mode] ?? { tokens: 0, reviews: 0 };
				mode.tokens += row.tokens;
				mode.reviews += row.count;
				byMode[row.mode] = mode;

				// by repo
				const repo = byRepoMap.get(row.fullName) ?? { tokens: 0, reviews: 0 };
				repo.tokens += row.tokens;
				repo.reviews += row.count;
				byRepoMap.set(row.fullName, repo);
			}

			const byRepo = Array.from(byRepoMap.entries())
				.map(([fullName, stats]) => ({ fullName, ...stats }))
				.sort((a, b) => b.tokens - a.tokens);

			const result: CostStats = {
				period,
				totalTokens,
				totalReviews,
				byModel,
				byMode,
				byRepo,
				estimatedCostUsd: (totalTokens / 1_000_000) * 3,
			};

			return c.json({ data: result });
		} catch (err) {
			const errorId = generateErrorId();
			logger.error({ err, errorId, user: user.githubLogin }, "Failed to fetch cost stats");
			return c.json(
				{ error: "FETCH_FAILED", message: "Failed to fetch cost stats", errorId },
				500,
			);
		}
	});

	return router;
}
