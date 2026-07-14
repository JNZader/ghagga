/**
 * Client-reply generator — the SECOND `generateFn` call in the triage
 * pipeline (design.md "triage/run.ts wraps runIssueTriage + fences
 * evidence"). Takes the INTERNAL technical `report` produced by
 * `runIssueTriage` and asks a model to translate it into a courteous,
 * jargon-free reply in the client's language. Direct generalization of the
 * biogas PoC's client-reply prompt (see biogas-triage.mts `triageIssue()`
 * STAGE 4), made config-driven (language + ban-list, not hardcoded Spanish).
 *
 * SECURITY NOTE: this function is the ONLY place a `clientReply` is
 * produced. It never receives raw reproduction evidence or issue text
 * directly — only the already-synthesized `report` prose — so a client
 * reply can carry at most what the technical report already summarized, not
 * verbatim internal artifacts (file paths, stack traces, DB constraint
 * names). The report itself is still prose a human reviews before
 * approving; this function does not enforce redaction, it relies on the
 * jargon-ban + "do not copy verbatim" instruction plus human review.
 */

import type { GenerateTextFn } from 'ghagga-core';

/** Default forbidden-term list when a project doesn't configure its own. */
export const DEFAULT_JARGON_BAN = [
  'traceback',
  'stack trace',
  'endpoint',
  'API',
  'log',
  'backend',
  'frontend',
  'null pointer',
  'exception',
];

export interface ClientReplyInput {
  issueTitle: string;
  /** Internal technical analysis (ghagga-core `IssueTriageResult.report`). NEVER posted verbatim. */
  report: string;
  /** Target language for the client reply, e.g. 'es'. */
  language: string;
  /** Forbidden technical terms; falls back to DEFAULT_JARGON_BAN when omitted. */
  jargonBan?: string[];
}

/** Build the system prompt enforcing the jargon-ban policy for the target language. */
export function buildClientReplySystemPrompt(language: string, jargonBan: string[]): string {
  const banList = jargonBan.length > 0 ? jargonBan.join(', ') : '(none configured)';
  return [
    `You are customer support for a software platform, writing to a NON-technical client in ${language}.`,
    'Be courteous, clear, and concise (maximum 5 lines). Do NOT promise a date or timeframe.',
    `FORBIDDEN jargon (do not use any of these terms or close variants): ${banList}.`,
    'If information is missing, ask for it in terms anyone would understand (what error message they see on screen, what section of the app, what button they pressed).',
    'Write ONLY the reply to the client — no headers, no signature, no meta-commentary.',
  ].join('\n');
}

/**
 * Generate the client-facing reply from the internal technical `report` via
 * `generateFn`. Returns the trimmed reply text.
 */
export async function generateClientReply(
  input: ClientReplyInput,
  generateFn: GenerateTextFn,
): Promise<string> {
  const jargonBan = input.jargonBan ?? DEFAULT_JARGON_BAN;
  const system = buildClientReplySystemPrompt(input.language, jargonBan);
  const prompt = [
    `Client's issue: "${input.issueTitle}"`,
    '',
    'Internal technical analysis (DO NOT copy verbatim — translate it into client-facing language, with no technical terms, file paths, or raw error text):',
    input.report,
    '',
    'Write ONLY the reply to the client.',
  ].join('\n');

  const { text } = await generateFn(system, prompt);
  return text.trim();
}
