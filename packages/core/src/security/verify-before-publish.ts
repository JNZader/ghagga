/**
 * Mandatory check before a review is published.
 *
 * Critical and high findings are compared against a fixed checklist.
 * Security findings from the model must also carry SOURCE, PATH,
 * MISSING_GUARD, and SINK, each as a file and a line. A finding that
 * fails is kept, marked refuted, and given a reason — it is not deleted.
 *
 * The function never throws. A failure leaves the findings unchanged so
 * refutation cannot block the review.
 */

import { FINDING_LEDGER_STATUS, type ReviewFinding } from '../types.js';

export const PUBLISH_REFUTE_REASONS = [
  'duplicate',
  'mitigated',
  'speculative',
  'test-only',
  'dead code',
  'unreachable',
  'missing trace',
] as const;

export type PublishRefuteReason = (typeof PUBLISH_REFUTE_REASONS)[number];

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/i;
const MITIGATED =
  /\b(?:already (?:sanitized|escaped|parameterized|guarded|mitigated)|mitigated by|guard is present)\b/i;
const SPECULATIVE = /\b(?:speculative|not confirmed|might be|possibly|potentially)\b/i;
const DEAD_CODE = /\b(?:dead code|never (?:called|reached)|unused)\b/i;

function isCriticalOrHigh(finding: ReviewFinding): boolean {
  return finding.severity === 'critical' || finding.severity === 'high';
}

function isAiSecurity(finding: ReviewFinding): boolean {
  return finding.source === 'ai' && finding.category.trim().toLowerCase() === 'security';
}

function duplicateKey(finding: ReviewFinding): string {
  const message = finding.message.trim().toLowerCase().replace(/\s+/g, ' ');
  const line = typeof finding.line === 'number' ? finding.line : '';
  return `${finding.file}:${line}:${message}`;
}

function checklistReason(
  finding: ReviewFinding,
  seen: Set<string>,
): PublishRefuteReason | undefined {
  if (!isCriticalOrHigh(finding)) return undefined;
  const key = duplicateKey(finding);
  if (seen.has(key)) return 'duplicate';
  seen.add(key);
  if (TEST_PATH.test(finding.file)) return 'test-only';
  if (finding.reachability === 'unreachable' || /\bunreachable\b/i.test(finding.message)) {
    return 'unreachable';
  }
  if (DEAD_CODE.test(finding.message)) return 'dead code';
  const text = `${finding.message}\n${finding.suggestion ?? ''}`;
  if (MITIGATED.test(text)) return 'mitigated';
  if (SPECULATIVE.test(finding.message)) return 'speculative';
  return undefined;
}

function verify(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.map((finding) => {
    if (finding.ledgerStatus === FINDING_LEDGER_STATUS.refuted) {
      seen.add(duplicateKey(finding));
      return finding;
    }
    const checklist = checklistReason(finding, seen);
    if (checklist) {
      return {
        ...finding,
        ledgerStatus: FINDING_LEDGER_STATUS.refuted,
        refuteReason: checklist,
      };
    }
    if (isAiSecurity(finding) && isCriticalOrHigh(finding) && !finding.securityTrace) {
      return {
        ...finding,
        ledgerStatus: FINDING_LEDGER_STATUS.refuted,
        refuteReason: 'missing trace',
      };
    }
    return finding;
  });
}

/**
 * Apply the publish-time refuter. Returns the original array reference's
 * contents copied, or the input unchanged when verification itself fails.
 */
export function verifyBeforePublish(findings: readonly ReviewFinding[]): ReviewFinding[] {
  try {
    return verify(findings);
  } catch {
    return [...findings];
  }
}

/** True when an open critical finding, or three open high findings, remain. */
export function openFindingsStillFail(findings: readonly ReviewFinding[]): boolean {
  const open = findings.filter((finding) => finding.ledgerStatus !== FINDING_LEDGER_STATUS.refuted);
  if (open.some((finding) => finding.severity === 'critical')) return true;
  return open.filter((finding) => finding.severity === 'high').length >= 3;
}
