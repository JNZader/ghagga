/**
 * Negative Examples — fingerprinting and prompt formatting.
 *
 * Dismissed findings are stored as negative examples so the pipeline
 * can inject them into agent prompts as "Do NOT suggest: ..." context,
 * suppressing known false positives from recurring.
 */

import { createHash } from 'node:crypto';
import type { NegativeExample, ReviewFinding } from './types.js';

/**
 * Compute a stable hash for a finding to use as negative example key.
 * Hash is based on file path + line range + category.
 */
export function fingerprintFinding(finding: ReviewFinding): string {
  const key = [
    finding.file ?? '',
    `${finding.line ?? 0}`,
    finding.category ?? finding.severity ?? '',
  ].join(':');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Compute a context hash for a file path (used for scoping negative examples to a file).
 */
export function fingerprintContext(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/**
 * Format negative examples as prompt instructions.
 * Returns an empty string when there are no examples.
 */
export function formatNegativeExamplesPrompt(examples: NegativeExample[]): string {
  if (examples.length === 0) return '';

  const lines = examples.map((e) => {
    const reason = e.reason ? ` (${e.reason})` : '';
    return `- ${e.category}${reason}`;
  });

  return ['PREVIOUSLY DISMISSED FINDINGS — do NOT suggest these again:', ...lines, ''].join('\n');
}
