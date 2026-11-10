/**
 * Digest issue body formatter (nightly-health-digest T4.1).
 *
 * Pure, forge-agnostic rendering of the nightly digest issue body from health
 * module outputs: aggregation-window severity counts, trend, per-file risk
 * ranking. The body starts with the machine-recognizable digest marker
 * (`<!-- ghagga-digest -->`, mirroring `<!-- ghagga-review -->`) so the issue is
 * identifiable by humans/forensics — canonical lookup stays DB `issueNumber`
 * (D6). Identical inputs produce byte-identical output; no I/O, no throws on
 * empty rankings or absent trends.
 */

import { sanitizeInlineCodeName } from './format.js';
import type { DigestInputs, FileRisk } from './health/digest.js';
import type { HealthTrend } from './health/trends.js';
import type { FindingSeverity } from './types.js';

/** Marker header: the first line of every digest issue body (D6). */
export const DIGEST_ISSUE_MARKER = '<!-- ghagga-digest -->';

/** Render order + labels for the window severity-counts table. */
const SEVERITY_ROWS: ReadonlyArray<readonly [severity: FindingSeverity, label: string]> = [
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
  ['info', 'Info'],
];

/** Signed delta rendering: -7 / +5 / 0. */
function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** Worsening/improving wording derived from the delta sign (deterministic). */
function trendWord(delta: number): string {
  if (delta < 0) return 'worsening';
  if (delta > 0) return 'improving';
  return 'unchanged';
}

/**
 * Render the digest issue body as GitHub-flavored markdown.
 *
 * Sections: marker header, title, window severity counts, trend line (omitted
 * cleanly when `trend` is absent or carries no previous digest), and the ranked
 * riskiest files with scores (omitted cleanly when `fileRisks` is empty). File
 * paths are attacker-controlled (they flow from reviewed diffs into stored
 * findings) and are sanitized inside inline-code spans.
 */
export function formatDigestIssue(
  inputs: DigestInputs,
  trend: HealthTrend | undefined,
  fileRisks: FileRisk[],
): string {
  const lines: string[] = [];

  lines.push(DIGEST_ISSUE_MARKER);
  lines.push('## GHAGGA Health Digest');
  lines.push('');
  lines.push('### Window findings');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('| --- | --- |');
  for (const [severity, label] of SEVERITY_ROWS) {
    lines.push(`| ${label} | ${inputs.severityCounts[severity] ?? 0} |`);
  }
  lines.push('');

  if (trend && trend.previous != null && trend.delta != null) {
    const current = trend.previous + trend.delta;
    lines.push(
      `**Trend:** ${current} vs previous ${trend.previous} (${formatDelta(trend.delta)}, ${trendWord(trend.delta)})`,
    );
    lines.push('');
  }

  if (fileRisks.length > 0) {
    lines.push('### Riskiest files');
    lines.push('');
    lines.push('| # | File | Risk | Blast radius |');
    lines.push('| --- | --- | --- | --- |');
    for (let index = 0; index < fileRisks.length; index += 1) {
      const risk = fileRisks[index] as FileRisk;
      lines.push(
        `| ${index + 1} | \`${sanitizeInlineCodeName(risk.file)}\` | ${risk.score} | ${risk.blastRadius} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
