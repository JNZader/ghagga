/**
 * Reproduction-evidence formatter — turns a `ReproEvidence` value (produced
 * by the REPRODUCE stage) into the plain-text block that `triage/run.ts`
 * passes as `reproductionEvidence` to ghagga-core's `runIssueTriage`, which
 * fences it via `wrapUntrustedReproEvidence` before it ever reaches the LLM.
 *
 * A non-reproduction (`reproduced: false`) is represented HONESTLY — as a
 * meaningful negative result ("the action succeeded, no error was observed"
 * — likely env/data-specific), never as a failure of the reproduction
 * attempt itself. See design.md decision 5 / PR5's harness.test.ts task 5.5.
 */

import type { ReproEvidence } from '../types/evidence.js';

function bulletList(label: string, items: string[]): string {
  if (items.length === 0) return '';
  return `${label}:\n${items.map((i) => `- ${i}`).join('\n')}`;
}

function formatNetFails(evidence: ReproEvidence): string {
  if (evidence.netFails.length === 0) return '';
  const lines = evidence.netFails.map((n) => {
    const bodyPart = n.body ? ` | ${n.body}` : '';
    return `- ${n.method} ${n.url} -> ${n.status}${bodyPart}`;
  });
  return `Network failures:\n${lines.join('\n')}`;
}

/**
 * Format `evidence` into a plain-text block, or `null` when no evidence was
 * supplied at all (distinct from an explicit non-reproduction, which IS
 * formatted — absence of the field means REPRODUCE never ran).
 */
export function formatReproEvidence(evidence: ReproEvidence | null | undefined): string | null {
  if (!evidence) return null;

  if (!evidence.reproduced) {
    return [
      'REPRODUCTION ATTEMPTED: the described action was performed against the live application but did NOT reproduce the reported error.',
      'This is a meaningful negative result — the issue is likely environment-specific or data-specific, not evidence that no code change is needed.',
      bulletList('Steps attempted', evidence.steps),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  return [
    'REPRODUCTION SUCCEEDED — the described error was reproduced by driving the live application.',
    bulletList('Steps taken', evidence.steps),
    bulletList('Console errors', evidence.consoleErrors),
    formatNetFails(evidence),
    bulletList('On-screen error text', evidence.uiErrors),
    evidence.screenshotRef ? `Screenshot reference: ${evidence.screenshotRef}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
