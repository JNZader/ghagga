/**
 * AISVS security checks — OWASP AI Security Verification Standard
 * Level 1 checks for AI-specific code. Scans for prompt injection
 * vulnerabilities, unsafe output handling, MCP security issues,
 * and agentic action risks.
 *
 * Based on OWASP AISVS chapters:
 *   C9  — Agentic Action Security
 *   C10 — MCP Security
 *   C11 — Prompt Injection Prevention
 *   C12 — Output Validation
 */

// ── Types ──

export type AISVSSeverity = "critical" | "high" | "medium" | "info";

export type AISVSCategory =
	| "prompt-injection"
	| "output-validation"
	| "mcp-security"
	| "agentic-action"
	| "credential-handling"
	| "data-leakage";

export interface AISVSCheck {
	id: string;
	category: AISVSCategory;
	severity: AISVSSeverity;
	title: string;
	description: string;
	pattern: RegExp;
	recommendation: string;
}

export interface AISVSFinding {
	checkId: string;
	category: AISVSCategory;
	severity: AISVSSeverity;
	title: string;
	file: string;
	line: number;
	match: string;
	recommendation: string;
}

export interface AISVSReport {
	findings: AISVSFinding[];
	checksRun: number;
	filesScanned: number;
	passRate: number; // 0-100
}

// ── Check definitions ──

export const AISVS_CHECKS: AISVSCheck[] = [
	// C11 — Prompt Injection Prevention
	{
		id: "AISVS-11.1",
		category: "prompt-injection",
		severity: "critical",
		title: "User input directly in system prompt",
		description: "User-controlled content concatenated into system prompts without sanitization",
		pattern: /system.*(?:prompt|message).*[`'"]\s*\$\{.*(?:user|input|query|message|body)/i,
		recommendation: "Never interpolate user input into system prompts. Use a separate user message role.",
	},
	{
		id: "AISVS-11.2",
		category: "prompt-injection",
		severity: "high",
		title: "Template literal with user content in prompt",
		description: "Template strings embedding user variables in LLM prompts",
		pattern: /(?:prompt|system|instruction)\s*[=:]\s*`[^`]*\$\{(?:req|ctx|params|body|query)\./i,
		recommendation: "Sanitize user input before embedding in prompts. Use parameterized prompt templates.",
	},
	{
		id: "AISVS-11.3",
		category: "prompt-injection",
		severity: "medium",
		title: "No input validation before LLM call",
		description: "LLM API called with unvalidated external input",
		pattern: /(?:generateText|chat\.completions|anthropic\.messages).*(?:req\.body|req\.query|req\.params)/i,
		recommendation: "Validate and sanitize all external input before passing to LLM APIs.",
	},

	// C12 — Output Validation
	{
		id: "AISVS-12.1",
		category: "output-validation",
		severity: "high",
		title: "LLM output used in eval/exec",
		description: "LLM response passed to eval(), exec(), or shell execution",
		pattern: /(?:eval|exec|execSync|spawn|fork)\s*\(\s*(?:result|response|output|completion|text)\b/i,
		recommendation: "Never execute LLM output as code. Parse and validate structured output instead.",
	},
	{
		id: "AISVS-12.2",
		category: "output-validation",
		severity: "high",
		title: "LLM output rendered as HTML without escaping",
		description: "AI-generated content inserted into DOM without sanitization",
		pattern: /(?:innerHTML|dangerouslySetInnerHTML|v-html)\s*[=:]\s*.*(?:result|response|completion|generated)/i,
		recommendation: "Always escape or sanitize LLM output before rendering in HTML.",
	},
	{
		id: "AISVS-12.3",
		category: "output-validation",
		severity: "medium",
		title: "LLM output used in database query",
		description: "AI response interpolated into SQL/NoSQL queries",
		pattern: /(?:query|execute|find|aggregate).*(?:result|response|completion|generated)/i,
		recommendation: "Use parameterized queries. Never interpolate LLM output into database operations.",
	},

	// C10 — MCP Security
	{
		id: "AISVS-10.1",
		category: "mcp-security",
		severity: "critical",
		title: "MCP tool with shell execution",
		description: "MCP tool handler that executes shell commands",
		pattern: /(?:tool|handler).*(?:exec|spawn|shell|child_process)/i,
		recommendation: "MCP tools should not execute arbitrary shell commands. Use allowlists and sandboxing.",
	},
	{
		id: "AISVS-10.2",
		category: "mcp-security",
		severity: "high",
		title: "MCP tool without input validation",
		description: "MCP tool that processes arguments without schema validation",
		pattern: /(?:tool|handler).*(?:args|params|input)\s*(?:\.|\[)(?!.*(?:validate|schema|zod|parse))/i,
		recommendation: "Validate all MCP tool inputs against a schema (Zod, JSON Schema).",
	},

	// C9 — Agentic Action Security
	{
		id: "AISVS-9.1",
		category: "agentic-action",
		severity: "critical",
		title: "Agent with unrestricted file write",
		description: "AI agent that can write to arbitrary file paths",
		pattern: /(?:writeFile|fs\.write|save).*(?:path|file).*(?:agent|tool|action)/i,
		recommendation: "Restrict agent file operations to a sandboxed directory. Use allowlists.",
	},
	{
		id: "AISVS-9.2",
		category: "agentic-action",
		severity: "high",
		title: "Agent with network access without approval",
		description: "AI agent making HTTP requests without user confirmation",
		pattern: /(?:fetch|axios|http|request)\s*\(.*(?:agent|tool|action|generated)/i,
		recommendation: "Require explicit user approval for agent network operations.",
	},

	// Credential handling
	{
		id: "AISVS-C.1",
		category: "credential-handling",
		severity: "critical",
		title: "API key in prompt or context",
		description: "API keys or secrets included in LLM context",
		pattern: /(?:prompt|context|system|message).*(?:api[_-]?key|secret|token|password)\s*[=:]/i,
		recommendation: "Never include credentials in LLM prompts or context windows.",
	},

	// Data leakage
	{
		id: "AISVS-D.1",
		category: "data-leakage",
		severity: "high",
		title: "PII in LLM logging",
		description: "Personal data logged alongside LLM requests/responses",
		pattern: /(?:log|console|print).*(?:prompt|response|completion).*(?:email|phone|ssn|address|name)/i,
		recommendation: "Redact PII from LLM request/response logs.",
	},
];

// ── Scanner ──

export function scanContentForAISVS(
	content: string,
	filePath: string,
	checks: AISVSCheck[] = AISVS_CHECKS,
): AISVSFinding[] {
	const findings: AISVSFinding[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		for (const check of checks) {
			if (check.pattern.test(line)) {
				findings.push({
					checkId: check.id,
					category: check.category,
					severity: check.severity,
					title: check.title,
					file: filePath,
					line: i + 1,
					match: line.trim().slice(0, 120),
					recommendation: check.recommendation,
				});
			}
		}
	}

	return findings;
}

export function buildAISVSReport(
	allFindings: AISVSFinding[],
	filesScanned: number,
): AISVSReport {
	const checksRun = AISVS_CHECKS.length;
	const uniqueChecksTriggered = new Set(allFindings.map((f) => f.checkId)).size;
	const passRate =
		checksRun > 0
			? Math.round(((checksRun - uniqueChecksTriggered) / checksRun) * 100)
			: 100;

	return {
		findings: allFindings,
		checksRun,
		filesScanned,
		passRate,
	};
}

export function formatAISVSReport(report: AISVSReport): string {
	const lines: string[] = [];
	lines.push("## AISVS Security Report\n");
	lines.push(
		`**Checks**: ${report.checksRun} | **Files**: ${report.filesScanned} | **Pass rate**: ${report.passRate}%\n`,
	);

	if (report.findings.length === 0) {
		lines.push("✅ No AISVS violations found.\n");
		return lines.join("\n");
	}

	// Group by category
	const grouped = new Map<AISVSCategory, AISVSFinding[]>();
	for (const f of report.findings) {
		if (!grouped.has(f.category)) grouped.set(f.category, []);
		grouped.get(f.category)!.push(f);
	}

	for (const [category, findings] of grouped) {
		lines.push(`### ${category} (${findings.length})\n`);
		for (const f of findings) {
			lines.push(
				`- **${f.severity.toUpperCase()}** [${f.checkId}] ${f.title}`,
			);
			lines.push(`  \`${f.file}:${f.line}\` — ${f.recommendation}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
