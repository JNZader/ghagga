/**
 * Issue-triage agent.
 *
 * A SIBLING of the diagnostic agent (diagnostic.ts). It reuses the diagnostic
 * hypothesis OUTPUT parser (`parseHypotheses`) but its INPUT is a GitHub issue
 * (title + body + comments), NOT a diff. It deliberately does NOT reuse
 * `runDiagnosticReview` — that path wraps a diff via `wrapUntrustedDiff` and
 * labels the prose as "code changes", which would mislabel an issue and risk
 * the load-bearing PR review path.
 *
 * Prompt-injection posture (issues are openable by ANYONE — the highest-risk
 * untrusted channel):
 *   1. Issue title/body/comments are fenced via `wrapUntrustedDescription`
 *      (<USER_DESCRIPTION>, no inner code fence) — NEVER raw, NEVER as a diff.
 *   2. The trusted scaffold (instructions + labels) stays OUTSIDE the fence.
 *   3. `memoryContext` is fenced via `buildMemoryContext` (untrusted DATA +
 *      anti-priming framing) since it derives from prior user-authored issues.
 *   4. `UNTRUSTED_CONTENT_POLICY` is in the system prompt (`ISSUE_TRIAGE_SYSTEM`).
 *   5. Oversized issue bodies are capped by `wrapUntrustedDescription`'s internal
 *      `capUntrusted` so a giant payload cannot blow context / cost.
 *
 * The agent only PRODUCES a draft (classification + hypotheses + plan + cited
 * report + numeric confidence). It NEVER posts. The confidence THRESHOLD gating
 * lives in the Phase 4 worker, not here.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { Hypothesis, LLMProvider, ProgressCallback } from '../types.js';
import { parseHypotheses } from './diagnostic.js';
import { buildMemoryContext, ISSUE_TRIAGE_SYSTEM, wrapUntrustedDescription } from './prompts.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Cited source backing a triage claim (memory observation or issue excerpt).
 *
 * NOTE: this is STRUCTURALLY IDENTICAL to `IssueDraftSource` in the db package
 * (`ghagga-db` schema.ts:182). We do NOT import that type because `packages/core`
 * has no dependency on the db package and adding one solely for a 3-field shape
 * would introduce a new core→db coupling edge. TypeScript's structural typing
 * makes `IssueTriageSource[]` assignable to `IssueDraftSource[]` at the Phase 4
 * worker boundary, so the persistence layer reuses the value without a cast.
 */
export interface IssueTriageSource {
  title: string;
  type: string;
  ref: string;
}

/** Issue classification taxonomy (locked scope — bug | feature | question). */
export const ISSUE_CLASSIFICATIONS = ['bug', 'feature', 'question'] as const;
export type IssueClassification = (typeof ISSUE_CLASSIFICATIONS)[number];

/** A single issue comment (author + body) — untrusted, fenced as DATA. */
export interface IssueComment {
  author: string;
  body: string;
}

export interface IssueTriageInput {
  /** Issue title — untrusted, fenced. */
  issueTitle: string;
  /** Issue body — untrusted, fenced. */
  issueBody: string;
  /** Repo labels on the issue — TRUSTED metadata, kept OUTSIDE the fence. */
  labels: string[];
  /** Issue comments — untrusted, fenced alongside the body. */
  comments?: IssueComment[];
  /**
   * Pre-built memory dedup/context (semi-trusted: derived from prior issues that
   * were themselves user-authored). The actual memory search is Phase 3 — here
   * it is accepted as input. Fenced via `buildMemoryContext`.
   */
  memoryContext: string | null;
  /** Provider id — carried for progress/metadata (caller resolves the backend). */
  provider: LLMProvider;
  /** Model id — carried for progress/metadata. */
  model: string;
  /** API key — carried for parity with sibling agents (unused directly here). */
  apiKey: string;
  /**
   * Resolved generation function. Required — the caller resolves the backend and
   * injects it (mirrors audit.ts / simple.ts / workflow.ts). Makes the agent
   * trivially testable without real API calls.
   */
  generateFn?: GenerateTextFn;
  onProgress?: ProgressCallback;
}

export interface IssueTriageResult {
  /** Exactly one taxonomy category. */
  classification: IssueClassification;
  /** Root-cause hypotheses (parsed by the reused diagnostic parser). */
  rootCauseHypotheses: Hypothesis[];
  /** Checkboxed plan of action (markdown). */
  plan: string;
  /** Files likely to need changes (best effort). */
  filesToTouch: string[];
  /** Cited sources backing the draft (memory observations / issue excerpts). */
  sources: IssueTriageSource[];
  /** Assembled cited markdown report body (what a human edits + approves). */
  report: string;
  /**
   * Numeric triage confidence in [0,1]. PRODUCED here; the THRESHOLD gate that
   * decides hold-for-human lives in the Phase 4 worker.
   */
  confidence: number;
  /** Tokens used by the LLM call. */
  tokensUsed: number;
}

// ─── Output Parsing ─────────────────────────────────────────────

/** Map a raw CLASSIFICATION value to the taxonomy; default to 'question'. */
function parseClassification(text: string): IssueClassification {
  const match = /^\s*CLASSIFICATION:\s*(\S+)/im.exec(text);
  const raw = match?.[1]?.toLowerCase();
  return ISSUE_CLASSIFICATIONS.includes(raw as IssueClassification)
    ? (raw as IssueClassification)
    : 'question';
}

/** Parse the numeric CONFIDENCE line, clamped to [0,1]; default 0. */
function parseConfidence(text: string): number {
  // Match a CONFIDENCE line whose value is numeric (the hypothesis blocks use
  // word confidences like "high" — those are handled by parseHypotheses).
  const match = /^\s*CONFIDENCE:\s*([0-9]*\.?[0-9]+)\s*$/im.exec(text);
  if (!match?.[1]) return 0;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Extract a labeled block's body up to the next known top-level label or EOF.
 *
 * The terminating lookahead matches EITHER a following top-level label line OR
 * the true end of the string (`$` is anchored WITHOUT the `m` flag so it means
 * end-of-input, not end-of-line — otherwise a multi-line block like REPORT/PLAN
 * would be truncated at its first newline).
 */
function extractBlock(text: string, label: string): string {
  // `m` flag → `^` is line-start (label can appear mid-string). The tail
  // terminator is a next-label line OR `(?![\s\S])` (true end-of-input, which is
  // flag-independent — unlike `$`, which under `m` would match every line end
  // and truncate multi-line blocks).
  const pattern = new RegExp(
    `^[ \\t]*${label}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n[ \\t]*(?:CLASSIFICATION|CONFIDENCE|PLAN|FILES_TO_TOUCH|SOURCES|REPORT|HYPOTHESIS[ \\t]+H\\d+):|(?![\\s\\S]))`,
    'im',
  );
  return pattern.exec(text)?.[1]?.trim() ?? '';
}

/** Parse a comma-separated FILES_TO_TOUCH block into a clean path list. */
function parseFilesToTouch(text: string): string[] {
  const block = extractBlock(text, 'FILES_TO_TOUCH');
  if (!block) return [];
  return block
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Parse the SOURCES block into cited `IssueDraftSource` entries (reusing the db
 * interface). Each line: `- <title> | <type> | <ref>`. Lines that don't carry a
 * type/ref still surface as a source with sensible defaults.
 */
function parseSources(text: string): IssueTriageSource[] {
  const block = extractBlock(text, 'SOURCES');
  if (!block) return [];
  const sources: IssueTriageSource[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    const title = parts[0] ?? '';
    if (!title) continue;
    sources.push({
      title,
      type: parts[1] || 'issue',
      ref: parts[2] || '',
    });
  }
  return sources;
}

// ─── Prompt Assembly ────────────────────────────────────────────

/**
 * Build the user prompt. TRUSTED scaffold (instruction sentence + labels) stays
 * OUTSIDE the untrusted fence; the issue title/body/comments go INSIDE a single
 * `<USER_DESCRIPTION>` fence via `wrapUntrustedDescription` (which caps length
 * and defangs forged boundary tokens).
 */
function buildIssuePrompt(input: IssueTriageInput): string {
  const labelLine =
    input.labels.length > 0
      ? `Repository labels (trusted metadata): ${input.labels.join(', ')}`
      : '';

  // Compose the untrusted issue text. Comments are part of the untrusted
  // channel — concatenate them into the same fenced block.
  const commentsText =
    input.comments && input.comments.length > 0
      ? `\n\nComments:\n${input.comments.map((c) => `[${c.author}]: ${c.body}`).join('\n\n')}`
      : '';
  const untrustedIssue = `Title: ${input.issueTitle}\n\n${input.issueBody}${commentsText}`;

  return [
    'Analyze the following GitHub issue and produce a triage draft per your instructions.',
    labelLine,
    wrapUntrustedDescription(untrustedIssue),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run issue triage over a single GitHub issue.
 *
 * Assembles a trusted system prompt + untrusted-fenced issue text, calls the
 * injected `generateFn`, and parses the structured output into an
 * `IssueTriageResult`. Never posts; produces a draft for human approval.
 */
export async function runIssueTriage(input: IssueTriageInput): Promise<IssueTriageResult> {
  const emit = input.onProgress ?? (() => {});

  if (!input.generateFn) {
    throw new Error(
      'runIssueTriage requires generateFn to be provided in IssueTriageInput. ' +
        'The caller must resolve the backend and pass a GenerateTextFn instance.',
    );
  }
  const generateFn: GenerateTextFn = input.generateFn;

  // System prompt = trusted scaffold (already embeds UNTRUSTED_CONTENT_POLICY)
  // + fenced, anti-primed memory context. Untrusted DATA only inside fences.
  const system = [ISSUE_TRIAGE_SYSTEM, buildMemoryContext(input.memoryContext)]
    .filter(Boolean)
    .join('\n');

  const prompt = buildIssuePrompt(input);

  emit({
    step: 'issue-triage-call',
    message: `Calling ${input.provider}/${input.model} for issue triage...`,
  });

  const { text, tokensUsed } = await generateFn(system, prompt);

  emit({
    step: 'issue-triage-done',
    message: `Issue triage complete — ${tokensUsed} tokens`,
  });

  const report = extractBlock(text, 'REPORT') || text.trim();

  return {
    classification: parseClassification(text),
    rootCauseHypotheses: parseHypotheses(text),
    plan: extractBlock(text, 'PLAN'),
    filesToTouch: parseFilesToTouch(text),
    sources: parseSources(text),
    report,
    confidence: parseConfidence(text),
    tokensUsed,
  };
}
