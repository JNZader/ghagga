/**
 * Triage orchestrator — the ONLY caller of ghagga-core's `runIssueTriage`
 * (design.md "Module Architecture" boundary). Wires:
 *
 *   LOCATE's code context + optional REPRODUCE evidence
 *     -> runIssueTriage (analysis, EN, INTERNAL — never posted)
 *     -> generateClientReply (client language, jargon-banned, POSTABLE)
 *
 * SECURITY INVARIANT (HIGH-RISK #1): the client-reply generateFn call NEVER
 * receives the raw reproduction evidence or the raw issue body — it only
 * receives the already-synthesized `report` prose from runIssueTriage. Raw
 * evidence (file paths, stack traces, DB constraint names) can only reach
 * the client reply if the model chose to summarize it into the report AND
 * chose to repeat it in the reply despite the jargon-ban instruction — the
 * pipeline structurally narrows the blast radius rather than trusting model
 * obedience alone. See run.test.ts "no-leak guarantee" for the enforced
 * contract.
 */

import type { GenerateTextFn, Hypothesis, ProgressCallback } from 'ghagga-core';
import {
  type IssueClassification,
  type IssueComment,
  type IssueTriageSource,
  runIssueTriage,
} from 'ghagga-core';
import type { TriageConfig } from '../config/schema.js';
import type { ReproEvidence } from '../types/evidence.js';
import { generateClientReply } from './client-reply.js';
import { buildCodeContext } from './code-context.js';
import { formatReproEvidence } from './evidence-format.js';

export interface TriageIssueInput {
  iid: string;
  title: string;
  body: string;
  labels: string[];
  comments?: IssueComment[];
}

export interface TriageRunInput {
  issue: TriageIssueInput;
  config: TriageConfig;
  /** LOCATE's bounded context-file pool (paths, relative to config.codeRoot). */
  contextFiles: string[];
  /** LOCATE's scanned file contents, keyed by the same relative paths. */
  files: Map<string, string>;
  /** LOCATE's extracted keywords — used to center code-context snippets. */
  keywords: string[];
  /** Optional REPRODUCE-stage evidence; absent/null when REPRODUCE did not run. */
  reproEvidence?: ReproEvidence | null;
  /** Extra pre-built dedup/memory context, prepended before the code context. */
  memoryContext?: string | null;
  /** generateFn used for the STAGE 3 technical analysis call (runIssueTriage). */
  analysisGenerateFn: GenerateTextFn;
  /** generateFn used for the STAGE 4 client-reply call. Defaults to analysisGenerateFn. */
  clientReplyGenerateFn?: GenerateTextFn;
  onProgress?: ProgressCallback;
}

export interface TriageRunResult {
  /** INTERNAL technical analysis (ghagga-core report). NEVER postable as-is. */
  technicalAnalysis: string;
  classification: IssueClassification;
  confidence: number;
  filesToTouch: string[];
  sources: IssueTriageSource[];
  plan: string;
  rootCauseHypotheses: Hypothesis[];
  /** Client-facing reply, jargon-banned, in config.clientReplyPolicy.language. */
  clientReply: string;
  tokensUsed: number;
}

const DEFAULT_CLIENT_REPLY_LANGUAGE = 'es';

/**
 * Run the TRIAGE stage: assembles code context + fenced reproduction
 * evidence, calls `runIssueTriage` for the internal technical analysis, then
 * derives a client-facing reply via a SEPARATE generateFn call.
 */
export async function runTriage(input: TriageRunInput): Promise<TriageRunResult> {
  const codeContext = buildCodeContext(input.contextFiles, input.files, input.keywords);
  const memoryContext = [input.memoryContext, codeContext].filter(Boolean).join('\n\n') || null;
  const reproductionEvidence = formatReproEvidence(input.reproEvidence);

  const triageResult = await runIssueTriage({
    issueTitle: input.issue.title,
    issueBody: input.issue.body,
    labels: input.issue.labels,
    comments: input.issue.comments,
    memoryContext,
    reproductionEvidence,
    provider: 'cli-bridge',
    model: input.config.models.analysis,
    apiKey: '',
    generateFn: input.analysisGenerateFn,
    onProgress: input.onProgress,
  });

  const clientReply = await generateClientReply(
    {
      issueTitle: input.issue.title,
      report: triageResult.report,
      language: input.config.clientReplyPolicy?.language ?? DEFAULT_CLIENT_REPLY_LANGUAGE,
      jargonBan: input.config.clientReplyPolicy?.jargonBan,
    },
    input.clientReplyGenerateFn ?? input.analysisGenerateFn,
  );

  return {
    technicalAnalysis: triageResult.report,
    classification: triageResult.classification,
    confidence: triageResult.confidence,
    filesToTouch: triageResult.filesToTouch,
    sources: triageResult.sources,
    plan: triageResult.plan,
    rootCauseHypotheses: triageResult.rootCauseHypotheses,
    clientReply,
    tokensUsed: triageResult.tokensUsed,
  };
}
