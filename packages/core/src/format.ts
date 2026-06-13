/**
 * PR comment formatting for GHAGGA code reviews.
 *
 * Renders a ReviewResult as a GitHub-flavored Markdown comment
 * suitable for posting to a PR via the GitHub API.
 */

import { calculateReviewCost, formatCostFooter } from './cost-footer.js';
import { isValidGithubLogin, sanitizeMarkdownText, sanitizeTableCell } from './sanitize.js';
import type { EntityChange, EntityChangeKind, SemanticDiff } from './semantic-diff/index.js';
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
    // File names come straight from the PR (attacker-controlled) → contain the
    // basename in inline code (newline/autolink injection sink). See
    // sanitizeBasename.
    const basenames = cat.files.map((f) => sanitizeBasename(f));
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

// ─── "What changed" semantic-diff section ──────────────────────

/**
 * Extensions whose entities are surfaced in the "What changed" section.
 *
 * Presentation policy (NOT a module concern — the extractor reports every
 * language): only TS/JS entities are meaningful here. Anything else (`.py`,
 * `.go`, `.md`, the `unknown` pseudo-path from bare diff fragments) is noise
 * and is dropped. Kept in sync with the design (D3).
 *
 * Covers the full TS/JS ESM/CJS module-extension set — including the TS
 * variants `.mts`/`.cts`, which are real TypeScript files (the project's own
 * canonical TS/JS gate, `tools/plugins/biome.ts`, includes them). Omitting
 * them would silently drop genuine TS entities from the section.
 */
const SEMANTIC_DIFF_TS_JS_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Max entity rows shown before collapsing the rest into a "+N more" line. */
const SEMANTIC_DIFF_ENTITY_CAP = 10;

/** Per-direction emoji for an entity change. */
const ENTITY_DIRECTION_EMOJI = {
  added: '➕', // ➕
  removed: '➖', // ➖
  modified: '✏️', // ✏️
} as const;

type EntityDirection = keyof typeof ENTITY_DIRECTION_EMOJI;

/** Human-readable label for the non-direction part of an EntityChangeKind. */
const ENTITY_NOUN: Record<string, string> = {
  function: 'function',
  class: 'class',
  type: 'type',
  export: 'export',
};

/**
 * Parse an `{noun}_{direction}` EntityChangeKind into its two parts.
 * Returns null for kinds we never render here (`method_*` is dropped upstream,
 * `import_*` is handled as counts).
 */
function splitEntityKind(
  kind: EntityChangeKind,
): { noun: string; direction: EntityDirection } | null {
  const idx = kind.lastIndexOf('_');
  if (idx < 0) return null;
  const noun = kind.slice(0, idx);
  const direction = kind.slice(idx + 1);
  if (direction !== 'added' && direction !== 'removed' && direction !== 'modified') return null;
  if (!(noun in ENTITY_NOUN)) return null;
  return { noun, direction };
}

/**
 * Sanitize an attacker-controlled entity name for safe rendering INSIDE an
 * inline-code span (`` `name` ``).
 *
 * `sanitizeTableCell` already strips HTML comments, escapes `<` (kills raw
 * HTML and `</details>` breakout), neutralizes `@`-mentions, escapes pipes and
 * flattens newlines. But it does NOT touch backticks — and the name is wrapped
 * in backticks. A name containing a backtick would CLOSE the inline-code span
 * and let trailing markup (e.g. `[x](javascript:…)`, a code-fence breakout, or
 * a live mention) render. So we additionally strip every backtick. With
 * backticks gone, link/fence/markup metacharacters that survive (`[`, `]`,
 * `(`, `)`) stay inert literal text inside the code span.
 */
function sanitizeInlineCodeName(name: string): string {
  return sanitizeTableCell(name, 200).replace(/`/g, '');
}

/**
 * Render an attacker-controlled file path's BASENAME wrapped in an inline-code
 * span (`` `name` ``) — safe against markdown-structure injection.
 *
 * A file basename is fully attacker-controlled: git emits diff headers for
 * paths containing arbitrary bytes (octal/`\n` escapes in quoted headers,
 * decoded by `unescapeQuotedPath` in diff/parse.ts:83 into a REAL newline that
 * survives into `filePath`). `sanitizeMarkdownText` alone does NOT defang this:
 * it does not flatten newlines (only normalizes CRLF) and does not suppress
 * `#1234`/SHA/`@` auto-links. A basename like `x\n# PWNED\n| t |` rendered as
 * `**${basename}**` therefore breaks the bold span and injects a live heading,
 * table, and bullets into the bot's own comment; `#refs`/40-hex SHAs in the
 * basename auto-link (notification spam / forged backlinks).
 *
 * Containing the basename in inline code closes all three vectors at once:
 *   (a) `sanitizeTableCell` flattens `\n`/CRLF to spaces and escapes pipes
 *       (no structural breakout);
 *   (b) GitHub does NOT auto-link `#refs`/SHAs/`@mentions` inside a code span;
 *   (c) `sanitizeInlineCodeName` strips backticks so the name cannot close the
 *       span and let trailing markup render.
 */
function sanitizeBasename(path: string): string {
  return `\`${sanitizeInlineCodeName(path.split('/').pop() ?? path)}\``;
}

/**
 * Render the "What changed" semantic-diff section for a PR comment.
 *
 * Reads the (optional) entity-level diff and applies PRESENTATION filters
 * (design D3) — the extractor itself reports everything; what to SHOW is the
 * comment's policy:
 *
 *   1. drop every `method_*` entry (100% noise: `it()`, `expect()`, markdown
 *      prose mistaken for declarations);
 *   2. keep only entities from TS/JS files (`SEMANTIC_DIFF_TS_JS_EXT_RE`);
 *   3. split off import changes → rendered as aggregate COUNTS (no module
 *      names: noise, and avoids extra sanitization surface);
 *   4. cap visible non-import entities at `SEMANTIC_DIFF_ENTITY_CAP`, with a
 *      `_+N more entities_` indicator;
 *   5. GUARD: if zero non-import entities survive, return `''` — the section is
 *      NOT shown for imports-only (or empty) diffs (silent degradation; the
 *      comment stays byte-identical to having no section at all).
 *
 * Ordering is stable/deterministic: entities are grouped by file in first-seen
 * order (the diff's order), and within a file in their original change order.
 *
 * Entity NAMES come from the diff (attacker-controlled) and are wrapped in
 * inline code after `sanitizeInlineCodeName`. Signatures are NEVER rendered
 * (injection surface + noise).
 *
 * @param semanticDiff entity-level diff, or undefined when extraction was
 *   skipped (SKIPPED early-return, warn-only failure, or the size gate).
 *   `undefined` (and an empty diff) both yield `''`.
 */
export function formatSemanticDiffSection(semanticDiff: SemanticDiff | undefined): string {
  if (!semanticDiff || semanticDiff.changes.length === 0) return '';

  // Pass 1: partition into renderable entities vs import counts, applying the
  // method-drop and extension gate. Preserve first-seen file order.
  const entitiesByFile = new Map<string, EntityChange[]>();
  let entityCount = 0;
  let importsAdded = 0;
  let importsRemoved = 0;
  let importsModified = 0;

  for (const change of semanticDiff.changes) {
    // Gate 2: TS/JS only (also drops the `unknown` pseudo-path for free).
    if (!SEMANTIC_DIFF_TS_JS_EXT_RE.test(change.filePath)) continue;

    if (change.kind.startsWith('import_')) {
      if (change.kind === 'import_added') importsAdded++;
      else if (change.kind === 'import_removed') importsRemoved++;
      else importsModified++;
      continue;
    }

    // Gate 1: drop method noise entirely.
    if (change.kind.startsWith('method_')) continue;

    // Anything left must be a renderable noun (function/class/type/export).
    if (!splitEntityKind(change.kind)) continue;

    const bucket = entitiesByFile.get(change.filePath);
    if (bucket) {
      bucket.push(change);
    } else {
      entitiesByFile.set(change.filePath, [change]);
    }
    entityCount++;
  }

  // Guard: imports-only (or fully-filtered) diffs do NOT get a section.
  if (entityCount === 0) return '';

  const totalImportChanges = importsAdded + importsRemoved + importsModified;

  // Pass 2: render up to the cap, grouped by file in first-seen order.
  // A file header is only emitted once at least one of its bullets renders, so
  // hitting the cap exactly at a file boundary never leaves a dangling header.
  const lines: string[] = [];
  let shown = 0;

  for (const [filePath, changes] of entitiesByFile) {
    if (shown >= SEMANTIC_DIFF_ENTITY_CAP) break;
    const fileBullets: string[] = [];
    for (const change of changes) {
      if (shown >= SEMANTIC_DIFF_ENTITY_CAP) break;
      const parts = splitEntityKind(change.kind);
      // Unreachable (partitioning above guarantees a noun) — defensive.
      if (!parts) continue;
      const emoji = ENTITY_DIRECTION_EMOJI[parts.direction];
      const noun = ENTITY_NOUN[parts.noun] ?? parts.noun;
      const safeName = sanitizeInlineCodeName(change.name);
      fileBullets.push(`- ${emoji} ${noun} \`${safeName}\``);
      shown++;
    }
    if (fileBullets.length > 0) {
      // Basename only; path is fully attacker-controlled (newline/autolink
      // injection sink) → contain in inline code. See sanitizeBasename.
      lines.push(`**${sanitizeBasename(filePath)}**`, ...fileBullets);
    }
  }

  const remaining = entityCount - shown;

  // Summary line: entity count + (optional) import-change count.
  const summaryParts = [`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}`];
  if (totalImportChanges > 0) {
    summaryParts.push(
      `${totalImportChanges} import ${totalImportChanges === 1 ? 'change' : 'changes'}`,
    );
  }

  let section = '<details>\n';
  section += `<summary>🧬 What changed (${summaryParts.join(' · ')})</summary>\n\n`;
  section += lines.join('\n');
  section += '\n';
  if (remaining > 0) {
    section += `\n_+${remaining} more ${remaining === 1 ? 'entity' : 'entities'}_\n`;
  }

  if (totalImportChanges > 0) {
    const importParts: string[] = [];
    if (importsAdded > 0) importParts.push(`${importsAdded} added`);
    if (importsRemoved > 0) importParts.push(`${importsRemoved} removed`);
    if (importsModified > 0) importParts.push(`${importsModified} modified`);
    section += `\n**Imports:** ${importParts.join(' · ')}\n`;
  }

  section += '</details>\n';
  return section;
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
  // Mode/model labels are derived from provider responses and settings —
  // treat as untrusted and sanitize before rendering.
  const safeMode = sanitizeTableCell(String(result.metadata.mode));
  const safeModel = sanitizeTableCell(String(result.metadata.model));
  if (modelsUsed && modelsUsed.length > 1) {
    // Multi-model: show primary model + details per specialist/stance
    comment += `**Mode:** ${safeMode} | **Model:** ${safeModel} | **Time:** ${timeSeconds}s\n`;
    comment += `<details><summary>\ud83e\udde0 Models used (${modelsUsed.length})</summary>\n\n`;
    comment += '| Role | Model |\n|------|-------|\n';
    for (const entry of modelsUsed) {
      const [role, model] = entry.includes(':') ? entry.split(':', 2) : ['—', entry];
      // Role/model strings come from provider output — sanitize each cell.
      comment += `| ${sanitizeTableCell(role ?? '—')} | \`${sanitizeInlineCodeName(model ?? '')}\` |\n`;
    }
    comment += '\n</details>\n';
  } else {
    comment += `**Mode:** ${safeMode} | **Model:** ${safeModel} | **Time:** ${timeSeconds}s\n`;
  }

  // Emoji stats bar (Enhancement 1)
  if (options?.fileStats) {
    const statsBar = buildStatsBar(options.fileStats);
    if (statsBar) {
      comment += `${statsBar}\n`;
    }
  }

  comment += '\n';

  // Summary — raw LLM output derived from the (attacker-controlled) PR diff.
  // Sanitized to block mention spam, hidden HTML comments, and flooding.
  comment += `### Summary\n${sanitizeMarkdownText(result.summary, 2000)}\n\n`;

  // "What changed" entity-level section (design D4) — placed between Summary
  // and Findings. Returns '' (silent degradation) when semanticDiff is absent
  // or no non-import entity survives the presentation filters, in which case
  // the comment stays byte-identical to having no section at all.
  comment += formatSemanticDiffSection(result.semanticDiff);

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

      // Registry labels are trusted literals; unknown sources come from
      // finding.source (LLM/tool output) and must be sanitized.
      const label = SOURCE_LABELS[src] ?? sanitizeTableCell(src);
      comment += `**${label} (${findings.length})**\n`;
      comment += `| Severity | Category | File | Message |\n`;
      comment += `|----------|----------|------|----------|\n`;

      for (const finding of findings) {
        const emoji = SEVERITY_EMOJI[finding.severity] ?? '';
        // ALL finding fields are LLM/tool-derived (and ultimately derived
        // from the attacker-controlled PR diff) — sanitize every cell, not
        // just the message.
        const severity = sanitizeTableCell(String(finding.severity));
        const category = sanitizeTableCell(String(finding.category));
        const location = sanitizeTableCell(
          finding.line ? `${finding.file}:${finding.line}` : finding.file,
        );
        const message = sanitizeTableCell(finding.message);
        comment += `| ${emoji} ${severity} | ${category} | ${location} | ${message} |\n`;
      }
      comment += '\n';
    }
  }

  // Static analysis summary.
  // toolsRun / toolsSkipped originate from the runner-callback payload
  // (apps/server runner-callback.ts \u2192 pipeline.ts \u2192 here), which is
  // attacker-influenceable. Sanitize every tool name before joining into
  // Markdown so a crafted name (e.g. "evil<!--x-->", "@org/everyone", or an
  // HTML/link injection) cannot break out of the comment.
  const staticTools = result.metadata.toolsRun.map((t) => sanitizeMarkdownText(String(t), 100));
  const skippedTools = result.metadata.toolsSkipped.map((t) =>
    sanitizeMarkdownText(String(t), 100),
  );
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
  // The author login comes from the webhook payload — only mention it if it
  // is a syntactically valid GitHub login (blocks "@org/everyone"-style
  // injection); otherwise omit the mention entirely.
  if (options?.prAuthor && isValidGithubLogin(options.prAuthor)) {
    comment += ` — @${options.prAuthor}`;
  }

  return comment;
}
