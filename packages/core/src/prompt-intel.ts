/**
 * Provider prompt intelligence — track system prompt changes between
 * model versions and providers. Detects diffs, extracts patterns,
 * and flags potential breaking changes.
 */

// ── Types ──

export interface PromptSnapshot {
	provider: string;
	model: string;
	version: string;
	systemPrompt: string;
	capturedAt: string;
	hash: string;
}

export interface PromptDiff {
	provider: string;
	modelA: string;
	modelB: string;
	added: string[];
	removed: string[];
	changed: string[];
	breakingChanges: string[];
}

export interface PromptPattern {
	name: string;
	regex: RegExp;
	category: "safety" | "format" | "behavior" | "capability" | "restriction";
	description: string;
}

// ── Pattern detection ──

export const PROMPT_PATTERNS: PromptPattern[] = [
	{
		name: "tool-use-format",
		regex: /tool.?use|function.?call|tool_choice/i,
		category: "format",
		description: "Tool/function calling format instructions",
	},
	{
		name: "safety-guardrail",
		regex: /refuse|cannot|must not|do not|never|harmful|dangerous/i,
		category: "safety",
		description: "Safety and refusal patterns",
	},
	{
		name: "output-format",
		regex: /json|markdown|xml|structured.?output|schema/i,
		category: "format",
		description: "Output format constraints",
	},
	{
		name: "persona",
		regex: /you are|your role|act as|behave as/i,
		category: "behavior",
		description: "Persona/role assignment",
	},
	{
		name: "context-window",
		regex: /context.?window|token.?limit|max.?tokens|truncat/i,
		category: "capability",
		description: "Context window awareness",
	},
	{
		name: "knowledge-cutoff",
		regex: /knowledge.?cutoff|training.?data|as of|up to date/i,
		category: "capability",
		description: "Knowledge boundary declarations",
	},
	{
		name: "code-execution",
		regex: /execute|run.?code|sandbox|interpreter/i,
		category: "capability",
		description: "Code execution capabilities",
	},
	{
		name: "content-policy",
		regex: /content.?policy|terms.?of.?service|guidelines|acceptable/i,
		category: "restriction",
		description: "Content policy references",
	},
];

// ── Hashing ──

export function hashPrompt(prompt: string): string {
	let hash = 0;
	for (let i = 0; i < prompt.length; i++) {
		const char = prompt.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash).toString(36);
}

// ── Snapshot ──

export function createSnapshot(
	provider: string,
	model: string,
	version: string,
	systemPrompt: string,
): PromptSnapshot {
	return {
		provider,
		model,
		version,
		systemPrompt,
		capturedAt: new Date().toISOString(),
		hash: hashPrompt(systemPrompt),
	};
}

// ── Diff ──

export function diffPrompts(
	a: PromptSnapshot,
	b: PromptSnapshot,
): PromptDiff {
	const linesA = a.systemPrompt.split("\n").filter(Boolean);
	const linesB = b.systemPrompt.split("\n").filter(Boolean);

	const setA = new Set(linesA);
	const setB = new Set(linesB);

	const added = linesB.filter((l) => !setA.has(l));
	const removed = linesA.filter((l) => !setB.has(l));

	// Detect breaking changes: safety rules removed or capabilities changed
	const breakingChanges: string[] = [];
	for (const line of removed) {
		if (PROMPT_PATTERNS.some((p) => p.category === "safety" && p.regex.test(line))) {
			breakingChanges.push(`Safety rule removed: "${line.slice(0, 80)}"`);
		}
	}
	for (const line of added) {
		if (PROMPT_PATTERNS.some((p) => p.category === "restriction" && p.regex.test(line))) {
			breakingChanges.push(`New restriction added: "${line.slice(0, 80)}"`);
		}
	}

	return {
		provider: a.provider,
		modelA: `${a.model}@${a.version}`,
		modelB: `${b.model}@${b.version}`,
		added,
		removed,
		changed: [], // line-level diff not needed for MVP
		breakingChanges,
	};
}

// ── Pattern extraction ──

export function extractPatterns(
	prompt: string,
): Array<{ pattern: string; category: string; match: string }> {
	const results: Array<{ pattern: string; category: string; match: string }> = [];

	for (const p of PROMPT_PATTERNS) {
		const match = prompt.match(p.regex);
		if (match) {
			results.push({
				pattern: p.name,
				category: p.category,
				match: match[0],
			});
		}
	}

	return results;
}

// ── Formatting ──

export function formatDiff(diff: PromptDiff): string {
	const lines: string[] = [
		`## Prompt Diff: ${diff.modelA} → ${diff.modelB}`,
		"",
	];

	if (diff.breakingChanges.length > 0) {
		lines.push("### Breaking Changes");
		for (const bc of diff.breakingChanges) {
			lines.push(`  ⚠️ ${bc}`);
		}
		lines.push("");
	}

	lines.push(`Added: ${diff.added.length} lines`);
	lines.push(`Removed: ${diff.removed.length} lines`);

	if (diff.added.length > 0) {
		lines.push("", "### Added");
		for (const a of diff.added.slice(0, 5)) {
			lines.push(`  + ${a.slice(0, 100)}`);
		}
	}

	if (diff.removed.length > 0) {
		lines.push("", "### Removed");
		for (const r of diff.removed.slice(0, 5)) {
			lines.push(`  - ${r.slice(0, 100)}`);
		}
	}

	return lines.join("\n");
}
