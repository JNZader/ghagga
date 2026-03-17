/**
 * Progressive context loading system (L0/L1/L2).
 *
 * For small models with tight token budgets (e.g., Groq free tier: 4-6K total),
 * the full static analysis and memory context can consume the entire context budget,
 * leaving little room for the actual diff. This module provides three fidelity
 * levels that are automatically selected based on the available token budget.
 *
 * Levels:
 *   L0 (~20-50 tokens)  — One-sentence summary
 *   L1 (~100-200 tokens) — Bullet list with key details
 *   L2 (full)            — Current behavior, unchanged
 */

import type { ReviewFinding, StaticAnalysisResult, ToolResult } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────

export type ContextLevel = 'L0' | 'L1' | 'L2';

// ─── Constants ──────────────────────────────────────────────────

/** Rough chars-per-token heuristic (same as diff.ts truncateDiff). */
const CHARS_PER_TOKEN = 4;

/**
 * L1 budget ceiling: if the context budget is at least this many tokens,
 * we can afford the bullet-list (L1) representation. Below this → L0.
 */
const L1_MIN_BUDGET = 150;

// ─── Token estimation ───────────────────────────────────────────

/**
 * Estimate token count from text using the 4-chars-per-token heuristic.
 * Matches the same approximation used in `truncateDiff()`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Level selection ────────────────────────────────────────────

/**
 * Choose the optimal context fidelity level based on available budget.
 *
 * Decision tree:
 *   1. If the full (L2) context fits within the budget → L2
 *   2. If the budget can accommodate an L1 summary (≥150 tokens) → L1
 *   3. Otherwise → L0
 *
 * @param contextBudget - Available tokens for context from `calculateTokenBudget()`
 * @param estimatedFullTokens - Token estimate for the full (L2) context
 */
export function chooseContextLevel(
  contextBudget: number,
  estimatedFullTokens: number,
): ContextLevel {
  if (estimatedFullTokens <= contextBudget) {
    return 'L2';
  }
  if (contextBudget >= L1_MIN_BUDGET) {
    return 'L1';
  }
  return 'L0';
}

// ─── Static analysis helpers ────────────────────────────────────

/**
 * Extract all findings from a StaticAnalysisResult (all tools, dynamic).
 */
export function collectAllFindings(staticResult: StaticAnalysisResult): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const toolResult of Object.values(staticResult)) {
    if (toolResult && typeof toolResult === 'object' && 'findings' in toolResult) {
      findings.push(...(toolResult as ToolResult).findings);
    }
  }
  return findings;
}

/**
 * Extract the names of all tools that ran successfully.
 */
export function collectToolNames(staticResult: StaticAnalysisResult): string[] {
  return Object.entries(staticResult)
    .filter(
      ([, toolResult]) =>
        toolResult &&
        typeof toolResult === 'object' &&
        'status' in toolResult &&
        toolResult.status === 'success',
    )
    .map(([name]) => name);
}

// ─── Severity grouping helper ───────────────────────────────────

/**
 * Group findings by severity, returning counts.
 * E.g. { critical: 1, high: 2, medium: 3 }
 */
function countBySeverity(findings: ReviewFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Format severity counts into a compact string like "2 high, 3 medium".
 * Ordered by severity: critical → high → medium → low → info.
 */
function formatSeverityCounts(counts: Record<string, number>): string {
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  return order
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
}

// ─── Static Context Formatters ──────────────────────────────────

/**
 * L0: One-sentence summary of static analysis findings.
 *
 * Output: "Static analysis (semgrep, trivy): 5 findings (2 high, 3 medium)"
 * Or:     "Static analysis: no findings"
 *
 * @param findings - All findings from static analysis tools
 * @param toolNames - Names of tools that ran successfully
 */
export function formatStaticContextL0(findings: ReviewFinding[], toolNames: string[]): string {
  const toolList = toolNames.length > 0 ? ` (${toolNames.join(', ')})` : '';

  if (findings.length === 0) {
    return `Static analysis${toolList}: no findings`;
  }

  const counts = countBySeverity(findings);
  const severityStr = formatSeverityCounts(counts);

  return `Static analysis${toolList}: ${findings.length} finding(s) (${severityStr})`;
}

/**
 * L1: Bullet list with file, line, severity, and rule name.
 *
 * Output:
 * ## Static Analysis Summary
 * - [high] auth.ts:45 — SQL injection (semgrep)
 * - [medium] db.ts:12 — Unparameterized query (semgrep)
 *
 * Caps at 15 findings to stay within ~200 tokens. Sorted by severity.
 *
 * @param findings - All findings from static analysis tools
 */
export function formatStaticContextL1(findings: ReviewFinding[]): string {
  if (findings.length === 0) return '';

  const SEVERITY_ORDER: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4),
  );

  const cap = 15;
  const capped = sorted.slice(0, cap);

  const lines = ['## Static Analysis Summary (do NOT repeat these)', ''];

  for (const f of capped) {
    const location = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`- [${f.severity}] ${location} — ${f.message} (${f.source})`);
  }

  if (findings.length > cap) {
    lines.push(`- ... and ${findings.length - cap} more`);
  }

  return lines.join('\n');
}

// ─── Memory Context Formatters ──────────────────────────────────

/**
 * Count the number of observation items in a memory context string.
 * Observations are headed by "### [TYPE] Title" lines.
 */
function countMemoryObservations(memory: string): number {
  const matches = memory.match(/^### \[/gm);
  return matches?.length ?? 0;
}

/**
 * L0: One-sentence summary of available memory context.
 *
 * Output: "Memory: 3 past observations about this codebase available"
 * Or:     "" (if no memory)
 *
 * @param memory - The full memory context string, or null
 */
export function formatMemoryContextL0(memory: string | null): string {
  if (!memory) return '';

  const count = countMemoryObservations(memory);
  if (count === 0) return '';

  return `Memory: ${count} past observation(s) about this codebase available`;
}

/**
 * L1: Abbreviated bullet list of memory items (titles only).
 *
 * Output:
 * ## Past Review Memory (summary)
 * - [DECISION] Switched from sessions to JWT
 * - [BUGFIX] Fixed N+1 in user list
 *
 * @param memory - The full memory context string, or null
 */
export function formatMemoryContextL1(memory: string | null): string {
  if (!memory) return '';

  // Extract "### [TYPE] Title" headers from the memory context
  const headerRegex = /^### \[([A-Z]+)\] (.+)$/gm;
  const items: string[] = [];

  let match = headerRegex.exec(memory);
  while (match !== null) {
    items.push(`- [${match[1]}] ${match[2]}`);
    match = headerRegex.exec(memory);
  }

  if (items.length === 0) return '';

  return ['## Past Review Memory (summary)', '', ...items].join('\n');
}

// ─── Unified context builder ────────────────────────────────────

export interface ProgressiveContextInput {
  staticResult: StaticAnalysisResult;
  memoryContext: string | null;
  stackHints: string;
  contextBudget: number;

  /** Full static context string (L2). Pre-formatted by formatStaticAnalysisContext(). */
  fullStaticContext: string;
}

export interface ProgressiveContextOutput {
  /** The context-level-adjusted static context string. */
  staticContext: string;

  /** The context-level-adjusted memory context string. */
  memoryContext: string | null;

  /** Stack hints are passed through unchanged (already compact). */
  stackHints: string;

  /** The chosen level for static analysis context. */
  staticLevel: ContextLevel;

  /** The chosen level for memory context. */
  memoryLevel: ContextLevel;
}

/**
 * Build context strings at the optimal fidelity level for the available budget.
 *
 * The budget is split: static analysis gets priority, then memory fills remaining.
 * Stack hints pass through unchanged (they are already compact).
 *
 * @returns Context strings and chosen levels for logging
 */
export function buildProgressiveContext(input: ProgressiveContextInput): ProgressiveContextOutput {
  const { staticResult, memoryContext, stackHints, contextBudget, fullStaticContext } = input;

  // Estimate full token costs
  const fullStaticTokens = estimateTokens(fullStaticContext);
  const fullMemoryTokens = memoryContext ? estimateTokens(memoryContext) : 0;
  const stackHintTokens = estimateTokens(stackHints);

  // Stack hints always pass through — they're already very compact
  const remainingBudget = Math.max(0, contextBudget - stackHintTokens);

  // Allocate: 60% to static, 40% to memory (of remaining budget)
  const staticBudget = Math.floor(remainingBudget * 0.6);
  const memoryBudget = remainingBudget - staticBudget;

  // Choose static level
  const staticLevel = chooseContextLevel(staticBudget, fullStaticTokens);

  let adjustedStaticContext: string;
  if (staticLevel === 'L2') {
    adjustedStaticContext = fullStaticContext;
  } else {
    const allFindings = collectAllFindings(staticResult);
    const toolNames = collectToolNames(staticResult);
    adjustedStaticContext =
      staticLevel === 'L1'
        ? formatStaticContextL1(allFindings)
        : formatStaticContextL0(allFindings, toolNames);
  }

  // Choose memory level
  const memoryLevel = chooseContextLevel(memoryBudget, fullMemoryTokens);

  let adjustedMemory: string | null;
  if (memoryLevel === 'L2') {
    adjustedMemory = memoryContext;
  } else if (memoryLevel === 'L1') {
    adjustedMemory = formatMemoryContextL1(memoryContext) || null;
  } else {
    adjustedMemory = formatMemoryContextL0(memoryContext) || null;
  }

  return {
    staticContext: adjustedStaticContext,
    memoryContext: adjustedMemory,
    stackHints,
    staticLevel,
    memoryLevel,
  };
}
