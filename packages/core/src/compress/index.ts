/**
 * Context compression for static analysis tool output.
 *
 * Static analysis tools often return redundant, verbose output.
 * This module compresses tool findings BEFORE sending to the LLM
 * to reduce token usage while preserving the most important information.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface CompressionResult {
  original: string;
  compressed: string;
  reductionPercent: number;
  droppedCount: number;
}

export interface ToolFinding {
  tool: string;
  file: string;
  line?: number;
  message: string;
  severity?: string;
}

export interface CompressOptions {
  /** Max findings per file (default: 5) */
  maxPerFile?: number;
  /** Max findings per tool (default: 20) */
  maxPerTool?: number;
  /** Deduplicate by message prefix (default: true) */
  deduplicateMessages?: boolean;
  /** Rough token budget — 1 token ≈ 4 chars (default: 4000) */
  maxTotalTokens?: number;
}

// ─── Severity ordering ───────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  error: 1,
  high: 2,
  medium: 3,
  warning: 4,
  low: 5,
  info: 6,
  note: 7,
};

function severityRank(severity: string | undefined): number {
  if (!severity) return 99;
  return SEVERITY_ORDER[severity.toLowerCase()] ?? 99;
}

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Compress a list of tool findings using deduplication, per-tool and per-file caps,
 * and a total token budget guard.
 *
 * @param findings  - Raw findings from static analysis tools
 * @param opts      - Compression options
 * @returns Compressed finding list + stats
 */
export function compressToolFindings(
  findings: ToolFinding[],
  opts?: CompressOptions,
): { findings: ToolFinding[]; stats: CompressionResult } {
  const maxPerFile = opts?.maxPerFile ?? 5;
  const maxPerTool = opts?.maxPerTool ?? 20;
  const dedup = opts?.deduplicateMessages ?? true;
  const maxTotalTokens = opts?.maxTotalTokens ?? 4000;
  const maxTotalChars = maxTotalTokens * 4;

  const originalCount = findings.length;

  // ── Step 1: Group by tool ──────────────────────────────────
  const byTool = new Map<string, ToolFinding[]>();
  for (const finding of findings) {
    const list = byTool.get(finding.tool) ?? [];
    list.push(finding);
    byTool.set(finding.tool, list);
  }

  const compressed: ToolFinding[] = [];

  for (const [, toolFindings] of byTool) {
    // ── Step 2: Deduplicate by message prefix (first 60 chars) ──
    let deduped = toolFindings;
    if (dedup) {
      const seen = new Set<string>();
      deduped = toolFindings.filter((f) => {
        const prefix = f.message.slice(0, 60);
        if (seen.has(prefix)) return false;
        seen.add(prefix);
        return true;
      });
    }

    // ── Step 3: Sort by severity (highest first) then cap per tool ──
    const sorted = [...deduped].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const cappedByTool = sorted.slice(0, maxPerTool);

    // ── Step 4: Cap per file within remaining findings ──────────
    const byFile = new Map<string, ToolFinding[]>();
    for (const finding of cappedByTool) {
      const list = byFile.get(finding.file) ?? [];
      list.push(finding);
      byFile.set(finding.file, list);
    }
    for (const fileFindings of byFile.values()) {
      compressed.push(...fileFindings.slice(0, maxPerFile));
    }
  }

  // ── Step 5: Token budget guard ──────────────────────────────
  const roughSize = (f: ToolFinding) => (f.tool + f.file + (f.message ?? '')).length + 30;

  let totalChars = 0;
  const budgeted: ToolFinding[] = [];
  for (const f of compressed) {
    const size = roughSize(f);
    if (totalChars + size > maxTotalChars) break;
    budgeted.push(f);
    totalChars += size;
  }

  const droppedCount = originalCount - budgeted.length;
  const originalStr = JSON.stringify(findings);
  const compressedStr = JSON.stringify(budgeted);

  const reductionPercent =
    originalStr.length > 0
      ? Math.round(((originalStr.length - compressedStr.length) / originalStr.length) * 100)
      : 0;

  return {
    findings: budgeted,
    stats: {
      original: originalStr,
      compressed: compressedStr,
      reductionPercent,
      droppedCount,
    },
  };
}

/**
 * Compress a raw static analysis block (string output from a tool).
 *
 * Finds repeated patterns — lines that are identical except for line numbers —
 * and collapses them into "... and N similar issues". Returns a compressed string
 * with reduction stats.
 *
 * @param rawOutput  - Raw string output from a static analysis tool
 * @param maxTokens  - Max token budget (1 token ≈ 4 chars). Default: 4000
 * @returns Compression result with original, compressed, and stats
 */
export function compressStaticAnalysisBlock(
  rawOutput: string,
  maxTokens = 4000,
): CompressionResult {
  const lines = rawOutput.split('\n');

  // Strip line-number references to find structurally similar lines.
  // E.g. "src/foo.ts:123: unused variable 'x'" → "src/foo.ts:XX: unused variable 'x'"
  const normalize = (line: string) => line.replace(/:\d+/g, ':XX').replace(/\b\d+\b/g, 'N');

  // Group consecutive similar lines
  const groups: Array<{ canonical: string; lines: string[] }> = [];
  for (const line of lines) {
    const key = normalize(line);
    const last = groups[groups.length - 1];
    if (last && last.canonical === key) {
      last.lines.push(line);
    } else {
      groups.push({ canonical: key, lines: [line] });
    }
  }

  // Collapse groups with multiple similar lines
  const compressedLines: string[] = [];
  for (const group of groups) {
    if (group.lines.length === 1) {
      const first = group.lines[0];
      if (first !== undefined) compressedLines.push(first);
    } else {
      const first = group.lines[0];
      if (first !== undefined) {
        compressedLines.push(first);
        compressedLines.push(`  ... and ${group.lines.length - 1} similar issue(s)`);
      }
    }
  }

  let compressed = compressedLines.join('\n');

  // Hard-cap to token budget
  const maxChars = maxTokens * 4;
  if (compressed.length > maxChars) {
    const cutoff = compressed.lastIndexOf('\n', maxChars);
    compressed =
      (cutoff > 0 ? compressed.slice(0, cutoff) : compressed.slice(0, maxChars)) +
      '\n[... output truncated to fit token budget ...]';
  }

  const droppedCount = lines.length - compressedLines.length;
  const reductionPercent =
    rawOutput.length > 0
      ? Math.round(((rawOutput.length - compressed.length) / rawOutput.length) * 100)
      : 0;

  return {
    original: rawOutput,
    compressed,
    reductionPercent,
    droppedCount,
  };
}
