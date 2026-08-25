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
 *   6. Optional reproduction evidence (captured by driving the LIVE target app —
 *      console errors, network failures, on-screen error text) is fenced
 *      SEPARATELY via `wrapUntrustedReproEvidence` (<REPRO_EVIDENCE>, no inner
 *      code fence) — it is just as attacker-influenceable as the issue text
 *      itself (a crafted error message/response body can carry the same
 *      injection payloads) and gets identical defang + length-cap treatment.
 *
 * The agent only PRODUCES a draft (classification + hypotheses + plan + cited
 * report + numeric confidence). It NEVER posts. The confidence THRESHOLD gating
 * lives in the Phase 4 worker, not here.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { Hypothesis, LLMProvider, ProgressCallback } from '../types.js';
import { parseHypotheses } from './diagnostic.js';
import {
  buildMemoryContext,
  ISSUE_TRIAGE_SYSTEM,
  sanitizeLabel,
  wrapUntrustedDescription,
  wrapUntrustedReproEvidence,
} from './prompts.js';

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
  /**
   * Pre-formatted reproduction evidence from the REPRODUCE stage (console
   * errors, network failures, on-screen error text captured by driving the
   * LIVE target app) — semantically distinct from `memoryContext` ("we drove
   * the live app" vs. dedup context from prior issues). Attacker-influenceable
   * (target-app output) — fenced via `wrapUntrustedReproEvidence` inside a
   * dedicated `<REPRO_EVIDENCE>` tag, separate from `<USER_DESCRIPTION>`.
   * OPTIONAL — absent/null preserves existing behavior exactly (no fence
   * emitted). A non-reproduction is still meaningful signal and SHOULD be
   * passed as a formatted string (e.g. "reproduced: false — action
   * succeeded, no error"), not omitted.
   */
  reproductionEvidence?: string | null;
  /** Provider id — carried for progress/metadata (caller resolves the backend). */
  provider: LLMProvider;
  /** Model id — carried for progress/metadata. */
  model: string;
  /** API key — carried for parity with sibling agents (unused directly here). */
  apiKey: string;
  /**
   * Resolved generation function. REQUIRED — the caller resolves the backend and
   * injects it (mirrors the required `apiKey`/`model` fields). The runtime guard
   * in `runIssueTriage` is retained as defense-in-depth for untyped JS callers
   * that could still pass `undefined` past the type system.
   */
  generateFn: GenerateTextFn;
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

/**
 * Default classification when the model omits or garbles the CLASSIFICATION line.
 * `question` is the SAFE fallback: it carries the weakest action semantics (asks
 * a human for info) rather than asserting a `bug`/`feature` the model didn't
 * actually commit to.
 */
export const DEFAULT_CLASSIFICATION: IssueClassification = 'question';

/**
 * Map a raw CLASSIFICATION value to the taxonomy; default to `question`.
 *
 * Models emit variants the strict equality check silently dropped to the default
 * (`Bug`, `bug.`, `bugfix`, `This is a bug`). Normalize the captured value
 * (lowercase, strip trailing punctuation/whitespace) and match a known
 * classification as a LEADING token before falling back. The fallback remains a
 * deliberate, documented choice for genuinely unmatched output.
 */
function parseClassification(text: string): IssueClassification {
  // Capture the rest of the CLASSIFICATION line (not just the first token) so
  // phrasings like "This is a bug" are reachable via leading-token matching.
  const match = /^[ \t]*CLASSIFICATION:[ \t]*(.+)$/im.exec(text);
  const raw = match?.[1]?.toLowerCase().trim();
  if (!raw) return DEFAULT_CLASSIFICATION;

  // Tokenize on non-letter runs (drops trailing `.`, surrounding prose
  // punctuation, etc.) and find the first token that IS or STARTS WITH a known
  // classification — covers `bug`, `bug.`, `bugfix`, and `this is a bug`.
  const tokens = raw.split(/[^a-z]+/).filter(Boolean);
  for (const token of tokens) {
    const hit = ISSUE_CLASSIFICATIONS.find((c) => token === c || token.startsWith(c));
    if (hit) return hit;
  }
  return DEFAULT_CLASSIFICATION;
}

/**
 * Default numeric confidence when the model omits or garbles the CONFIDENCE line.
 * NOTE: `0` here means "no parseable confidence" — the Phase 4 worker owns the
 * unparseable-vs-genuinely-low interpretation; this layer only guarantees a real
 * number is captured when the model DID emit one.
 */
export const DEFAULT_CONFIDENCE = 0;

/**
 * Parse the numeric CONFIDENCE line, clamped to [0,1]; default `DEFAULT_CONFIDENCE`.
 *
 * The value need NOT end the line — `CONFIDENCE: 0.82 (high confidence)` is valid
 * and must yield `0.82`, not the default. The regex is anchored to the
 * CONFIDENCE line (`^...CONFIDENCE:`) so it cannot steal a number off a
 * HYPOTHESIS/other line, and captures the FIRST numeric token after the colon,
 * tolerating trailing prose. (Hypothesis blocks use word confidences like
 * "high", which carry no numeric token and are handled by parseHypotheses.)
 */
function parseConfidence(text: string): number {
  const match = /^[ \t]*CONFIDENCE:[ \t]*([0-9]*\.?[0-9]+)/im.exec(text);
  if (!match?.[1]) return DEFAULT_CONFIDENCE;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value)) return DEFAULT_CONFIDENCE;
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

/**
 * Actionable classifications assert something concrete (a defect / a wanted
 * change) and therefore must be BACKED by at least one cited source. `question`
 * asserts nothing — it asks a human for info — so it needs no citation.
 */
const ACTIONABLE_CLASSIFICATIONS: readonly IssueClassification[] = ['bug', 'feature'];

/**
 * Whether the draft cites ANY source. This is deliberately a PRESENCE check, not
 * an evidence check, and its scope is narrow ON PURPOSE:
 *   - The prompt (`prompts.ts`) accepts a citation as EITHER a memory-observation
 *     id OR an excerpt from the issue itself. An issue excerpt has no natural
 *     `ref`, so requiring a non-empty `ref` would wrongly flag a legitimately
 *     cited first-report bug (the highest-value triage case) as unfounded.
 *   - At this seam there is no evidence corpus to VALIDATE that a cited ref
 *     resolves, so a model that fabricates a source line still passes. This gate
 *     therefore only catches the clear failure — a confident verdict that cites
 *     literally NOTHING — not a dishonest one. That is the honest limit of what a
 *     presence check can promise.
 * `parseSources` already drops blank/title-less lines, so a non-empty array
 * means at least one real source line was emitted.
 */
function hasCitation(sources: readonly IssueTriageSource[]): boolean {
  return sources.length > 0;
}

// ─── Prompt Assembly ────────────────────────────────────────────

/**
 * Build the user prompt. TRUSTED scaffold (instruction sentence + labels) stays
 * OUTSIDE the untrusted fence; the issue title/body/comments go INSIDE a single
 * `<USER_DESCRIPTION>` fence via `wrapUntrustedDescription` (which caps length
 * and defangs forged boundary tokens).
 */
function buildIssuePrompt(input: IssueTriageInput): string {
  // Labels are repo metadata but NOT inherently safe: a crafted GitHub label can
  // carry newlines or `<>`/quote chars that would inject structure into this
  // TRUSTED line (it sits OUTSIDE the untrusted fence). Sanitize each label
  // (strip newlines + `<>`, cap length) before joining — mirrors the label
  // hygiene in `wrapUntrusted`. Empty-after-strip labels are dropped.
  const safeLabels = input.labels.map(sanitizeLabel).filter(Boolean);
  const labelLine =
    safeLabels.length > 0 ? `Repository labels (trusted metadata): ${safeLabels.join(', ')}` : '';

  // Compose the untrusted issue text. Comments are part of the untrusted
  // channel — concatenate them into the same fenced block.
  const commentsText =
    input.comments && input.comments.length > 0
      ? `\n\nComments:\n${input.comments.map((c) => `[${c.author}]: ${c.body}`).join('\n\n')}`
      : '';
  const untrustedIssue = `Title: ${input.issueTitle}\n\n${input.issueBody}${commentsText}`;

  // Reproduction evidence, when present, is a SEPARATE untrusted fence — it is
  // captured from the live target app, not the issue text, and design.md
  // decision 5 keeps it semantically distinct from the issue description.
  const reproBlock = input.reproductionEvidence
    ? wrapUntrustedReproEvidence(input.reproductionEvidence)
    : '';

  return [
    'Analyze the following GitHub issue and produce a triage draft per your instructions.',
    labelLine,
    wrapUntrustedDescription(untrustedIssue),
    reproBlock,
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

  // Defense-in-depth: the type makes generateFn required, but an untyped JS
  // caller could still pass undefined. Cast through unknown so the always-truthy
  // narrowing is intentional and the runtime guard survives type-checking.
  if (!(input.generateFn as GenerateTextFn | undefined)) {
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
  const classification = parseClassification(text);
  const sources = parseSources(text);

  const result: IssueTriageResult = {
    classification,
    rootCauseHypotheses: parseHypotheses(text),
    plan: extractBlock(text, 'PLAN'),
    filesToTouch: parseFilesToTouch(text),
    sources,
    report,
    confidence: parseConfidence(text),
    tokensUsed,
  };

  // Fail-closed citation gate (in the spirit of ERE's UNCITED_OUTCOME). A model
  // committing to an actionable `bug`/`feature` while citing NOTHING is an
  // unfounded verdict. We WITHHOLD confidence (DEFAULT_CONFIDENCE = 0) so the
  // Phase-4 threshold routes the draft to the hold-for-human channel
  // (NEEDS_INFO), and note it transparently in the human-facing report. We do
  // NOT rewrite the classification: the hold is carried entirely by the zeroed
  // confidence, and keeping the model's guess preserves the dedup/telemetry
  // signal instead of overwriting a `bug` with `question`. This only reshapes
  // the draft — it never posts.
  if (ACTIONABLE_CLASSIFICATIONS.includes(classification) && !hasCitation(sources)) {
    emit({
      step: 'issue-triage-uncited',
      message: `Confidence withheld: ${classification} classified with no cited source.`,
    });
    result.confidence = DEFAULT_CONFIDENCE;
    result.report = `${report}\n\n> ⚠️ Confidence withheld: the model classified this as \`${classification}\` without citing any source. Treat as needs-human.`;
  }

  return result;
}
