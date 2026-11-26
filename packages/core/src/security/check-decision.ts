/**
 * Decide whether the ghagga/security check run fails.
 *
 * The threshold is inclusive: `critical` fails only on critical security
 * findings; `high` fails on critical and high; and so on. Refuted findings
 * do not count. The default threshold, when the setting is absent, is
 * critical.
 */

import type { ReviewFinding } from '../types.js';

export const SECURITY_CHECK_THRESHOLDS = ['critical', 'high', 'medium', 'low'] as const;
export type SecurityCheckThreshold = (typeof SECURITY_CHECK_THRESHOLDS)[number];

export const DEFAULT_SECURITY_CHECK_THRESHOLD: SecurityCheckThreshold = 'critical';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SECURITY_SOURCES = new Set(['trivy', 'gitleaks', 'bandit', 'zizmor', 'semgrep']);

export function normalizeSecurityCheckThreshold(value: unknown): SecurityCheckThreshold {
  if (
    typeof value === 'string' &&
    (SECURITY_CHECK_THRESHOLDS as readonly string[]).includes(value)
  ) {
    return value as SecurityCheckThreshold;
  }
  return DEFAULT_SECURITY_CHECK_THRESHOLD;
}

function isSecurityFinding(finding: ReviewFinding): boolean {
  const category = finding.category?.toLowerCase() ?? '';
  if (
    category === 'security' ||
    category.includes('vulnerab') ||
    category === 'secrets' ||
    category === 'dependency-vulnerability'
  ) {
    return true;
  }
  return SECURITY_SOURCES.has((finding.source ?? '').toLowerCase());
}

/**
 * Security findings at least as severe as `threshold`, excluding refuted ones.
 * Order is the input order.
 */
export function securityFindingsAtThreshold(
  findings: readonly ReviewFinding[],
  threshold: SecurityCheckThreshold = DEFAULT_SECURITY_CHECK_THRESHOLD,
): ReviewFinding[] {
  const limit = SEVERITY_RANK[threshold] ?? 0;
  return findings.filter((finding) => {
    if (finding.ledgerStatus === 'refuted') return false;
    if (!isSecurityFinding(finding)) return false;
    return (SEVERITY_RANK[finding.severity] ?? 4) <= limit;
  });
}

export interface SecurityCheckDecision {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  findings: ReviewFinding[];
}

export function decideSecurityCheck(
  findings: readonly ReviewFinding[],
  thresholdInput?: unknown,
): SecurityCheckDecision {
  const threshold = normalizeSecurityCheckThreshold(thresholdInput);
  const matched = securityFindingsAtThreshold(findings, threshold);
  if (matched.length === 0) {
    return {
      conclusion: 'success',
      title: `No security findings at or above ${threshold}`,
      summary: `ghagga/security passed. Threshold: ${threshold}.`,
      findings: [],
    };
  }
  const lines = matched
    .slice(0, 20)
    .map((finding) => {
      const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- ${finding.severity} ${where} — ${finding.message}`;
    })
    .join('\n');
  const extra = matched.length > 20 ? `\n- … ${matched.length - 20} more` : '';
  return {
    conclusion: 'failure',
    title: `${matched.length} security finding${matched.length === 1 ? '' : 's'} at or above ${threshold}`,
    summary: `ghagga/security failed. Threshold: ${threshold}.\n\n${lines}${extra}`,
    findings: matched,
  };
}

/** A skipped review did not look at the code, so it must not clear a failing check. */
export function shouldUpdateSecurityCheck(status: string): boolean {
  return status !== 'SKIPPED';
}
