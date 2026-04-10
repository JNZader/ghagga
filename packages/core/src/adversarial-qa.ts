/**
 * Adversarial QA loop — a critic agent finds issues, a fixer agent
 * resolves them, they iterate until the review score exceeds a
 * threshold or max rounds are reached.
 *
 * The critic produces a quality score (0-100) and a list of issues.
 * The fixer attempts to resolve each issue. The loop continues until
 * the critic is satisfied or the round limit is hit.
 */

// ── Types ──

export interface QAIssue {
	id: string;
	severity: "critical" | "major" | "minor";
	description: string;
	file?: string;
	line?: number;
	suggestion?: string;
	resolved: boolean;
}

export interface CriticResult {
	score: number; // 0-100
	issues: QAIssue[];
	summary: string;
}

export interface FixerResult {
	issuesAttempted: number;
	issuesResolved: number;
	changes: Array<{ issueId: string; action: string }>;
}

export interface QARound {
	round: number;
	criticResult: CriticResult;
	fixerResult: FixerResult | null;
}

export interface QALoopResult {
	rounds: QARound[];
	finalScore: number;
	passed: boolean;
	totalIssuesFound: number;
	totalIssuesResolved: number;
}

export interface QALoopConfig {
	maxRounds: number;
	passThreshold: number; // score needed to pass (default 80)
	stopOnNoProgress: boolean; // stop if fixer resolves 0 issues
}

// ── Defaults ──

export const DEFAULT_QA_CONFIG: QALoopConfig = {
	maxRounds: 3,
	passThreshold: 80,
	stopOnNoProgress: true,
};

// ── Critic/Fixer interfaces ──

export type CriticFn = (
	content: string,
	previousIssues?: QAIssue[],
) => Promise<CriticResult> | CriticResult;

export type FixerFn = (
	content: string,
	issues: QAIssue[],
) => Promise<{ content: string; result: FixerResult }> | { content: string; result: FixerResult };

// ── Loop ──

export async function runQALoop(
	initialContent: string,
	critic: CriticFn,
	fixer: FixerFn,
	config: QALoopConfig = DEFAULT_QA_CONFIG,
): Promise<QALoopResult> {
	const rounds: QARound[] = [];
	let content = initialContent;
	let totalFound = 0;
	let totalResolved = 0;

	for (let round = 1; round <= config.maxRounds; round++) {
		// Critic pass
		const previousIssues = rounds.length > 0
			? rounds[rounds.length - 1]!.criticResult.issues
			: undefined;
		const criticResult = await critic(content, previousIssues);
		totalFound += criticResult.issues.length;

		// Check if we pass
		if (criticResult.score >= config.passThreshold) {
			rounds.push({ round, criticResult, fixerResult: null });
			return {
				rounds,
				finalScore: criticResult.score,
				passed: true,
				totalIssuesFound: totalFound,
				totalIssuesResolved: totalResolved,
			};
		}

		// Last round — no more fixing
		if (round === config.maxRounds) {
			rounds.push({ round, criticResult, fixerResult: null });
			break;
		}

		// Fixer pass
		const unresolvedIssues = criticResult.issues.filter((i) => !i.resolved);
		const { content: fixedContent, result: fixerResult } = await fixer(
			content,
			unresolvedIssues,
		);
		content = fixedContent;
		totalResolved += fixerResult.issuesResolved;

		rounds.push({ round, criticResult, fixerResult });

		// Stop if no progress
		if (config.stopOnNoProgress && fixerResult.issuesResolved === 0) {
			break;
		}
	}

	const finalScore = rounds[rounds.length - 1]?.criticResult.score ?? 0;

	return {
		rounds,
		finalScore,
		passed: finalScore >= config.passThreshold,
		totalIssuesFound: totalFound,
		totalIssuesResolved: totalResolved,
	};
}

// ── Formatting ──

export function formatQAResult(result: QALoopResult): string {
	const lines: string[] = [];
	const status = result.passed ? "✅ PASSED" : "❌ FAILED";
	lines.push(`## Adversarial QA: ${status} (score: ${result.finalScore}/100)\n`);
	lines.push(
		`**Rounds**: ${result.rounds.length} | **Issues found**: ${result.totalIssuesFound} | **Resolved**: ${result.totalIssuesResolved}\n`,
	);

	for (const round of result.rounds) {
		lines.push(`### Round ${round.round}`);
		lines.push(
			`Critic score: ${round.criticResult.score}/100 — ${round.criticResult.summary}`,
		);

		if (round.criticResult.issues.length > 0) {
			for (const issue of round.criticResult.issues) {
				const icon = issue.resolved ? "✓" : "✗";
				lines.push(
					`  ${icon} [${issue.severity}] ${issue.description}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})` : ""}`,
				);
			}
		}

		if (round.fixerResult) {
			lines.push(
				`Fixer: ${round.fixerResult.issuesResolved}/${round.fixerResult.issuesAttempted} resolved`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}
