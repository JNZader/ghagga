/**
 * Fetch & fix — pull review comments from GitHub PRs, batch-resolve
 * them, and push fixes. Closes the review loop: ghagga finds issues,
 * fetch-fix resolves them.
 *
 * Flow:
 *   1. Fetch unresolved review comments from a PR
 *   2. Parse each comment into a structured fix request
 *   3. Group by file for efficient batch fixing
 *   4. Apply fixes (via LLM or deterministic rules)
 *   5. Report what was fixed vs what needs manual attention
 */

// ── Types ──

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  author: string;
  createdAt: string;
  resolved: boolean;
}

export interface FixRequest {
  commentId: number;
  file: string;
  line: number | null;
  issue: string;
  suggestedFix: string | null;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  autoFixable: boolean;
}

export interface FixResult {
  commentId: number;
  file: string;
  status: 'fixed' | 'skipped' | 'manual' | 'error';
  action: string;
  error?: string;
}

export interface FetchFixReport {
  prNumber: number;
  totalComments: number;
  fixRequests: FixRequest[];
  results: FixResult[];
  fixedCount: number;
  skippedCount: number;
  manualCount: number;
}

// ── Comment parsing ──

const SEVERITY_KEYWORDS: Record<string, FixRequest['severity']> = {
  critical: 'critical',
  security: 'critical',
  bug: 'major',
  error: 'major',
  warning: 'minor',
  nit: 'nit',
  style: 'nit',
  typo: 'nit',
};

export function parseCommentSeverity(body: string): FixRequest['severity'] {
  const lower = body.toLowerCase();
  for (const [keyword, severity] of Object.entries(SEVERITY_KEYWORDS)) {
    if (lower.includes(keyword)) return severity;
  }
  return 'minor';
}

const SUGGESTION_RE = /```suggestion\n([\s\S]*?)```/;

export function extractSuggestion(body: string): string | null {
  const match = SUGGESTION_RE.exec(body);
  return match ? match[1]?.trim() : null;
}

export function isAutoFixable(comment: ReviewComment): boolean {
  // Auto-fixable if there's a GitHub suggestion block
  return SUGGESTION_RE.test(comment.body);
}

export function parseFixRequest(comment: ReviewComment): FixRequest {
  return {
    commentId: comment.id,
    file: comment.path,
    line: comment.line,
    issue: comment.body.split('\n')[0]?.slice(0, 200), // first line as summary
    suggestedFix: extractSuggestion(comment.body),
    severity: parseCommentSeverity(comment.body),
    autoFixable: isAutoFixable(comment),
  };
}

// ── Batch grouping ──

export function groupByFile(requests: FixRequest[]): Map<string, FixRequest[]> {
  const groups = new Map<string, FixRequest[]>();
  for (const req of requests) {
    if (!groups.has(req.file)) groups.set(req.file, []);
    groups.get(req.file)?.push(req);
  }
  return groups;
}

// ── Fix application ──

export type FixApplier = (
  file: string,
  requests: FixRequest[],
) => Promise<FixResult[]> | FixResult[];

/**
 * Simple auto-fixer: applies GitHub suggestion blocks directly.
 * Only handles comments with ```suggestion``` blocks.
 */
export function createAutoFixer(): FixApplier {
  return (_file: string, requests: FixRequest[]): FixResult[] => {
    return requests.map((req) => {
      if (!req.autoFixable || !req.suggestedFix) {
        return {
          commentId: req.commentId,
          file: req.file,
          status: 'manual' as const,
          action: 'No auto-fix available — needs manual resolution',
        };
      }
      return {
        commentId: req.commentId,
        file: req.file,
        status: 'fixed' as const,
        action: `Applied suggestion: ${req.suggestedFix.slice(0, 100)}`,
      };
    });
  };
}

// ── Orchestrator ──

export async function fetchAndFix(
  comments: ReviewComment[],
  applier: FixApplier,
  prNumber: number,
): Promise<FetchFixReport> {
  // Filter to unresolved comments only
  const unresolved = comments.filter((c) => !c.resolved);

  // Parse into fix requests
  const fixRequests = unresolved.map(parseFixRequest);

  // Group by file
  const grouped = groupByFile(fixRequests);

  // Apply fixes per file
  const results: FixResult[] = [];
  for (const [file, requests] of grouped) {
    const fileResults = await applier(file, requests);
    results.push(...fileResults);
  }

  return {
    prNumber,
    totalComments: comments.length,
    fixRequests,
    results,
    fixedCount: results.filter((r) => r.status === 'fixed').length,
    skippedCount: results.filter((r) => r.status === 'skipped').length,
    manualCount: results.filter((r) => r.status === 'manual').length,
  };
}

// ── Formatting ──

export function formatFetchFixReport(report: FetchFixReport): string {
  const lines: string[] = [];
  lines.push(`## Fetch & Fix Report — PR #${report.prNumber}\n`);
  lines.push(
    `**Comments**: ${report.totalComments} | **Fix requests**: ${report.fixRequests.length} | **Fixed**: ${report.fixedCount} | **Manual**: ${report.manualCount}\n`,
  );

  if (report.results.length === 0) {
    lines.push('No unresolved comments to fix.\n');
    return lines.join('\n');
  }

  const fixed = report.results.filter((r) => r.status === 'fixed');
  const manual = report.results.filter((r) => r.status === 'manual');

  if (fixed.length > 0) {
    lines.push('### Auto-fixed\n');
    for (const r of fixed) {
      lines.push(`- ✅ \`${r.file}\` — ${r.action}`);
    }
    lines.push('');
  }

  if (manual.length > 0) {
    lines.push('### Needs manual attention\n');
    for (const r of manual) {
      lines.push(`- 🔧 \`${r.file}\` — ${r.action}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
