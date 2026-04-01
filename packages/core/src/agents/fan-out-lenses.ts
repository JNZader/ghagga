/**
 * Fan-out lenses review agent.
 *
 * Launches N specialized review "lenses" in parallel, each with
 * a focused system prompt. After all lenses complete, findings
 * are merged: deduplicated by file+line, severity takes the
 * highest when conflicts exist.
 *
 * Default lenses:
 *   - security        — injection, auth, data exposure
 *   - performance     — complexity, memory, N+1
 *   - error-handling  — null safety, edge cases, exceptions
 *   - typing          — type safety, generics, strict mode
 *   - accessibility   — a11y attributes, ARIA, keyboard navigation
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type {
  FindingSeverity,
  LLMProvider,
  ProgressCallback,
  ReviewLevel,
  ReviewResult,
  ReviewStatus,
} from '../types.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  COMPACT_CALIBRATION,
  REVIEW_CALIBRATION,
} from './prompts.js';
import { parseFindingsBlock } from './simple.js';

// ─── Lens Definition ───────────────────────────────────────────

/**
 * A review lens: a focused perspective for code review.
 * Each lens gets its own system prompt that constrains the LLM
 * to only analyze from that perspective.
 */
export interface ReviewLens {
  /** Unique identifier (e.g., "security", "performance") */
  name: string;

  /** Human-readable label (e.g., "Security Audit") */
  label: string;

  /** Focused system prompt for this lens */
  system: string;
}

// ─── Default Lenses ────────────────────────────────────────────

export const LENS_SECURITY: ReviewLens = {
  name: 'security',
  label: 'Security',
  system: `You are a security-focused code reviewer. Analyze ONLY security aspects of the code changes.

Focus exclusively on:
- SQL injection, XSS, CSRF vulnerabilities
- Authentication and authorization flaws
- Sensitive data exposure (API keys, tokens, PII in logs)
- Insecure cryptographic patterns
- Path traversal and file inclusion risks
- Dependency vulnerabilities

Ignore: performance, style, naming, error handling (other lenses cover those).

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentence security assessment]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: security
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [clear description of the security issue]
  SUGGESTION: [specific security fix]

FAILED if: Any critical or high security issues. PASSED otherwise.
Report ONLY security findings you are 90%+ confident about.`,
};

export const LENS_PERFORMANCE: ReviewLens = {
  name: 'performance',
  label: 'Performance',
  system: `You are a performance-focused code reviewer. Analyze ONLY performance aspects of the code changes.

Focus exclusively on:
- Algorithm complexity (O(n^2) loops, unnecessary iterations)
- N+1 query patterns, missing indexes, excessive DB calls
- Memory leaks (unclosed resources, growing collections, missing cleanup)
- Unnecessary re-renders or recomputations
- Bundle size impact (large imports, tree-shaking blockers)
- Caching opportunities missed

Ignore: security, style, naming, error handling (other lenses cover those).

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentence performance assessment]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: performance
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [clear description of the performance issue]
  SUGGESTION: [specific performance improvement]

FAILED if: Any critical or high performance issues. PASSED otherwise.
Report ONLY performance findings you are 90%+ confident about.`,
};

export const LENS_ERROR_HANDLING: ReviewLens = {
  name: 'error-handling',
  label: 'Error Handling',
  system: `You are an error-handling-focused code reviewer. Analyze ONLY error handling aspects of the code changes.

Focus exclusively on:
- Null/undefined safety — unchecked access, missing optional chaining
- Missing try/catch around fallible operations
- Swallowed errors (empty catch blocks, ignored rejections)
- Error propagation correctness (re-throwing with context)
- Input validation gaps
- Edge cases and boundary conditions

Ignore: security, performance, style, naming (other lenses cover those).

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentence error handling assessment]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: error-handling
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [clear description of the error handling issue]
  SUGGESTION: [specific error handling fix]

FAILED if: Any critical or high error handling issues. PASSED otherwise.
Report ONLY error handling findings you are 90%+ confident about.`,
};

export const LENS_TYPING: ReviewLens = {
  name: 'typing',
  label: 'Typing',
  system: `You are a type-safety-focused code reviewer. Analyze ONLY type safety aspects of the code changes.

Focus exclusively on:
- Type assertions (as) that bypass safety
- Missing or overly broad types (any, unknown without narrowing)
- Generic constraints that are too loose or too tight
- Interface/type mismatches between modules
- Unsafe type coercion
- Missing discriminated unions or exhaustive checks

Ignore: security, performance, style, error handling (other lenses cover those).

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentence type safety assessment]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: typing
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [clear description of the typing issue]
  SUGGESTION: [specific type safety fix]

FAILED if: Any critical or high typing issues. PASSED otherwise.
Report ONLY typing findings you are 90%+ confident about.`,
};

export const LENS_ACCESSIBILITY: ReviewLens = {
  name: 'accessibility',
  label: 'Accessibility',
  system: `You are an accessibility-focused code reviewer. Analyze ONLY accessibility aspects of the code changes.

Focus exclusively on:
- Missing ARIA attributes on interactive elements
- Incorrect role assignments
- Missing alt text on images
- Keyboard navigation gaps (missing tabIndex, key handlers)
- Color contrast and visual accessibility
- Screen reader compatibility issues
- Focus management problems

Ignore: security, performance, style, error handling (other lenses cover those).
If the code has no UI/frontend components, return STATUS: PASSED with empty FINDINGS.

Format your response EXACTLY as:

STATUS: [PASSED or FAILED]
SUMMARY: [1-2 sentence accessibility assessment]
FINDINGS:
- SEVERITY: [critical|high|medium|low|info]
  CATEGORY: accessibility
  FILE: [file path]
  LINE: [line number or "N/A"]
  MESSAGE: [clear description of the accessibility issue]
  SUGGESTION: [specific accessibility fix]

FAILED if: Any critical or high accessibility issues. PASSED otherwise.
Report ONLY accessibility findings you are 90%+ confident about.`,
};

/** All built-in lenses, in order. */
export const DEFAULT_LENSES: ReviewLens[] = [
  LENS_SECURITY,
  LENS_PERFORMANCE,
  LENS_ERROR_HANDLING,
  LENS_TYPING,
  LENS_ACCESSIBILITY,
];

// ─── Lens Registry ─────────────────────────────────────────────

const lensMap = new Map<string, ReviewLens>();

/** Register a custom lens (overwrites if name already exists). */
export function registerLens(lens: ReviewLens): void {
  lensMap.set(lens.name, lens);
}

/** Get a lens by name. Falls back to built-in lenses. */
export function getLens(name: string): ReviewLens | undefined {
  return lensMap.get(name) ?? DEFAULT_LENSES.find((l) => l.name === name);
}

/** Get all registered + built-in lenses (registered take precedence). */
export function getAllLenses(): ReviewLens[] {
  const merged = new Map<string, ReviewLens>();
  for (const lens of DEFAULT_LENSES) merged.set(lens.name, lens);
  for (const [name, lens] of lensMap) merged.set(name, lens);
  return Array.from(merged.values());
}

/** Reset custom registrations (for testing). */
export function resetLensRegistry(): void {
  lensMap.clear();
}

// ─── Severity Ranking ──────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

// ─── Input Types ───────────────────────────────────────────────

export interface FanOutReviewInput {
  diff: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  staticContext: string;
  memoryContext: string | null;
  stackHints: string;
  reviewLevel: ReviewLevel;
  onProgress?: ProgressCallback;

  /** Lens names to use (resolved via registry). Default: first 3 from DEFAULT_LENSES. */
  lenses?: string[];

  /** Max concurrent lens calls. Default: 3. */
  concurrency?: number;

  /** Delay in ms between batches. Default: 0. */
  delayMs?: number;

  /**
   * Backend-agnostic generation functions for lenses (round-robin).
   * When provided, each lens uses generateFns[index % generateFns.length].
   * When omitted, pipeline creates them from provider/model/apiKey.
   */
  generateFns?: GenerateTextFn[];

  /** Optional SOLID/boundary checklist context for structured review. */
  checklistContext?: string;
}

// ─── Merge Logic ───────────────────────────────────────────────

/**
 * Deduplicate findings by file+line, taking the highest severity
 * when the same location is flagged by multiple lenses.
 *
 * Findings without a line number are keyed by file+message hash
 * to avoid false deduplication.
 */
export function mergeFindings(
  allFindings: import('../types.js').ReviewFinding[],
): import('../types.js').ReviewFinding[] {
  const deduped = new Map<string, import('../types.js').ReviewFinding>();

  for (const finding of allFindings) {
    // Key: file + line (or message for line-less findings)
    const key =
      finding.line != null
        ? `${finding.file}:${finding.line}`
        : `${finding.file}::${finding.message}`;

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, finding);
    } else {
      // Take the highest severity
      const existingRank = SEVERITY_RANK[existing.severity] ?? 0;
      const newRank = SEVERITY_RANK[finding.severity] ?? 0;
      if (newRank > existingRank) {
        deduped.set(key, finding);
      }
    }
  }

  // Sort by severity (highest first), then by file
  return Array.from(deduped.values()).sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    return a.file.localeCompare(b.file);
  });
}

// ─── Main Function ─────────────────────────────────────────────

/**
 * Run a fan-out (multi-lens) code review.
 *
 * 1. Resolve which lenses to use (default: first 3)
 * 2. Launch all lenses in parallel with bounded concurrency
 * 3. Parse each response for STATUS/SUMMARY/FINDINGS
 * 4. Merge findings: deduplicate by file+line, take highest severity
 * 5. Determine overall status from merged findings
 *
 * @param input - Review input with diff, provider config, and lenses
 * @returns ReviewResult with merged findings from all lenses
 */
export async function runFanOutReview(input: FanOutReviewInput): Promise<ReviewResult> {
  const { diff, provider, model, staticContext, memoryContext, stackHints, reviewLevel } = input;
  const emit = input.onProgress ?? (() => {});

  // ── Resolve lenses ──────────────────────────────────────────
  const lensNames = input.lenses ?? DEFAULT_LENSES.slice(0, 3).map((l) => l.name);
  const resolvedLenses: ReviewLens[] = [];
  for (const name of lensNames) {
    const lens = getLens(name);
    if (lens) {
      resolvedLenses.push(lens);
    } else {
      emit({
        step: 'fan-out-warning',
        message: `Unknown lens "${name}" — skipping`,
      });
    }
  }

  if (resolvedLenses.length === 0) {
    throw new Error('No valid lenses resolved for fan-out review');
  }

  // ── Resolve GenerateTextFn array ────────────────────────────
  const resolvedGenerateFns: GenerateTextFn[] = input.generateFns ?? [];

  const concurrency = input.concurrency ?? 3;
  const delayMs = input.delayMs ?? 0;

  const startTime = Date.now();

  emit({
    step: 'fan-out-start',
    message: `Launching ${resolvedLenses.length} review lenses (concurrency: ${concurrency})`,
    detail: resolvedLenses.map((l) => `  → ${l.label}`).join('\n'),
  });

  // Build the user prompt (same for all lenses)
  const userPrompt = `Review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  // ── Step 1: Run lenses with bounded concurrency ─────────────
  const lensTasks = resolvedLenses.map((lens, index) => {
    return async () => {
      // Round-robin generateFn assignment (fall back to first if provided)
      const generateFn =
        resolvedGenerateFns.length > 0
          ? (resolvedGenerateFns[index % resolvedGenerateFns.length] as GenerateTextFn)
          : null;

      if (!generateFn) {
        throw new Error(`No generateFn available for lens "${lens.name}" at index ${index}`);
      }

      const isFirst = index === 0;
      const system = [
        lens.system,
        isFirst ? staticContext : '',
        isFirst ? buildMemoryContext(memoryContext) : '',
        isFirst ? stackHints : '',
        input.checklistContext ?? '',
        buildReviewLevelInstruction(reviewLevel),
        isFirst ? REVIEW_CALIBRATION : COMPACT_CALIBRATION,
      ]
        .filter(Boolean)
        .join('\n');

      const result = await generateFn(system, userPrompt);

      return {
        name: lens.name,
        label: lens.label,
        text: result.text,
        tokensUsed: result.tokensUsed,
        providerUsed: result.provider,
        modelUsed: result.model,
      };
    };
  });

  const results = await runWithConcurrency(lensTasks, { concurrency, delayMs });

  // ── Step 2: Collect findings from all lenses ────────────────
  let totalTokens = 0;
  const allFindings: import('../types.js').ReviewFinding[] = [];
  const modelsUsed: string[] = [];
  const lensStatuses: ReviewStatus[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const lens = resolvedLenses[i];
    if (!result || !lens) continue;

    if (result.status === 'fulfilled') {
      totalTokens += result.value.tokensUsed;
      modelsUsed.push(
        `${result.value.name}:${result.value.providerUsed}/${result.value.modelUsed}`,
      );

      // Parse the lens response for findings
      const findings = parseFindingsBlock(result.value.text);

      // Tag each finding with source=ai and the lens name for traceability
      for (const finding of findings) {
        finding.source = 'ai';
        // Prefix category with lens name for disambiguation
        if (!finding.category.includes(lens.name)) {
          finding.category = `${lens.name}`;
        }
      }

      allFindings.push(...findings);

      // Track individual lens status
      const statusMatch = /STATUS:\s*(PASSED|FAILED|NEEDS_HUMAN_REVIEW|SKIPPED)/i.exec(
        result.value.text,
      );
      const lensStatus = (statusMatch?.[1]?.toUpperCase() ?? 'NEEDS_HUMAN_REVIEW') as ReviewStatus;
      lensStatuses.push(lensStatus);

      emit({
        step: `lens-${lens.name}`,
        message: `✓ ${lens.label} — ${findings.length} finding(s), ${result.value.tokensUsed} tokens`,
        detail: result.value.text,
      });
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      modelsUsed.push(`${lens.name}:FAILED`);
      emit({
        step: `lens-${lens.name}`,
        message: `✗ ${lens.label} — FAILED: ${reason}`,
      });
    }
  }

  emit({
    step: 'fan-out-merge',
    message: `Merging ${allFindings.length} findings from ${resolvedLenses.length} lenses...`,
  });

  // ── Step 3: Merge and deduplicate ───────────────────────────
  const mergedFindings = mergeFindings(allFindings);

  // ── Step 4: Determine overall status ────────────────────────
  const hasCritical = mergedFindings.some((f) => f.severity === 'critical');
  const highCount = mergedFindings.filter((f) => f.severity === 'high').length;
  const anyFailed = lensStatuses.includes('FAILED');

  let status: ReviewStatus;
  if (hasCritical || highCount >= 3) {
    status = 'FAILED';
  } else if (anyFailed || highCount > 0) {
    status = 'NEEDS_HUMAN_REVIEW';
  } else {
    status = 'PASSED';
  }

  const executionTimeMs = Date.now() - startTime;

  // Build lens summary
  const lensSummaryParts = resolvedLenses.map((lens, i) => {
    const result = results[i];
    if (!result || result.status !== 'fulfilled') return `${lens.label}: failed`;
    const lensStatus = lensStatuses[i] ?? 'unknown';
    return `${lens.label}: ${lensStatus}`;
  });

  const summary =
    mergedFindings.length > 0
      ? `Fan-out review with ${resolvedLenses.length} lenses found ${mergedFindings.length} unique finding(s). Lenses: ${lensSummaryParts.join(', ')}.`
      : `Fan-out review with ${resolvedLenses.length} lenses found no issues. All lenses passed.`;

  return {
    status,
    summary,
    findings: mergedFindings,
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext,
    metadata: {
      mode: 'fan-out',
      provider: modelsUsed.length > 0 ? provider : 'none',
      model,
      tokensUsed: totalTokens,
      executionTimeMs,
      toolsRun: [],
      toolsSkipped: [],
      modelsUsed,
    },
  };
}
