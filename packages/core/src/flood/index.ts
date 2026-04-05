/**
 * Flood / spam PR detection.
 *
 * Inspects lightweight PR metadata and returns a FloodResult that tells
 * the pipeline whether to skip, run a lightweight review, or run a full
 * review.  No network calls — pure computation.
 */

export interface FloodSignal {
	type: "bot" | "mass_prs" | "empty_description" | "huge_diff";
	confidence: number;
	detail: string;
}

export interface FloodResult {
	isFlood: boolean;
	signals: FloodSignal[];
	recommendation: "skip" | "lightweight" | "full";
}

const BOT_SUFFIX_RE = /(\[bot\]|bot)$/i;
const EMPTY_TITLE_RE = /^(update|fix|change|add|remove)\s+\S+\s*$/i;

/**
 * Analyse PR metadata and return a FloodResult.
 *
 * Decision rules (applied in order, most severe wins):
 *  1. Bot author        → confidence 1.0, recommendation "skip"
 *  2. Mass PRs (> 5)    → confidence 0.9, recommendation "lightweight"
 *  3. Huge diff (> 5 k) → confidence 0.8, recommendation "lightweight"
 *  4. Empty description with generic title → confidence 0.7, recommendation "lightweight"
 */
export function detectFlood(input: {
	authorLogin: string;
	prTitle: string;
	prBody: string | null;
	linesChanged: number;
	recentPrCount?: number;
}): FloodResult {
	const signals: FloodSignal[] = [];

	// ── Rule 1: Bot author ──────────────────────────────────────
	if (BOT_SUFFIX_RE.test(input.authorLogin)) {
		signals.push({
			type: "bot",
			confidence: 1.0,
			detail: `Author "${input.authorLogin}" matches bot pattern`,
		});
	}

	// ── Rule 2: Mass PRs ────────────────────────────────────────
	if (input.recentPrCount !== undefined && input.recentPrCount > 5) {
		signals.push({
			type: "mass_prs",
			confidence: 0.9,
			detail: `Author opened ${input.recentPrCount} PRs recently (threshold: 5)`,
		});
	}

	// ── Rule 3: Huge diff ───────────────────────────────────────
	if (input.linesChanged > 5000) {
		signals.push({
			type: "huge_diff",
			confidence: 0.8,
			detail: `Diff contains ${input.linesChanged} changed lines (threshold: 5 000)`,
		});
	}

	// ── Rule 4: Empty description with generic title ────────────
	const bodyIsEmpty = input.prBody === null || input.prBody.trim().length === 0;
	if (bodyIsEmpty && EMPTY_TITLE_RE.test(input.prTitle.trim())) {
		signals.push({
			type: "empty_description",
			confidence: 0.7,
			detail: `PR has no description and a generic title: "${input.prTitle}"`,
		});
	}

	// ── Determine isFlood ───────────────────────────────────────
	const isFlood = signals.some((s) => s.confidence >= 0.7);

	// ── Determine recommendation (most severe wins) ─────────────
	// Only bots get "skip"; everything else gets "lightweight" or "full".
	let recommendation: "skip" | "lightweight" | "full" = "full";
	if (signals.some((s) => s.type === "bot")) {
		recommendation = "skip";
	} else if (isFlood) {
		recommendation = "lightweight";
	}

	return { isFlood, signals, recommendation };
}
