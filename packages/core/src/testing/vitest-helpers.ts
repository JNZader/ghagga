/**
 * Vitest integration helpers for the GHAGGA regression testing framework.
 *
 * Usage:
 *   import { describeTrace } from "@ghagga/core/testing/vitest-helpers.js";
 *
 *   describeTrace("fixtures/my-trace.json", [
 *     {
 *       label: "finds SQL injection",
 *       mustFind: [{ category: "security", messageContains: "SQL injection" }],
 *     },
 *   ]);
 */

import { describe, expect, it } from 'vitest';
import { assertTrace, loadTrace, type TraceAssertion } from './index.js';

/**
 * Create a vitest `describe` block that loads a trace from disk and runs
 * all provided assertions as a single `it` test.
 *
 * Failing assertions produce an error message listing every failed check
 * so the full picture is visible without multiple test-run iterations.
 *
 * @param tracePath  - Path to the JSON trace file (absolute or cwd-relative)
 * @param assertions - Array of structural assertions to evaluate
 */
export function describeTrace(tracePath: string, assertions: TraceAssertion[]): void {
  describe(`Trace: ${tracePath}`, () => {
    it('passes all assertions', async () => {
      const trace = await loadTrace(tracePath);
      const result = await assertTrace(trace, assertions);
      if (!result.passed) throw new Error(result.failures.join('\n'));
      expect(result.passed).toBe(true);
    });
  });
}
