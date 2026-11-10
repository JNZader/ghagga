/**
 * Health recommendations — actionable advice from findings.
 */

import type { ReviewFinding } from '../types.js';

/** A single recommendation. */
export interface HealthRecommendation {
  category: string;
  action: string;
  impact: 'high' | 'medium' | 'low';
  findingCount: number;
}

/** Map finding source -> health category. */
const SOURCE_CATEGORY: Record<string, string> = {
  semgrep: 'security',
  trivy: 'dependencies',
  gitleaks: 'secrets',
  shellcheck: 'scripts',
  lizard: 'complexity',
  cpd: 'duplication',
  ruff: 'quality',
  eslint: 'quality',
  hadolint: 'containers',
  bandit: 'security',
  phpstan: 'quality',
  checkstyle: 'quality',
  detekt: 'quality',
  clippy: 'quality',
};

/** Recommendation templates per category. */
const TEMPLATES: Record<string, string> = {
  security:
    'Review and fix {count} security finding(s). Run static analysis regularly to catch vulnerabilities early.',
  dependencies:
    'Address {count} dependency issue(s). Run `npm audit fix` or update vulnerable packages.',
  secrets: 'Remove {count} exposed secret(s) immediately! Rotate any compromised credentials.',
  scripts: 'Fix {count} shell script issue(s). Consider using ShellCheck in your CI pipeline.',
  complexity:
    'Refactor {count} overly complex function(s). Break large functions into smaller units.',
  duplication:
    'Reduce {count} instance(s) of code duplication. Extract shared logic into reusable functions.',
  quality: 'Address {count} code quality issue(s). Configure linters in CI to prevent regressions.',
  containers:
    'Fix {count} Dockerfile issue(s). Follow Dockerfile best practices for smaller, more secure images.',
};

/** Severity weights for impact ranking. */
const IMPACT_WEIGHTS: Record<string, number> = {
  critical: 20,
  high: 10,
  medium: 3,
  low: 1,
  info: 0,
};

/**
 * Generate actionable recommendations from findings.
 * Groups by category, sorts by impact, returns top N.
 */
export function generateRecommendations(
  findings: ReviewFinding[],
  limit = 5,
): HealthRecommendation[] {
  if (findings.length === 0) return [];

  // Group findings by category
  const categories = new Map<string, { findings: ReviewFinding[]; impact: number }>();

  for (const finding of findings) {
    const category = SOURCE_CATEGORY[finding.source] ?? 'quality';
    let cat = categories.get(category);
    if (!cat) {
      cat = { findings: [], impact: 0 };
      categories.set(category, cat);
    }
    cat.findings.push(finding);
    cat.impact += IMPACT_WEIGHTS[finding.severity] ?? 0;
  }

  // Filter out categories with only info findings (zero impact)
  const meaningful = Array.from(categories.entries()).filter(([, data]) => data.impact > 0);

  // Sort by impact (highest first)
  meaningful.sort((a, b) => b[1].impact - a[1].impact);

  // Generate recommendations
  return meaningful.slice(0, limit).map(([category, data]) => {
    const template = TEMPLATES[category] ?? `Address {count} ${category} issue(s).`;
    const action = template.replace('{count}', String(data.findings.length));

    let impact: HealthRecommendation['impact'];
    if (data.impact >= 20) impact = 'high';
    else if (data.impact >= 5) impact = 'medium';
    else impact = 'low';

    return {
      category,
      action,
      impact,
      findingCount: data.findings.length,
    };
  });
}
