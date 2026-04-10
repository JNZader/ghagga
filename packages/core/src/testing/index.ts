/**
 * Regression testing framework for GHAGGA reviews.
 *
 * Lets you record a ReviewInput → ReviewResult pair as a "trace",
 * load it back later, and assert that the trace still satisfies a
 * set of structural constraints.
 *
 * Designed to be used in CI to catch regressions in the review engine.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { ReviewFinding, ReviewInput, ReviewResult } from '../types.js';

// ─── Public types ────────────────────────────────────────────────

export interface ReviewTrace {
  input: ReviewInput;
  output: ReviewResult;
  recordedAt: string;
  label: string;
}

/**
 * A single assertion spec for a recorded trace.
 * `mustFind` requires at least one matching finding.
 * `mustNotFind` requires zero matching findings.
 */
export interface TraceAssertion {
  label: string;

  /** Each entry must match at least one finding in the trace output. */
  mustFind: Array<{
    filePath?: string;
    category?: string;
    severity?: string;
    messageContains?: string;
  }>;

  /** Each entry must NOT match any finding in the trace output. */
  mustNotFind?: Array<{
    filePath?: string;
    category?: string;
    messageContains?: string;
  }>;
}

// ─── I/O helpers ────────────────────────────────────────────────

/**
 * Persist a ReviewTrace to disk as pretty-printed JSON.
 *
 * @param trace      - The trace to record
 * @param outputPath - Absolute or relative path for the output file
 */
export async function recordTrace(trace: ReviewTrace, outputPath: string): Promise<void> {
  await writeFile(outputPath, JSON.stringify(trace, null, 2), 'utf8');
}

/**
 * Load a ReviewTrace from a JSON file on disk.
 *
 * @param tracePath - Path to the trace file written by {@link recordTrace}
 * @returns         Parsed ReviewTrace
 * @throws          If the file does not exist or contains invalid JSON
 */
export async function loadTrace(tracePath: string): Promise<ReviewTrace> {
  const raw = await readFile(tracePath, 'utf8');
  return JSON.parse(raw) as ReviewTrace;
}

// ─── Assertion engine ────────────────────────────────────────────

function findingMatchesMatcher(
  finding: ReviewFinding,
  matcher: {
    filePath?: string;
    category?: string;
    severity?: string;
    messageContains?: string;
  },
): boolean {
  if (matcher.filePath !== undefined && finding.file !== matcher.filePath) return false;
  if (matcher.category !== undefined && finding.category !== matcher.category) return false;
  if (matcher.severity !== undefined && finding.severity !== matcher.severity) return false;
  if (matcher.messageContains !== undefined && !finding.message.includes(matcher.messageContains)) {
    return false;
  }
  return true;
}

/**
 * Run a set of TraceAssertions against a loaded trace.
 *
 * Returns `{ passed: true, failures: [] }` when all assertions pass,
 * or `{ passed: false, failures: [...] }` with a human-readable list
 * of failures when something does not match.
 *
 * @param trace      - The loaded ReviewTrace to validate
 * @param assertions - Array of {@link TraceAssertion} to evaluate
 */
export async function assertTrace(
  trace: ReviewTrace,
  assertions: TraceAssertion[],
): Promise<{ passed: boolean; failures: string[] }> {
  const findings = trace.output.findings;
  const failures: string[] = [];

  for (const assertion of assertions) {
    // ── mustFind ────────────────────────────────────────────
    for (const matcher of assertion.mustFind) {
      const found = findings.some((f) => findingMatchesMatcher(f, matcher));
      if (!found) {
        failures.push(
          `[${assertion.label}] mustFind: no finding matched ${JSON.stringify(matcher)}`,
        );
      }
    }

    // ── mustNotFind ─────────────────────────────────────────
    for (const matcher of assertion.mustNotFind ?? []) {
      const found = findings.some((f) => findingMatchesMatcher(f, matcher));
      if (found) {
        failures.push(
          `[${assertion.label}] mustNotFind: unexpected finding matched ${JSON.stringify(matcher)}`,
        );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}
