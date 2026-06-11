/**
 * AI Enhance prompt template and serialization utilities.
 */

import {
  STATIC_ANALYSIS_UNTRUSTED_LABEL,
  UNTRUSTED_CONTENT_POLICY,
  wrapUntrusted,
} from '../agents/prompts.js';
import type { ReviewFinding } from '../types.js';
import type { EnhanceFindingSummary } from './types.js';

/** System prompt for the enhance AI call. */
export const ENHANCE_SYSTEM_PROMPT = `You are a code review assistant analyzing static analysis findings.
Your job is to make the findings MORE actionable by:
1. Grouping related findings that share a root cause
2. Prioritizing findings by real-world impact (1-10 scale, 10 = most critical)
3. Suggesting concrete fixes for the highest-priority findings
4. Identifying likely false positives

Respond with ONLY valid JSON matching this schema:
{
  "groups": [{ "groupId": "g1", "label": "Description of related issue", "findingIds": [1, 2] }],
  "priorities": { "1": 8, "2": 6 },
  "suggestions": { "1": "Use parameterized queries instead of string concatenation" },
  "filtered": [{ "findingId": 3, "reason": "Test file, not production code" }]
}

Rules:
- Every finding must appear in exactly one group
- Priority scores: 10=critical security flaw, 7-9=high impact, 4-6=moderate, 1-3=low impact/noise
- Only suggest fixes for findings with priority >= 7
- Only filter findings you are >90% confident are false positives
- Keep suggestions concise (1-2 sentences)

${UNTRUSTED_CONTENT_POLICY}`;

/**
 * Build the user prompt with serialized findings.
 *
 * The serialized findings carry tool output + file paths from the target repo,
 * which are attacker-influenceable — fence them as untrusted DATA so an injected
 * "message" field cannot redirect the enhance model.
 */
export function buildEnhancePrompt(findings: EnhanceFindingSummary[]): string {
  const serialized = findings
    .map(
      (f) =>
        `[${f.id}] ${f.severity} | ${f.source}/${f.category} | ${f.file}${f.line ? `:${f.line}` : ''} | ${f.message}`,
    )
    .join('\n');

  return `Analyze these ${findings.length} static analysis findings:\n\n${wrapUntrusted(STATIC_ANALYSIS_UNTRUSTED_LABEL, serialized)}`;
}

/**
 * Map full ReviewFindings to compact summaries with sequential IDs.
 */
export function serializeFindings(findings: ReviewFinding[]): EnhanceFindingSummary[] {
  return findings.map((f, index) => ({
    id: index + 1,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category ?? 'general',
    message: f.message,
    source: f.source ?? 'unknown',
  }));
}

/** Severity priority order for truncation (drop lowest first). */
const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Truncate findings to fit within a token budget.
 * Drops lowest-severity findings first.
 * Rough estimate: ~20 tokens per finding.
 */
export function truncateByTokenBudget(
  summaries: EnhanceFindingSummary[],
  maxTokens: number,
): EnhanceFindingSummary[] {
  const tokensPerFinding = 20;
  const maxFindings = Math.floor(maxTokens / tokensPerFinding);

  if (summaries.length <= maxFindings) return summaries;

  // Sort by severity descending (keep highest severity)
  const sorted = [...summaries].sort(
    (a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
  );

  return sorted.slice(0, maxFindings);
}
