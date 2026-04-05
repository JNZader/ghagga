/**
 * Persist review observations to memory.
 *
 * After a review completes, this module extracts key findings
 * and saves them as memory observations so future reviews of
 * the same project can benefit from past context.
 */

import type { MemoryStorage, ObservationType, ReviewFinding, ReviewResult } from '../types.js';
import { stripPrivateData } from './privacy.js';
import { classifyObservation } from './taxonomy.js';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Map a finding's category to an observation type.
 * This determines how the finding is stored and retrieved.
 */
function findingToObservationType(finding: ReviewFinding): ObservationType {
  switch (finding.category) {
    case 'security':
      return 'discovery';
    case 'bug':
      return 'bugfix';
    case 'performance':
      return 'pattern';
    case 'style':
    case 'maintainability':
      return 'pattern';
    case 'error-handling':
      return 'learning';
    default:
      return 'learning';
  }
}

/**
 * Check if a finding is significant enough to persist.
 * We only save high and critical findings to avoid noise.
 */
function isSignificantFinding(finding: ReviewFinding): boolean {
  return (
    finding.severity === 'critical' || finding.severity === 'high' || finding.severity === 'medium'
  );
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Persist notable review findings as memory observations.
 *
 * Creates a memory session for the review, extracts significant
 * findings, strips private data, and saves them via MemoryStorage.
 * Gracefully handles storage errors without propagating them.
 *
 * @param storage - Memory storage backend (SQLite or PostgreSQL)
 * @param project - Project identifier (e.g., "owner/repo")
 * @param prNumber - Pull request number
 * @param result - The completed review result
 */
export async function persistReviewObservations(
  storage: MemoryStorage,
  project: string,
  prNumber: number,
  result: ReviewResult,
): Promise<void> {
  try {
    if (!storage) return;

    // Extract significant findings first — skip session if nothing to persist
    const significantFindings = result.findings.filter(isSignificantFinding);
    if (significantFindings.length === 0) return;

    // Create a memory session for this review
    const session = await storage.createSession({ project, prNumber });

    for (const finding of significantFindings) {
      const sanitizedMessage = stripPrivateData(finding.message);
      const sanitizedSuggestion = finding.suggestion
        ? stripPrivateData(finding.suggestion)
        : undefined;

      const observationTitle = `${finding.category}: ${sanitizedMessage.slice(0, 80)}`;
      const taxonomyTag = classifyObservation(sanitizedMessage, observationTitle);
      const categoryLabel = taxonomyTag.category.toUpperCase().replace('_', ' ');
      const content = [
        `[${categoryLabel}] [${finding.severity.toUpperCase()}] ${finding.category}`,
        `File: ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
        `Issue: ${sanitizedMessage}`,
        sanitizedSuggestion ? `Fix: ${sanitizedSuggestion}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      await storage.saveObservation({
        sessionId: session.id,
        project,
        type: findingToObservationType(finding),
        title: `[${categoryLabel}] ${observationTitle}`,
        content,
        filePaths: [finding.file],
        severity: finding.severity,
      });
    }

    // Save a summary observation for the overall review
    await storage.saveObservation({
      sessionId: session.id,
      project,
      type: 'decision',
      title: `PR #${prNumber} review: ${result.status}`,
      content: stripPrivateData(result.summary),
      topicKey: `pr-${prNumber}-review`,
      filePaths: significantFindings.map((f) => f.file),
    });

    // End the session with a summary
    await storage.endSession(
      session.id,
      `Review of PR #${prNumber}: ${result.status} with ${significantFindings.length} significant findings.`,
    );
  } catch (error) {
    // Memory persistence is optional — never let it break the pipeline
    console.warn(
      '[ghagga] Failed to persist review observations (non-fatal):',
      error instanceof Error ? error.message : String(error),
    );
  }
}
