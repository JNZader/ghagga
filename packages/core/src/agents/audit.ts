/**
 * Audit agent.
 *
 * Runs a single LLM call over pre-collected static analysis findings
 * to produce an executive security and code-quality report.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { AuditInput, AuditResult, StaticAnalysisResult } from '../types.js';
import { AUDIT_SYSTEM } from './prompts.js';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Build an empty StaticAnalysisResult for use when none is available.
 * Mirrors the skipped-tool pattern used throughout the codebase.
 */
function emptyStaticAnalysis(): StaticAnalysisResult {
  const skipped = { status: 'skipped' as const, findings: [], executionTimeMs: 0 };
  return { semgrep: skipped, trivy: skipped, cpd: skipped };
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run a full-project audit using static analysis findings as input.
 *
 * Sends the pre-formatted staticContext to the LLM auditor and returns
 * a structured AuditResult with an executive report.
 *
 * @param input - Audit input with repo path, static context, and provider config
 * @returns Parsed AuditResult
 */
export async function runAuditReport(input: AuditInput): Promise<AuditResult> {
  const { staticContext, provider, model, apiKey } = input;
  const emit = input.onProgress ?? (() => {});

  const timestamp = new Date().toISOString();

  // Short-circuit: nothing to audit
  if (!staticContext || staticContext.trim().length === 0) {
    return {
      status: 'no-findings',
      report: 'No static analysis findings to report.',
      findings: emptyStaticAnalysis(),
      timestamp,
    };
  }

  // Resolve the generation function (required — must be injected by caller)
  if (!input.generateFn) {
    throw new Error(
      'runAuditReport requires generateFn to be provided in AuditInput. ' +
        'The caller must resolve the backend and pass a GenerateTextFn instance.',
    );
  }
  const generateFn: GenerateTextFn = input.generateFn;

  emit({
    step: 'audit-call',
    message: `Calling ${provider}/${model} for audit report...`,
  });

  try {
    const result = await generateFn(AUDIT_SYSTEM, staticContext);

    emit({
      step: 'audit-done',
      message: `Audit complete — ${result.tokensUsed} tokens`,
    });

    return {
      status: 'completed',
      report: result.text,
      findings: emptyStaticAnalysis(),
      timestamp,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    emit({
      step: 'audit-done',
      message: `Audit LLM call failed: ${message}`,
    });

    return {
      status: 'error',
      report: '',
      findings: emptyStaticAnalysis(),
      timestamp,
      error: message,
    };
  }
}
