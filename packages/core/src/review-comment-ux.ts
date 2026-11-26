/**
 * Review-comment UX helpers.
 *
 * Inline comments are reserved for critical and high findings. The summary
 * comment still carries every finding. A later review can tell which of
 * those findings disappeared by comparing location keys with the previous
 * review's stored findings.
 */

import { sanitizeMarkdownText, sanitizeTableCell } from './sanitize.js';
import type { ReviewFinding } from './types.js';

/** Severities that get an inline comment. Everything else stays in the summary. */
export const INLINE_SEVERITIES = new Set(['critical', 'high']);

/** Cap so a noisy review cannot flood the PR with inline comments. */
export const MAX_INLINE_COMMENTS = 20;

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
};

/**
 * Stable identity of a finding for "still open" vs "fixed" comparison.
 * The message is intentionally excluded: a reworded finding at the same
 * place is the same finding, not a fix plus a new issue.
 */
export function findingLocationKey(finding: {
  file?: string;
  line?: number;
  category?: string;
}): string {
  const file = (finding.file ?? '').trim();
  const line =
    typeof finding.line === 'number' && Number.isInteger(finding.line) ? finding.line : '';
  const category = (finding.category ?? '').trim().toLowerCase();
  return `${file}:${line}:${category}`;
}

function isPositiveLine(line: unknown): line is number {
  return typeof line === 'number' && Number.isInteger(line) && line > 0;
}

function isInlineCandidate(finding: ReviewFinding): boolean {
  if (!INLINE_SEVERITIES.has(finding.severity)) return false;
  if (!isPositiveLine(finding.line)) return false;
  const file = finding.file?.trim() ?? '';
  if (file.length === 0 || file.includes('\n') || file.includes('\r')) return false;
  return true;
}

/**
 * Critical and high findings that can be anchored to a line, highest
 * severity first, capped at {@link MAX_INLINE_COMMENTS}.
 */
export function selectInlineFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings
    .filter(isInlineCandidate)
    .sort((a, b) => {
      const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (severity !== 0) return severity;
      const file = a.file.localeCompare(b.file);
      if (file !== 0) return file;
      return (a.line ?? 0) - (b.line ?? 0);
    })
    .slice(0, MAX_INLINE_COMMENTS);
}

/** Hidden marker so a later review can skip an inline comment it already posted. */
export function inlineCommentMarker(finding: ReviewFinding): string {
  return `<!-- ghagga-inline:${findingLocationKey(finding)} -->`;
}

function fenceSafe(text: string): string {
  return text.replace(/```/g, "'''");
}

/**
 * Body of one inline comment: the finding, a collapsed verification
 * checklist, and a collapsed prompt an AI agent can follow to fix it.
 */
export function buildInlineCommentBody(finding: ReviewFinding): string {
  const file = sanitizeMarkdownText(finding.file, 300);
  const line = finding.line ?? '';
  const severity = sanitizeTableCell(String(finding.severity));
  const category = sanitizeMarkdownText(finding.category || 'general', 100);
  const message = sanitizeMarkdownText(finding.message, 2000);
  const suggestion = finding.suggestion
    ? sanitizeMarkdownText(finding.suggestion, 2000)
    : 'Apply the smallest change that removes the issue described above.';

  const verify = [
    `1. Open \`${fenceSafe(file)}\` at line ${line}.`,
    `2. Confirm the issue is still present: ${message}`,
    `3. Apply the suggested change, then re-run the check that covers this path.`,
    '4. The finding is fixed when that path no longer exhibits the issue.',
  ].join('\n');

  const prompt = fenceSafe(
    [
      'You are fixing one code-review finding. Change only what is required.',
      '',
      `File: ${file}`,
      `Line: ${line}`,
      `Severity: ${severity}`,
      `Category: ${category}`,
      '',
      'Issue:',
      message,
      '',
      'Suggested direction:',
      suggestion,
      '',
      'After the edit, follow the "How to verify" steps. Do not broaden the change.',
    ].join('\n'),
  );

  return [
    inlineCommentMarker(finding),
    `**${severity}** \`${fenceSafe(file)}:${line}\` — ${message}`,
    '',
    suggestion,
    '',
    '<details>',
    '<summary>How to verify</summary>',
    '',
    verify,
    '',
    '</details>',
    '',
    '<details>',
    '<summary>Prompt for an AI agent</summary>',
    '',
    '```text',
    prompt,
    '```',
    '',
    '</details>',
  ].join('\n');
}

function coerceFinding(value: unknown): ReviewFinding | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.file !== 'string' || typeof record.message !== 'string') return null;
  if (typeof record.severity !== 'string') return null;
  const line = isPositiveLine(record.line) ? record.line : undefined;
  return {
    severity: record.severity as ReviewFinding['severity'],
    category: typeof record.category === 'string' ? record.category : '',
    file: record.file,
    ...(line !== undefined ? { line } : {}),
    message: record.message,
    source: (typeof record.source === 'string' ? record.source : 'ai') as ReviewFinding['source'],
    ...(typeof record.suggestion === 'string' ? { suggestion: record.suggestion } : {}),
  };
}

/**
 * Findings present in the previous review whose file:line:category is
 * absent from the current review. Order follows the previous review.
 * An empty or missing previous review yields no "fixed" rows.
 */
export function findingsFixedSince(
  previous: unknown,
  current: readonly ReviewFinding[],
): ReviewFinding[] {
  if (!Array.isArray(previous) || previous.length === 0) return [];
  const open = new Set(current.map((finding) => findingLocationKey(finding)));
  const fixed: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const raw of previous) {
    const finding = coerceFinding(raw);
    if (!finding) continue;
    const key = findingLocationKey(finding);
    if (open.has(key) || seen.has(key)) continue;
    seen.add(key);
    fixed.push(finding);
  }
  return fixed;
}
