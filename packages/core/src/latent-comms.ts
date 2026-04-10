/**
 * Latent-space communication — compress inter-agent messages to reduce
 * token consumption in multi-agent review modes.
 *
 * Instead of passing full specialist text (~5K tokens) to synthesis,
 * extracts structured findings + compact summary (~1.5K tokens).
 * Zero extra LLM calls — pure extraction + template merge.
 */

// ── Types ──

export interface StructuredFinding {
	severity: "critical" | "major" | "minor" | "info";
	description: string;
	file?: string;
	line?: number;
	suggestion?: string;
}

export interface CompressedOutput {
	agentName: string;
	summary: string;
	findings: StructuredFinding[];
	tokenEstimate: number;
	originalTokens: number;
}

export interface LatentMergeResult {
	mergedPrompt: string;
	totalTokensSaved: number;
	agentCount: number;
}

// ── Token estimation ──

export function estimateTokens(text: string): number {
	return Math.floor(text.length / 4);
}

// ── Finding extraction ──

const SEVERITY_PATTERNS: Array<{
	severity: StructuredFinding["severity"];
	pattern: RegExp;
}> = [
	{ severity: "critical", pattern: /\*\*(?:critical|security|sql injection|rce)/i },
	{ severity: "major", pattern: /\*\*(?:major|missing|bug|error|vulnerability)/i },
	{ severity: "minor", pattern: /\*\*(?:minor|nit|style|naming|hardcoded)/i },
];

const FINDING_RE = /^[-*]\s+\*\*(.+?)\*\*(?:\s+in\s+`([^`]+?)(?::(\d+))?`)?\s*[—–-]\s*(.+)/;
const SUGGESTION_RE = /^\s+Suggestion:\s*(.+)/;

function parseFinding(line: string, nextLine?: string): StructuredFinding | null {
	const match = FINDING_RE.exec(line);
	if (!match) return null;

	const title = match[1]!.trim();
	const file = match[2] ?? undefined;
	const lineNum = match[3] ? parseInt(match[3], 10) : undefined;
	const description = match[4]!.trim();
	const suggestion = nextLine ? SUGGESTION_RE.exec(nextLine)?.[1]?.trim() : undefined;

	// Determine severity from title
	let severity: StructuredFinding["severity"] = "info";
	for (const { severity: sev, pattern } of SEVERITY_PATTERNS) {
		if (pattern.test(`**${title}`)) {
			severity = sev;
			break;
		}
	}

	return {
		severity,
		description: `${title}: ${description}`,
		file,
		line: lineNum,
		suggestion,
	};
}

function extractFindings(text: string): StructuredFinding[] {
	const lines = text.split("\n");
	const findings: StructuredFinding[] = [];

	for (let i = 0; i < lines.length; i++) {
		const finding = parseFinding(lines[i]!, lines[i + 1]);
		if (finding) {
			findings.push(finding);
		}
	}

	return findings;
}

function extractSummary(text: string): string {
	// Look for explicit summary section
	const summaryMatch = text.match(/###?\s*Summary\n([\s\S]*?)(?=\n###?\s|\n$|$)/i);
	if (summaryMatch) {
		return summaryMatch[1]!.trim();
	}

	// Fallback: first non-heading paragraph
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-") && !trimmed.startsWith("*")) {
			return trimmed.slice(0, 200);
		}
	}

	return "";
}

// ── Compression ──

export function compressAgentOutput(
	agentName: string,
	rawOutput: string,
	budgetTokens?: number,
): CompressedOutput {
	const originalTokens = estimateTokens(rawOutput);

	if (!rawOutput.trim()) {
		return {
			agentName,
			summary: "",
			findings: [],
			tokenEstimate: 0,
			originalTokens: 0,
		};
	}

	const findings = extractFindings(rawOutput);
	const summary = extractSummary(rawOutput);

	// Build compressed representation
	let compressed = `[${agentName}] ${summary}`;
	for (const f of findings) {
		const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
		compressed += `\n- [${f.severity}]${loc} ${f.description}`;
		if (f.suggestion) {
			compressed += ` → ${f.suggestion}`;
		}
	}

	let tokenEstimate = estimateTokens(compressed);

	// Truncate if over budget
	if (budgetTokens && tokenEstimate > budgetTokens) {
		const charBudget = budgetTokens * 4;
		compressed = compressed.slice(0, charBudget);
		tokenEstimate = budgetTokens;
	}

	return {
		agentName,
		summary,
		findings,
		tokenEstimate,
		originalTokens,
	};
}

// ── Merge ──

export function mergeCompressed(outputs: CompressedOutput[]): LatentMergeResult {
	if (outputs.length === 0) {
		return { mergedPrompt: "", totalTokensSaved: 0, agentCount: 0 };
	}

	const sections: string[] = [];
	let totalOriginal = 0;

	for (const output of outputs) {
		totalOriginal += output.originalTokens;

		let section = `### ${output.agentName}\n${output.summary}`;
		for (const f of output.findings) {
			const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
			section += `\n- [${f.severity}]${loc} ${f.description}`;
		}
		sections.push(section);
	}

	const mergedPrompt = sections.join("\n\n");
	const mergedTokens = estimateTokens(mergedPrompt);
	const totalTokensSaved = totalOriginal - mergedTokens;

	return {
		mergedPrompt,
		totalTokensSaved: Math.max(0, totalTokensSaved),
		agentCount: outputs.length,
	};
}
