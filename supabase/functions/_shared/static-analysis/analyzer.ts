/**
 * Static Analysis Orchestrator
 *
 * Coordinates all static analysis checks (AI attribution, commit validation,
 * stack detection, Semgrep security) and produces a unified result.
 *
 * In-process checks (~15ms) run in parallel with the Semgrep HTTP call (~2-5s).
 * If Semgrep is unavailable, the review continues without security findings.
 */

import type { GitHubDiffFile } from '../types/github.ts';
import type {
  StaticAnalysisConfig,
  StaticAnalysisFinding,
  StaticAnalysisResult,
  DetectedStack,
} from './types.ts';
import { checkFileForAiAttribution, checkCommitsForAiAttribution } from './ai-attribution.ts';
import type { CommitInfo } from './ai-attribution.ts';
import { scanWithSemgrep } from './semgrep-client.ts';
import { detectStack, getStackContext } from './stack-detection.ts';
import { validateCommitMessages } from './commit-validation.ts';

/**
 * Input for running static analysis
 */
export interface StaticAnalysisInput {
  /** PR diff files with patches */
  files: GitHubDiffFile[];
  /** Full file contents for Semgrep (only code files) */
  fileContents: Array<{ path: string; content: string }>;
  /** PR commits */
  commits: CommitInfo[];
  /** Static analysis configuration */
  config: StaticAnalysisConfig;
}

/**
 * Run all static analysis checks.
 *
 * Executes in-process checks (AI attribution, commit validation, stack detection)
 * in parallel with the Semgrep HTTP call. Returns a unified result.
 */
export async function runStaticAnalysis(
  input: StaticAnalysisInput
): Promise<StaticAnalysisResult> {
  const startTime = Date.now();

  if (!input.config.enabled) {
    return createEmptyResult('unknown', startTime);
  }

  // Detect stack (always runs, ~1ms)
  const allFilenames = input.files.map((f) => f.filename);
  const detectedStack = detectStack(allFilenames);

  // Run checks in parallel
  const [aiFindings, commitResult, semgrepResult] = await Promise.all([
    // AI attribution check (in-process)
    runAiAttributionCheck(input),
    // Commit validation (in-process)
    runCommitValidation(input),
    // Semgrep security scan (HTTP call)
    runSemgrepCheck(input),
  ]);

  // Aggregate all findings
  const allFindings: StaticAnalysisFinding[] = [
    ...aiFindings.fileFindings,
    ...aiFindings.commitFindings,
    ...commitResult.findings,
    ...semgrepResult.findings,
  ];

  const hasBlockingFindings = allFindings.some((f) => f.severity === 'error');
  const totalTimeMs = Date.now() - startTime;

  return {
    detectedStack,
    findings: allFindings,
    summary: {
      aiAttribution: {
        fileFindings: aiFindings.fileFindings.length,
        commitFindings: aiFindings.commitFindings.length,
      },
      security: {
        findings: semgrepResult.findings.length,
        serviceAvailable: semgrepResult.serviceAvailable,
      },
      commitMessage: {
        valid: commitResult.valid,
        invalid: commitResult.invalid,
      },
    },
    totalTimeMs,
    hasBlockingFindings,
  };
}

/** Run AI attribution checks on files and commits */
function runAiAttributionCheck(input: StaticAnalysisInput): Promise<{
  fileFindings: StaticAnalysisFinding[];
  commitFindings: StaticAnalysisFinding[];
}> {
  if (!input.config.aiAttributionCheck) {
    return Promise.resolve({ fileFindings: [], commitFindings: [] });
  }

  const fileFindings: StaticAnalysisFinding[] = [];
  for (const file of input.files) {
    if (file.patch) {
      fileFindings.push(...checkFileForAiAttribution(file.filename, file.patch));
    }
  }

  const commitFindings = checkCommitsForAiAttribution(
    input.commits,
    input.commits.length
  );

  return Promise.resolve({ fileFindings, commitFindings });
}

/** Run commit message validation */
function runCommitValidation(input: StaticAnalysisInput): Promise<{
  findings: StaticAnalysisFinding[];
  valid: number;
  invalid: number;
}> {
  if (!input.config.commitMessageCheck) {
    return Promise.resolve({ findings: [], valid: 0, invalid: 0 });
  }

  return Promise.resolve(validateCommitMessages(input.commits));
}

/** Run Semgrep security scan via microservice */
async function runSemgrepCheck(input: StaticAnalysisInput): Promise<{
  findings: StaticAnalysisFinding[];
  serviceAvailable: boolean;
}> {
  if (
    !input.config.securityPatternsCheck ||
    !input.config.semgrepServiceUrl ||
    input.fileContents.length === 0
  ) {
    return { findings: [], serviceAvailable: false };
  }

  return scanWithSemgrep(input.config.semgrepServiceUrl, input.fileContents);
}

/** Create an empty result (used when static analysis is disabled) */
function createEmptyResult(
  stack: DetectedStack,
  startTime: number
): StaticAnalysisResult {
  return {
    detectedStack: stack,
    findings: [],
    summary: {
      aiAttribution: { fileFindings: 0, commitFindings: 0 },
      security: { findings: 0, serviceAvailable: false },
      commitMessage: { valid: 0, invalid: 0 },
    },
    totalTimeMs: Date.now() - startTime,
    hasBlockingFindings: false,
  };
}

/**
 * Format static analysis findings as context for the LLM.
 *
 * This string is injected into the LLM prompt so the AI reviewer knows
 * which issues have already been detected deterministically and should
 * NOT be repeated.
 */
export function formatFindingsAsLLMContext(
  result: StaticAnalysisResult
): string {
  if (result.findings.length === 0 && result.detectedStack === 'unknown') {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Pre-Review Static Analysis (confirmed issues - do NOT repeat)');

  // Stack info
  const stackLabel = formatStackLabel(result.detectedStack);
  lines.push(`Stack: ${stackLabel}`);

  // Findings
  if (result.findings.length > 0) {
    lines.push('');
    for (const finding of result.findings) {
      const severity = finding.severity.toUpperCase();
      let line = `- [${severity}] ${finding.ruleId}: ${finding.message}`;
      if (finding.file) {
        line += ` *(${finding.file}`;
        if (finding.line) {
          line += `:${finding.line}`;
        }
        line += ')*';
      }
      lines.push(line);
    }
  }

  // Stack-aware hints
  if (result.detectedStack !== 'unknown') {
    lines.push('');
    lines.push(getStackContext(result.detectedStack));
  }

  lines.push('');
  lines.push('Focus on logic errors, architecture, and issues static analysis cannot catch.');

  return lines.join('\n');
}

/** Human-readable stack label */
function formatStackLabel(stack: DetectedStack): string {
  const labels: Record<DetectedStack, string> = {
    'java-gradle': 'Java/Kotlin (Gradle)',
    'java-maven': 'Java/Kotlin (Maven)',
    'node-npm': 'Node.js (npm)',
    'node-yarn': 'Node.js (Yarn)',
    'node-pnpm': 'Node.js (pnpm)',
    'python': 'Python',
    'go': 'Go',
    'rust': 'Rust',
    'unknown': 'Unknown',
  };
  return labels[stack];
}
