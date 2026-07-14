/**
 * TRIAGE module barrel — see design.md `triage/` (run.ts wraps
 * ghagga-core's runIssueTriage + fences reproduction evidence).
 */

export {
  buildClientReplySystemPrompt,
  type ClientReplyInput,
  DEFAULT_JARGON_BAN,
  generateClientReply,
} from './client-reply.js';
export { buildCodeContext } from './code-context.js';
export { formatReproEvidence } from './evidence-format.js';
export {
  runTriage,
  type TriageIssueInput,
  type TriageRunInput,
  type TriageRunResult,
} from './run.js';
