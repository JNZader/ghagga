/**
 * Dual-critique review loop implementation.
 *
 * 3-agent pattern: initial review → self-critique → refined review.
 * The self-critique step catches overreactions, false positives, and
 * vague findings, producing a higher-quality final review.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { FindingSeverity, ProgressCallback, ReviewFinding, ReviewResult } from '../types.js';
import { REFINED_REVIEW_SYSTEM, SELF_CRITIQUE_SYSTEM } from './prompts.js';
import type {
  CritiqueResult,
  CritiqueVerdict,
  DualCritiqueConfig,
  DualCritiqueInput,
  DualCritiqueResult,
  FindingCritique,
} from './types.js';
import { DEFAULT_DUAL_CRITIQUE_CONFIG } from './types.js';

// ─── Constants ─────────────────────────────────────────────────

const VALID_VERDICTS = new Set<CritiqueVerdict>([
  'valid',
  'false-positive',
  'overreaction',
  'vague',
  'redundant',
]);

const VALID_SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low', 'info']);

// ─── Critique Parser ───────────────────────────────────────────

/**
 * Parse the self-critique agent's structured response.
 *
 * Extracts OVERALL_ASSESSMENT and individual CRITIQUES with
 * FINDING_INDEX, VERDICT, REASONING, and optional SUGGESTED_SEVERITY.
 */
export function parseCritiqueResponse(text: string): CritiqueResult {
  // Extract overall assessment
  const assessmentMatch = /OVERALL_ASSESSMENT:\s*(.+?)(?:\n\s*CRITIQUES:|$)/is.exec(text);
  const overallAssessment = assessmentMatch?.[1]?.trim() ?? 'Assessment could not be parsed.';

  // Extract individual critiques
  const critiques: FindingCritique[] = [];

  const critiquePattern =
    /- FINDING_INDEX:\s*(\d+)\s*\n\s*VERDICT:\s*(\S+)\s*\n\s*REASONING:\s*(.+?)(?:\n\s*SUGGESTED_SEVERITY:\s*(\S+))?(?=\n\s*- FINDING_INDEX:|\n*$)/gis;

  let match = critiquePattern.exec(text);
  while (match !== null) {
    const findingIndex = parseInt(match[1], 10);
    const rawVerdict = match[2]?.toLowerCase() as CritiqueVerdict;
    const verdict: CritiqueVerdict = VALID_VERDICTS.has(rawVerdict) ? rawVerdict : 'valid';
    const reasoning = match[3]?.trim() ?? '';

    const critique: FindingCritique = { findingIndex, verdict, reasoning };

    if (verdict === 'overreaction' && match[4]) {
      const rawSeverity = match[4].toLowerCase() as FindingSeverity;
      if (VALID_SEVERITIES.has(rawSeverity)) {
        critique.suggestedSeverity = rawSeverity;
      }
    }

    critiques.push(critique);
    match = critiquePattern.exec(text);
  }

  const falsePositiveCount = critiques.filter((c) => c.verdict === 'false-positive').length;
  const overreactionCount = critiques.filter((c) => c.verdict === 'overreaction').length;

  return {
    critiques,
    overallAssessment,
    falsePositiveCount,
    overreactionCount,
  };
}

// ─── Finding Serializer ────────────────────────────────────────

/**
 * Serialize findings into a text block for the critique agent.
 */
function serializeFindingsForCritique(findings: ReviewFinding[]): string {
  if (findings.length === 0) return '(no findings)';

  return findings
    .map(
      (f, i) =>
        `[${i}] ${f.severity.toUpperCase()} | ${f.category} | ${f.file}:${f.line ?? 'N/A'}\n    ${f.message}${f.suggestion ? `\n    Suggestion: ${f.suggestion}` : ''}`,
    )
    .join('\n\n');
}

// ─── Apply Critique ────────────────────────────────────────────

/**
 * Apply critique verdicts to the initial findings.
 * Returns the filtered and adjusted findings.
 */
export function applyCritique(
  findings: ReviewFinding[],
  critique: CritiqueResult,
): {
  refined: ReviewFinding[];
  removedCount: number;
  adjustedCount: number;
} {
  // Build a map of critique by finding index
  const critiqueMap = new Map<number, FindingCritique>();
  for (const c of critique.critiques) {
    critiqueMap.set(c.findingIndex, c);
  }

  const refined: ReviewFinding[] = [];
  let removedCount = 0;
  let adjustedCount = 0;

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const crit = critiqueMap.get(i);

    if (!crit) {
      // No critique for this finding — keep as-is
      refined.push(finding);
      continue;
    }

    switch (crit.verdict) {
      case 'false-positive':
      case 'redundant':
        removedCount++;
        break;

      case 'overreaction':
        if (crit.suggestedSeverity) {
          refined.push({ ...finding, severity: crit.suggestedSeverity });
          adjustedCount++;
        } else {
          refined.push(finding);
        }
        break;

      case 'vague':
      case 'valid':
      default:
        refined.push(finding);
        break;
    }
  }

  return { refined, removedCount, adjustedCount };
}

// ─── Main Function ─────────────────────────────────────────────

/**
 * Run the dual-critique review loop.
 *
 * Takes an already-completed initial review and runs it through
 * the self-critique → refined review pipeline.
 *
 * @param initialReview - The initial review result from any agent mode
 * @param input - Context needed for the critique agents
 * @param generateFn - LLM generation function
 * @param onProgress - Optional progress callback
 * @returns DualCritiqueResult with refined findings
 */
export async function runDualCritique(
  initialReview: ReviewResult,
  input: DualCritiqueInput,
  generateFn: GenerateTextFn,
  onProgress?: ProgressCallback,
): Promise<DualCritiqueResult> {
  const emit = onProgress ?? (() => {});
  const config: DualCritiqueConfig = {
    ...DEFAULT_DUAL_CRITIQUE_CONFIG,
    ...input.config,
  };

  const initialFindings = initialReview.findings.filter((f) => f.source === 'ai');

  // Short-circuit: not enough findings to justify critique
  if (initialFindings.length < config.minFindingsForCritique) {
    emit({
      step: 'dual-critique',
      message: `Skipping critique — only ${initialFindings.length} AI finding(s) (min: ${config.minFindingsForCritique})`,
    });
    return {
      status: initialReview.status,
      summary: initialReview.summary,
      findings: initialReview.findings,
    };
  }

  // ── Step 1: Self-Critique ────────────────────────────────────
  emit({
    step: 'dual-critique',
    message: `Running self-critique on ${initialFindings.length} AI finding(s)...`,
  });

  const critiquePrompt = `Here is the code diff:\n\n${input.diff}\n\nHere is the initial review with ${initialFindings.length} findings:\n\n${serializeFindingsForCritique(initialFindings)}\n\nPlease critique each finding.`;

  const critiqueResponse = await generateFn(SELF_CRITIQUE_SYSTEM, critiquePrompt);
  const critiqueResult = parseCritiqueResponse(critiqueResponse.text);

  emit({
    step: 'dual-critique',
    message: `Critique complete: ${critiqueResult.falsePositiveCount} false positive(s), ${critiqueResult.overreactionCount} overreaction(s)`,
  });

  // ── Step 2: Apply Critique (deterministic) ───────────────────
  // Apply the critique verdicts to filter/adjust findings
  const { refined, removedCount, adjustedCount } = applyCritique(initialFindings, critiqueResult);

  // Merge back non-AI findings (static analysis) untouched
  const nonAiFindings = initialReview.findings.filter((f) => f.source !== 'ai');
  const allRefinedFindings = [...refined, ...nonAiFindings];

  emit({
    step: 'dual-critique',
    message: `Refined: ${removedCount} removed, ${adjustedCount} adjusted, ${refined.length} kept`,
  });

  // ── Step 3: Refined Summary ──────────────────────────────────
  // Ask the LLM to produce a refined summary based on the surviving findings
  const refinedPrompt = `Here is the code diff:\n\n${input.diff}\n\nInitial review summary: ${initialReview.summary}\n\nSelf-critique assessment: ${critiqueResult.overallAssessment}\n\nRemaining findings after critique (${refined.length}):\n${serializeFindingsForCritique(refined)}\n\nPlease produce the refined review.`;

  const refinedResponse = await generateFn(REFINED_REVIEW_SYSTEM, refinedPrompt);

  // Extract refined status and summary from response
  const statusMatch = /STATUS:\s*(PASSED|FAILED|NEEDS_HUMAN_REVIEW|SKIPPED)/i.exec(
    refinedResponse.text,
  );
  const refinedStatus =
    (statusMatch?.[1]?.toUpperCase() as ReviewResult['status']) ?? initialReview.status;

  const summaryMatch = /SUMMARY:\s*(.+?)(?:\n(?:FINDINGS:|$))/is.exec(refinedResponse.text);
  const refinedSummary = summaryMatch?.[1]?.trim() ?? initialReview.summary;

  // Build result
  const result: DualCritiqueResult = {
    status: refinedStatus,
    summary: refinedSummary,
    findings: allRefinedFindings,
  };

  if (config.includeCritiqueMetadata) {
    result.critiqueMetadata = {
      initialFindingCount: initialFindings.length,
      finalFindingCount: refined.length,
      removedAsFalsePositive: removedCount,
      severityAdjusted: adjustedCount,
      critiqueResult,
    };
  }

  return result;
}
