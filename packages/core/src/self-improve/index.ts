/**
 * Self-Improving Review Loop
 *
 * Tracks which findings get accepted/rejected by users and uses that
 * signal to derive improvement rules for future reviews.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export type FindingOutcome = "accepted" | "rejected" | "modified";

export interface FindingFeedback {
	findingHash: string;
	outcome: FindingOutcome;
	category: string;
	severity: string;
	modelUsed: string;
	recordedAt: string; // ISO 8601
}

export interface ImprovementRule {
	pattern: string;
	category: string;
	action: "suppress" | "boost_priority";
	confidence: number; // 0-1 based on rejection/acceptance rate
	sampleCount: number;
}

// ─── Storage ─────────────────────────────────────────────────────

/**
 * Append a feedback record to the JSONL file at storagePath.
 * Creates the file (and parent directories) if they do not exist.
 */
export async function recordFeedback(
	feedback: FindingFeedback,
	storagePath: string,
): Promise<void> {
	const dir = dirname(storagePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const line = JSON.stringify(feedback) + "\n";
	appendFileSync(storagePath, line, "utf-8");
}

/**
 * Load all feedback records from a JSONL file.
 * Returns an empty array if the file does not exist.
 */
export async function loadFeedback(storagePath: string): Promise<FindingFeedback[]> {
	if (!existsSync(storagePath)) {
		return [];
	}

	const raw = readFileSync(storagePath, "utf-8").trim();
	if (!raw) return [];

	const records: FindingFeedback[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as FindingFeedback;
			records.push(parsed);
		} catch {
			// Skip malformed lines
		}
	}

	return records;
}

// ─── Rule Derivation ─────────────────────────────────────────────

const MIN_SAMPLE_COUNT = 5;
const SUPPRESS_REJECTION_THRESHOLD = 0.7;
const BOOST_ACCEPTANCE_THRESHOLD = 0.8;

/**
 * Derive improvement rules from accumulated feedback.
 *
 * Logic per category:
 * - rejection_rate > 0.7 AND sampleCount >= 5 → suppress
 * - acceptance_rate > 0.8 AND sampleCount >= 5 → boost_priority
 *
 * Returns rules sorted by confidence descending.
 */
export function deriveRules(feedback: FindingFeedback[]): ImprovementRule[] {
	if (feedback.length === 0) return [];

	// Group by category
	const byCategory = new Map<string, FindingFeedback[]>();
	for (const fb of feedback) {
		const existing = byCategory.get(fb.category) ?? [];
		existing.push(fb);
		byCategory.set(fb.category, existing);
	}

	const rules: ImprovementRule[] = [];

	for (const [category, records] of byCategory) {
		const total = records.length;
		if (total < MIN_SAMPLE_COUNT) continue;

		const rejected = records.filter((r) => r.outcome === "rejected").length;
		const accepted = records.filter((r) => r.outcome === "accepted").length;

		const rejectionRate = rejected / total;
		const acceptanceRate = accepted / total;

		if (rejectionRate > SUPPRESS_REJECTION_THRESHOLD) {
			rules.push({
				pattern: `category:${category}`,
				category,
				action: "suppress",
				confidence: Math.round(rejectionRate * 100) / 100,
				sampleCount: total,
			});
		} else if (acceptanceRate > BOOST_ACCEPTANCE_THRESHOLD) {
			rules.push({
				pattern: `category:${category}`,
				category,
				action: "boost_priority",
				confidence: Math.round(acceptanceRate * 100) / 100,
				sampleCount: total,
			});
		}
	}

	// Sort by confidence descending
	return rules.sort((a, b) => b.confidence - a.confidence);
}

// ─── Prompt Formatting ────────────────────────────────────────────

/**
 * Format derived improvement rules as a prompt section.
 *
 * Injects rules into the system prompt so the agent adjusts its behavior
 * based on historical feedback.
 *
 * @param rules - Derived rules from deriveRules()
 * @returns Formatted string for injection into system prompt
 */
export function formatRulesForPrompt(rules: ImprovementRule[]): string {
	if (rules.length === 0) return "";

	const lines: string[] = [
		"## Review Improvement Rules",
		"",
		"Based on past feedback, apply these adjustments to your review:",
		"",
	];

	for (const rule of rules) {
		if (rule.action === "suppress") {
			lines.push(
				`- **SUPPRESS** findings in category \`${rule.category}\` — ` +
				`${Math.round(rule.confidence * 100)}% rejection rate across ${rule.sampleCount} samples. ` +
				`Only report if you have very strong evidence.`,
			);
		} else {
			lines.push(
				`- **PRIORITIZE** findings in category \`${rule.category}\` — ` +
				`${Math.round(rule.confidence * 100)}% acceptance rate across ${rule.sampleCount} samples. ` +
				`These findings are highly valued by the team.`,
			);
		}
	}

	lines.push("");
	return lines.join("\n");
}
