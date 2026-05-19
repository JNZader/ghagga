/**
 * Theme constants — icons, emojis, labels, and brand identity.
 *
 * All visual constants live here so command files never define
 * inline emoji maps or ANSI color codes (CC3).
 */

import type { FindingSeverity, ReviewStatus } from 'ghagga-core';

/** Brand identity for intro/outro. */
export const BRAND = {
  name: 'GHAGGA',
  tagline: 'AI Code Review',
} as const;

/** Status display with emoji. */
export const STATUS_EMOJI: Record<ReviewStatus, string> = {
  PASSED: '✅ PASSED',
  FAILED: '❌ FAILED',
  NEEDS_HUMAN_REVIEW: '⚠️  NEEDS HUMAN REVIEW',
  SKIPPED: '⏭️  SKIPPED',
  PARTIAL: '⚡ PARTIAL',
};

/** Severity indicator with colored emoji. */
export const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  info: '🟣',
};

/** Step icons for verbose progress output. */
export const STEP_ICON: Record<string, string> = {
  validate: '🔍',
  'parse-diff': '📄',
  'detect-stacks': '🧩',
  'token-budget': '📊',
  'static-analysis': '🛡️',
  'static-results': '📋',
  'agent-start': '🤖',
  'simple-call': '💬',
  'simple-done': '✅',
  'workflow-start': '🔄',
  'workflow-synthesis': '🧬',
  'consensus-start': '🗳️',
  'consensus-voting': '🏛️',
};

/** Source labels for review findings. */
export const SOURCE_LABELS: Record<string, string> = {
  semgrep: '🔍 Semgrep',
  trivy: '🛡️ Trivy',
  cpd: '📋 CPD',
  ai: '🤖 AI Review',
};

/**
 * Resolve the icon for a progress step.
 * Known steps use STEP_ICON, dynamic steps get fallback icons.
 */
export function resolveStepIcon(step: string): string {
  if (STEP_ICON[step]) return STEP_ICON[step];
  if (step.startsWith('specialist-')) return '👤';
  if (step.startsWith('vote-')) return '🗳️';
  return '▸';
}

/** Box-drawing characters for styled TUI output. */
export const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
} as const;

/** Divider character for section separators. */
export const DIVIDER_CHAR = '─';

/** Score thresholds for health grade coloring. */
export const SCORE_THRESHOLDS = {
  good: 80,
  warning: 50,
} as const;
