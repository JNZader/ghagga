/**
 * Re-Reviewer — runs a lightweight review on patched diffs
 * to detect regressions introduced by suggested fixes.
 */

import { parseFindingsBlock } from '../agents/simple.js';
import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ReviewFinding } from '../types.js';

// ─── Re-Review Prompt ──────────────────────────────────────────

const RE_REVIEW_SYSTEM = `You are a code review validator. You are reviewing code changes that include SUGGESTED FIXES from a previous code review.

Your ONLY job is to check whether the suggested fixes introduce NEW problems:
- New bugs or logic errors from the fix
- Security issues introduced by the fix
- Performance regressions from the fix
- Breaking changes caused by the fix

DO NOT repeat the original findings. ONLY report NEW issues introduced by the suggested changes.
Lines marked with [SUGGESTED FIX] are the applied suggestions — focus your analysis there.

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentences about whether suggestions introduced issues]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: [security|performance|bug|style|error-handling|maintainability]
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [description of the NEW issue introduced by the suggestion]
  SUGGESTION: [how to fix the regression]

If no new issues were introduced, return STATUS: PASSED with an empty FINDINGS section.`;

// ─── Types ─────────────────────────────────────────────────────

export interface ReReviewInput {
  /** Synthetic diff with suggestions applied */
  patchedDiff: string;

  /** Context about which patches were applied */
  patchContext: string;

  /** Generation function for the LLM call */
  generateFn: GenerateTextFn;
}

export interface ReReviewResult {
  /** New findings from the re-review */
  findings: ReviewFinding[];

  /** Tokens used for this re-review call */
  tokensUsed: number;
}

// ─── Main Function ─────────────────────────────────────────────

/**
 * Run a lightweight re-review on a patched diff.
 *
 * Uses simple mode (single LLM call) to check whether the
 * applied suggestions introduce new problems.
 *
 * @param input - Patched diff and LLM config
 * @returns New findings from the re-review
 */
export async function runReReview(input: ReReviewInput): Promise<ReReviewResult> {
  const { patchedDiff, patchContext, generateFn } = input;

  const system = [RE_REVIEW_SYSTEM, patchContext].filter(Boolean).join('\n\n');

  const prompt = `Please validate the following code changes that include applied suggestions:\n\n\`\`\`diff\n${patchedDiff}\n\`\`\``;

  try {
    const result = await generateFn(system, prompt);

    // Parse findings from the response
    const findings = parseFindingsBlock(result.text);

    // Mark all findings as coming from recursive review
    for (const finding of findings) {
      finding.source = 'recursive-review';
    }

    return {
      findings,
      tokensUsed: result.tokensUsed,
    };
  } catch {
    // Non-blocking — return empty findings on failure
    return {
      findings: [],
      tokensUsed: 0,
    };
  }
}
