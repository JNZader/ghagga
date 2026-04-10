/**
 * PR comment formatting for GHAGGA code reviews.
 *
 * Renders a ReviewResult as a GitHub-flavored Markdown comment
 * suitable for posting to a PR via the GitHub API.
 */

import { calculateReviewCost, formatCostFooter } from './cost-footer.js';
import { initializeDefaultTools } from './tools/plugins/index.js';
import { toolRegistry } from './tools/registry.js';
import { isToolRegistryEnabled } from './tools/runner.js';
import type { ReviewResult, ReviewStatus } from './types.js';

// ─── File Stats Types ───────────────────────────────────────────

export interface FileStats {
  additions: number;
  deletions: number;
}

// ─── File Category Types ────────────────────────────────────────

interface FileCategory {
  key: string;
  name: string;
  emoji: string;
  patterns: RegExp[];
}

export const FILE_CATEGORIES: FileCategory[] = [
  {
    key: 'test',
    name: 'Tests',
    emoji: '\ud83e\uddea',
    patterns: [/\.test\./, /\.spec\./, /__tests__/, /test[s]?\//],
  },
  {
    key: 'docs',
    name: 'Docs',
    emoji: '\ud83d\udcdd',
    patterns: [/\.md$/, /docs?\//, /README/, /CHANGELOG/],
  },
  {
    key: 'ci',
    name: 'CI/CD',
    emoji: '\ud83d\udd04',
    patterns: [/\.github\/workflows/, /\.gitlab-ci/, /Jenkinsfile/],
  },
  {
    key: 'config',
    name: 'Config',
    emoji: '\u2699\ufe0f',
    patterns: [
      /\.config\.[jt]s$/,
      /tsconfig/,
      /\.eslint/,
      /\.prettier/,
      /Dockerfile/,
      /docker-compose/,
    ],
  },
  {
    key: 'deps',
    name: 'Dependencies',
    emoji: '\ud83d\udce6',
    patterns: [
      /package(-lock)?\.json$/,
      /yarn\.lock/,
      /pnpm-lock/,
      /go\.(mod|sum)$/,
      /requirements.*\.txt$/,
    ],
  },
  {
    key: 'style',
    name: 'Styling',
    emoji: '\ud83c\udfa8',
    patterns: [/\.css$/, /\.scss$/, /\.sass$/, /\.less$/],
  },
  {
    key: 'migration',
    name: 'Database',
    emoji: '\ud83d\uddc4\ufe0f',
    patterns: [/migrat/, /schema\./, /seed\./],
  },
  {
    key: 'api',
    name: 'API',
    emoji: '\ud83d\udd0c',
    patterns: [/routes?\//, /api\//, /controllers?\//, /handlers?\//],
  },
  {
    key: 'ui',
    name: 'UI',
    emoji: '\ud83d\uddbc\ufe0f',
    patterns: [/components?\//, /pages?\//, /views?\//, /\.tsx$/],
  },
  { key: 'core', name: 'Core', emoji: '\ud83d\udd27', patterns: [/src\//, /lib\//, /\.[jt]sx?$/] },
];

// ─── Constants ──────────────────────────────────────────────────

export const STATUS_EMOJI: Record<ReviewStatus, string> = {
  PASSED: '\u2705 PASSED',
  FAILED: '\u274c FAILED',
  NEEDS_HUMAN_REVIEW: '\u26a0\ufe0f NEEDS_HUMAN_REVIEW',
  SKIPPED: '\u23ed\ufe0f SKIPPED',
  PARTIAL: '\u26a1 PARTIAL',
};

export const SEVERITY_EMOJI: Record<string, string> = {
  critical: '\ud83d\udd34',
  high: '\ud83d\udfe0',
  medium: '\ud83d\udfe1',
  low: '\ud83d\udfe2',
  info: '\ud83d\udfe3',
};

// ─── Formatting Helpers ─────────────────────────────────────────

/** Idempotent comment marker — used to find and update existing comments. */
export const REVIEW_COMMENT_MARKER = '<!-- ghagga-review -->';

const STATS_BAR_BLOCKS = 20;

/**
 * Build a visual emoji stats bar showing additions vs deletions.
 *
 * Format: `🟩🟩🟩🟩🟩🟩🟩🟩🟩🟥🟥 +120 / -15 (net +105)`
 * Uses 20 emoji blocks proportional to the add/delete ratio.
 */
export function buildStatsBar(stats: FileStats): string {
  const total = stats.additions + stats.deletions;
  if (total === 0) return '';

  const greenCount = Math.round((stats.additions / total) * STATS_BAR_BLOCKS);
  const redCount = STATS_BAR_BLOCKS - greenCount;

  const bar = '\ud83d\udfe9'.repeat(greenCount) + '\ud83d\udfe5'.repeat(redCount);
  const net = stats.additions - stats.deletions;
  const netStr = net >= 0 ? `+${net}` : `${net}`;

  return `${bar} +${stats.additions} / -${stats.deletions} (net ${netStr})`;
}

/**
 * Categorize a list of file paths into groups.
 * Returns categories with at least one file, in definition order.
 */
export function categorizeFiles(
  fileList: string[],
): Array<{ name: string; emoji: string; files: string[] }> {
  const categorized = new Map<string, string[]>();
  const assigned = new Set<string>();

  for (const cat of FILE_CATEGORIES) {
    const matched: string[] = [];
    for (const filePath of fileList) {
      if (assigned.has(filePath)) continue;
      if (cat.patterns.some((p) => p.test(filePath))) {
        matched.push(filePath);
        assigned.add(filePath);
      }
    }
    if (matched.length > 0) {
      categorized.set(cat.key, matched);
    }
  }

  // Return in definition order, only non-empty categories
  return FILE_CATEGORIES.filter((cat) => categorized.has(cat.key)).map((cat) => ({
    name: cat.name,
    emoji: cat.emoji,
    files: categorized.get(cat.key)!,
  }));
}

/**
 * Format a file category summary section.
 * Max 3 files shown per category, then "+N more".
 */
export function formatFileCategorySummary(fileList: string[]): string {
  const categories = categorizeFiles(fileList);
  if (categories.length === 0) return '';

  let section = `### Files Changed (${fileList.length})\n`;

  for (const cat of categories) {
    const basenames = cat.files.map((f) => f.split('/').pop() ?? f);
    const MAX_SHOWN = 3;
    const shown = basenames.slice(0, MAX_SHOWN);
    const remaining = basenames.length - MAX_SHOWN;

    section += `${cat.emoji} **${cat.name}**: ${shown.join(', ')}`;
    if (remaining > 0) {
      section += ` (+${remaining} more)`;
    }
    section += '\n';
  }

  return `${section}\n`;
}

// ─── Format Options ─────────────────────────────────────────────

export interface FormatReviewCommentOptions {
  /** File-level additions/deletions stats. When provided, renders the emoji stats bar. */
  fileStats?: FileStats;
  /** List of changed file paths. When provided, renders the categorized file summary. */
  fileList?: string[];
  /**
   * GitHub username of the PR author. When provided, a @mention is appended
   * so GitHub sends a notification to the author when the review is posted.
   */
  prAuthor?: string;
}

// ─── Formatting ─────────────────────────────────────────────────

export function formatReviewComment(
  result: ReviewResult,
  options?: FormatReviewCommentOptions,
): string {
  const status = STATUS_EMOJI[result.status] ?? result.status;
  const timeSeconds = (result.metadata.executionTimeMs / 1000).toFixed(1);

  let comment = `${REVIEW_COMMENT_MARKER}\n## \ud83e\udd16 GHAGGA Code Review\n\n`;
  comment += `**Status:** ${status}\n`;
  const modelsUsed = result.metadata.modelsUsed;
  if (modelsUsed && modelsUsed.length > 1) {
    // Multi-model: show primary model + details per specialist/stance
    comment += `**Mode:** ${result.metadata.mode} | **Model:** ${result.metadata.model} | **Time:** ${timeSeconds}s\n`;
    comment += `<details><summary>\ud83e\udde0 Models used (${modelsUsed.length})</summary>\n\n`;
    comment += '| Role | Model |\n|------|-------|\n';
    for (const entry of modelsUsed) {
      const [role, model] = entry.includes(':') ? entry.split(':', 2) : ['—', entry];
      comment += `| ${role} | \`${model}\` |\n`;
    }
    comment += '\n</details>\n';
  } else {
    comment += `**Mode:** ${result.metadata.mode} | **Model:** ${result.metadata.model} | **Time:** ${timeSeconds}s\n`;
  }

  // Emoji stats bar (Enhancement 1)
  if (options?.fileStats) {
    const statsBar = buildStatsBar(options.fileStats);
    if (statsBar) {
      comment += `${statsBar}\n`;
    }
  }

  comment += '\n';

  // Summary
  comment += `### Summary\n${result.summary}\n\n`;

  // Findings grouped by source
  if (result.findings.length > 0) {
    comment += `### Findings (${result.findings.length})\n\n`;

    // Group findings by source
    const grouped = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      const src = finding.source ?? 'ai';
      if (!grouped.has(src)) grouped.set(src, []);
      grouped.get(src)?.push(finding);
    }

    // Render order: static tools first, then AI
    // Generate SOURCE_LABELS dynamically from registry when available
    const SOURCE_LABELS: Record<string, string> = {
      // Legacy defaults (always present)
      semgrep: '\ud83d\udd0d Semgrep',
      trivy: '\ud83d\udee1\ufe0f Trivy',
      cpd: '\ud83d\udccb CPD',
      ai: '\ud83e\udd16 AI Review',
    };

    const renderOrder: string[] = [];

    if (isToolRegistryEnabled()) {
      initializeDefaultTools();
      for (const tool of toolRegistry.getAll()) {
        SOURCE_LABELS[tool.name] = `\ud83d\udd27 ${tool.displayName}`;
        renderOrder.push(tool.name);
      }
    } else {
      renderOrder.push('semgrep', 'trivy', 'cpd');
    }

    // AI always comes last; also include any unknown sources from grouped keys
    for (const src of grouped.keys()) {
      if (src !== 'ai' && !renderOrder.includes(src)) {
        renderOrder.push(src);
      }
    }
    renderOrder.push('ai');

    for (const src of renderOrder) {
      const findings = grouped.get(src);
      if (!findings || findings.length === 0) continue;

      const label = SOURCE_LABELS[src] ?? src;
      comment += `**${label} (${findings.length})**\n`;
      comment += `| Severity | Category | File | Message |\n`;
      comment += `|----------|----------|------|----------|\n`;

      for (const finding of findings) {
        const emoji = SEVERITY_EMOJI[finding.severity] ?? '';
        const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
        const message = finding.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        comment += `| ${emoji} ${finding.severity} | ${finding.category} | ${location} | ${message} |\n`;
      }
      comment += '\n';
    }
  }

  // Static analysis summary
  const staticTools = result.metadata.toolsRun;
  const skippedTools = result.metadata.toolsSkipped;
  if (staticTools.length > 0 || skippedTools.length > 0) {
    comment += `### Static Analysis\n`;
    if (staticTools.length > 0) {
      comment += `\u2705 Tools run: ${staticTools.join(', ')}\n`;
    }
    if (skippedTools.length > 0) {
      comment += `\u23ed\ufe0f Tools skipped: ${skippedTools.join(', ')}\n`;
    }
    comment += '\n';
  }

  // File category summary (Enhancement 3)
  if (options?.fileList && options.fileList.length > 0) {
    comment += formatFileCategorySummary(options.fileList);
  }

  // Cost footer
  const cost = calculateReviewCost(result.metadata.tokensUsed, result.metadata.model);
  comment += formatCostFooter(cost);

  comment += `---\n*Powered by [GHAGGA](https://github.com/JNZader/ghagga) \u2014 AI Code Review*`;

  // @mention the PR author so GitHub sends them a notification.
  // Rendered as small text to keep the footer clean.
  if (options?.prAuthor) {
    comment += ` — @${options.prAuthor}`;
  }

  return comment;
}
