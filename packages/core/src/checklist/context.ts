/**
 * Checklist context builder — generates compact prompt text for AI agents.
 *
 * Produces a markdown checklist that agents evaluate code against.
 * Capped to ~600 tokens to avoid blowing the token budget.
 */

import type { ChecklistConfig, ChecklistDimension } from './types.js';

/** Approximate max characters for checklist context (~600 tokens at 4 chars/token). */
const MAX_CONTEXT_CHARS = 2400;

/**
 * Build a compact checklist context string for injection into agent prompts.
 *
 * Only includes enabled dimensions and enabled checks.
 * Returns empty string if no checks are active.
 *
 * @param config - Resolved checklist configuration
 * @returns Formatted markdown checklist, or empty string if nothing active
 */
export function buildChecklistContext(config: ChecklistConfig): string {
  const activeDimensions = config.dimensions.filter((d) => d.enabled);
  if (activeDimensions.length === 0) return '';

  const lines: string[] = [
    '## Review Checklist (evaluate each applicable check)',
    '',
  ];

  for (const dim of activeDimensions) {
    const activeChecks = dim.checks.filter((c) => c.enabled);
    if (activeChecks.length === 0) continue;

    lines.push(`### ${dim.name}`);
    for (const check of activeChecks) {
      lines.push(`- [w:${check.weight}] ${check.description}`);
    }
    lines.push('');
  }

  if (lines.length <= 2) return ''; // Only header, no actual checks

  lines.push('> Weight indicates importance (1-10). Flag violations with their check weight.');

  const context = lines.join('\n');

  // Truncate if over budget
  if (context.length > MAX_CONTEXT_CHARS) {
    return truncateContext(activeDimensions);
  }

  return context;
}

/**
 * Truncate by including only high-weight checks (weight >= 7).
 * This reduces context while keeping the most important checks.
 */
function truncateContext(dimensions: ChecklistDimension[]): string {
  const lines: string[] = [
    '## Review Checklist (high-priority checks only)',
    '',
  ];

  for (const dim of dimensions) {
    const highWeightChecks = dim.checks.filter((c) => c.enabled && c.weight >= 7);
    if (highWeightChecks.length === 0) continue;

    lines.push(`### ${dim.name}`);
    for (const check of highWeightChecks) {
      lines.push(`- [w:${check.weight}] ${check.description}`);
    }
    lines.push('');
  }

  lines.push('> Truncated to high-priority checks (weight >= 7). Flag violations with their check weight.');

  return lines.join('\n');
}

/**
 * Count the total number of active checks across all enabled dimensions.
 */
export function countActiveChecks(config: ChecklistConfig): number {
  return config.dimensions
    .filter((d) => d.enabled)
    .reduce(
      (sum, dim) => sum + dim.checks.filter((c) => c.enabled).length,
      0,
    );
}
