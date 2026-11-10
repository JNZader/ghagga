/**
 * Pure formatting functions — string in, string out, no I/O.
 *
 * Contains formatting helpers moved from memory/utils.ts and review.ts
 * plus new shared formatters. All functions are pure (CC2).
 */

import type { ReviewFinding, ReviewResult } from 'ghagga-core';
import { formatBlastRadiusSection } from 'ghagga-core';
import { SEVERITY_EMOJI, SOURCE_LABELS, STATUS_EMOJI } from './theme.js';

// ─── Table & Value Formatting ───────────────────────────────────

/**
 * Format a plain-text table with headers, separator, and padded columns.
 * Moved from memory/utils.ts — same signature, same behavior.
 */
export function formatTable(headers: string[], rows: string[][], widths: number[]): string {
  const lines: string[] = [];

  // Header row
  // biome-ignore lint/style/noNonNullAssertion: widths array is parallel to headers
  lines.push(headers.map((h, i) => h.padEnd(widths[i]!)).join('  '));

  // Separator row
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));

  // Data rows
  for (const row of rows) {
    // biome-ignore lint/style/noNonNullAssertion: widths array is parallel to row
    lines.push(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  }

  return lines.join('\n');
}

/**
 * Format bytes as human-readable size.
 * < 1024: "N bytes", < 1MB: "N.N KB", else "N.N MB"
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format observation ID as 8-char zero-padded string.
 * ID 42 -> "00000042"
 */
export function formatId(id: number): string {
  return String(id).padStart(8, '0');
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

// ─── Key-Value Formatting ───────────────────────────────────────

/**
 * Format a key-value pair with padded label.
 * Used by status and memory show commands.
 * Example: formatKeyValue('Provider', 'github') → "   Provider:  github"
 */
export function formatKeyValue(label: string, value: string, indent: number = 3): string {
  const pad = ' '.repeat(indent);
  return `${pad}${label.padEnd(12)}  ${value}`;
}

// ─── Tool Dividers ──────────────────────────────────────────────

/**
 * Format a tool section divider.
 * Pure function — does not call tui.*.
 */
export function formatToolDivider(label: string): string {
  return `\n─── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`;
}

// ─── Review Result Formatting ───────────────────────────────────

/**
 * Format a ReviewResult as a human-readable markdown string for the terminal.
 * Moved from review.ts — same output, uses theme constants.
 */
export function formatMarkdownResult(result: ReviewResult): string {
  const status = STATUS_EMOJI[result.status] ?? result.status;
  const timeSeconds = (result.metadata.executionTimeMs / 1000).toFixed(1);

  const lines: string[] = [];

  // Header
  lines.push('---');
  lines.push(`🤖 GHAGGA Code Review  |  ${status}`);
  lines.push(
    `Mode: ${result.metadata.mode} | Model: ${result.metadata.model} | Time: ${timeSeconds}s | Tokens: ${result.metadata.tokensUsed}`,
  );
  lines.push('---');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push(result.summary);
  lines.push('');

  // Blast Radius — same position and gate as core's formatReviewComment
  // (format.ts: Summary → Blast Radius → Findings). Data-presence gated:
  // no diagram in the metadata adds zero bytes, so the output stays
  // byte-identical to the pre-section renderer.
  const blastRadiusSection = formatBlastRadiusSection(result.metadata.blastRadius?.diagram);
  if (blastRadiusSection) {
    lines.push(blastRadiusSection);
  }

  // Findings grouped by source
  if (result.findings.length > 0) {
    lines.push(`## Findings (${result.findings.length})`);
    lines.push('');

    // Group findings by source
    const grouped = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      const src = finding.source ?? 'ai';
      if (!grouped.has(src)) grouped.set(src, []);
      grouped.get(src)?.push(finding);
    }

    // Render order: static tools first, then AI
    const renderOrder = ['semgrep', 'trivy', 'cpd', 'ai'];

    for (const src of renderOrder) {
      const findings = grouped.get(src);
      if (!findings || findings.length === 0) continue;

      const label = SOURCE_LABELS[src] ?? src;
      lines.push(formatToolDivider(`${label} (${findings.length})`));
      lines.push('');

      for (const finding of findings) {
        const emoji = SEVERITY_EMOJI[finding.severity] ?? '';
        const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;

        lines.push(`${emoji} [${finding.severity.toUpperCase()}] ${finding.category}`);
        lines.push(`   ${location}`);
        lines.push(`   ${finding.message}`);

        if (finding.suggestion) {
          lines.push(`   💡 ${finding.suggestion}`);
        }

        lines.push('');
      }
    }
  } else {
    lines.push('No findings. Nice work! 🎉');
    lines.push('');
  }

  // Static analysis summary
  const { toolsRun, toolsSkipped } = result.metadata;
  if (toolsRun.length > 0 || toolsSkipped.length > 0) {
    lines.push('## Static Analysis');
    if (toolsRun.length > 0) {
      lines.push(`✅ Tools run: ${toolsRun.join(', ')}`);
    }
    if (toolsSkipped.length > 0) {
      lines.push(`⏭️  Tools skipped: ${toolsSkipped.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Powered by GHAGGA — AI Code Review');

  return lines.join('\n');
}

// ─── TUI Summary Formatting ────────────────────────────────────

/**
 * Produce summary lines for a box display.
 * Returns lines showing: status, finding counts by severity, time, tools run.
 */
export function formatBoxSummary(result: ReviewResult): string[] {
  const status = STATUS_EMOJI[result.status] ?? result.status;
  const timeSeconds = (result.metadata.executionTimeMs / 1000).toFixed(1);

  const lines: string[] = [];
  lines.push(`Status: ${status}`);
  lines.push(`Time: ${timeSeconds}s | Tokens: ${result.metadata.tokensUsed}`);
  lines.push(`Mode: ${result.metadata.mode} | Model: ${result.metadata.model}`);
  lines.push('');

  // Finding counts by severity
  const counts: Record<string, number> = {};
  for (const f of result.findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  if (result.findings.length > 0) {
    const parts: string[] = [];
    for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      if (counts[sev]) {
        parts.push(`${SEVERITY_EMOJI[sev]} ${sev}: ${counts[sev]}`);
      }
    }
    lines.push(`Findings: ${result.findings.length} total`);
    lines.push(parts.join('  '));
  } else {
    lines.push('Findings: 0 — clean! 🎉');
  }

  // Tools run
  if (result.metadata.toolsRun.length > 0) {
    lines.push('');
    lines.push(`Tools: ${result.metadata.toolsRun.join(', ')}`);
  }

  return lines;
}

/**
 * Format a single finding with severity emoji and message.
 * Used by both review and health commands.
 */
export function formatSeverityLine(finding: ReviewFinding): string {
  const emoji = SEVERITY_EMOJI[finding.severity] ?? '';
  const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return `${emoji} [${finding.severity.toUpperCase()}] ${finding.category} — ${location}: ${finding.message}`;
}

/**
 * Format health score for display.
 * Returns lines for the health score box.
 */
export function formatHealthScore(score: number, grade: string): string[] {
  const lines: string[] = [];
  const bar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5));
  lines.push(`Health Score: ${score}/100 (${grade})`);
  lines.push(`[${bar}]`);
  return lines;
}
