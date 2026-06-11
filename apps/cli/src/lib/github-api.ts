/**
 * Minimal GitHub REST API client for issue management.
 *
 * Uses native fetch (Node 20+) — zero external dependencies.
 * Auth via stored GitHub token from `ghagga login`.
 * Design: AD8 — minimal fetch wrapper, 3 endpoints only.
 */

import type { ReviewResult } from 'ghagga-core';
import { sanitizeMarkdownText, sanitizeTableCell } from 'ghagga-core';

// ─── Types ──────────────────────────────────────────────────────

export interface CreateIssueResult {
  url: string;
  number: number;
}

export interface CreateCommentResult {
  url: string;
}

// ─── Error ──────────────────────────────────────────────────────

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

// ─── Shared Headers ─────────────────────────────────────────────

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// ─── Error Handling ─────────────────────────────────────────────

async function handleErrorResponse(res: Response): Promise<never> {
  const body = await res.text();

  const messages: Record<number, string> = {
    401: 'Authentication failed — token may be expired. Run `ghagga login` to re-authenticate.',
    403: 'Insufficient permissions — token lacks repo scope.',
    404: 'Repository or issue not found.',
    410: 'Issues are disabled for this repository.',
    422: `Validation error: ${body}`,
    429: 'GitHub API rate limit exceeded. Wait a few minutes and try again.',
  };

  const message = messages[res.status] ?? `GitHub API error (${res.status}): ${body}`;
  throw new GitHubApiError(message, res.status, body);
}

// ─── API Functions ──────────────────────────────────────────────

/**
 * Create a new GitHub issue.
 * @throws GitHubApiError on auth failure, rate limit, or issues disabled.
 */
export async function createIssue(opts: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<CreateIssueResult> {
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues`;

  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(opts.token),
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      labels: opts.labels,
    }),
  });

  if (!res.ok) await handleErrorResponse(res);

  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}

/**
 * Post a comment on an existing GitHub issue.
 * @throws GitHubApiError on auth failure, rate limit, or issue not found.
 */
export async function createComment(opts: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<CreateCommentResult> {
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`;

  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(opts.token),
    body: JSON.stringify({ body: opts.body }),
  });

  if (!res.ok) await handleErrorResponse(res);

  const data = (await res.json()) as { html_url: string };
  return { url: data.html_url };
}

/**
 * Ensure a label exists on the repo. Creates it if missing.
 * Silently ignores 422 (already exists) and 403 (insufficient permissions).
 */
export async function ensureLabel(opts: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  color: string;
  description: string;
}): Promise<void> {
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/labels`;

  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(opts.token),
    body: JSON.stringify({
      name: opts.name,
      color: opts.color,
      description: opts.description,
    }),
  });

  // 201 = created, 422 = already exists, 403 = insufficient permissions
  // All are acceptable — only throw on unexpected errors
  if (!res.ok && res.status !== 422 && res.status !== 403) {
    await handleErrorResponse(res);
  }
}

// ─── Remote URL Parsing ─────────────────────────────────────────

/**
 * Parse owner/repo from a git remote URL.
 * Supports HTTPS, SSH (git@), and ssh:// protocol formats.
 * @throws if the remote is not a GitHub URL.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const trimmed = remoteUrl.trim();

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1] ?? '', repo: httpsMatch[2] ?? '' };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1] ?? '', repo: sshMatch[2] ?? '' };
  }

  // SSH protocol: ssh://git@github.com/owner/repo.git
  const sshProtoMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshProtoMatch) {
    return { owner: sshProtoMatch[1] ?? '', repo: sshProtoMatch[2] ?? '' };
  }

  throw new Error(`Not a GitHub remote URL: "${trimmed}"`);
}

// ─── Issue Body Formatting ──────────────────────────────────────

/**
 * Format a ReviewResult as a GitHub issue body with summary and collapsible details.
 */
export function formatIssueBody(result: ReviewResult, version: string): string {
  const timeSeconds = (result.metadata.executionTimeMs / 1000).toFixed(1);

  // Count findings by severity
  const counts: Record<string, number> = {};
  for (const f of result.findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  const countParts: string[] = [];
  for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as const) {
    if (counts[sev]) countParts.push(`${sev}: ${counts[sev]}`);
  }

  const lines: string[] = [];

  // Summary section
  lines.push('## Review Summary');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  // Status/mode/model are LLM/provider-derived — sanitize every cell so a
  // hostile value cannot break out of the table or smuggle HTML/mentions.
  lines.push(`| **Status** | ${sanitizeTableCell(String(result.status))} |`);
  lines.push(
    `| **Findings** | ${result.findings.length} total (${countParts.join(', ') || 'none'}) |`,
  );
  lines.push(`| **Mode** | ${sanitizeTableCell(String(result.metadata.mode))} |`);
  lines.push(`| **Model** | ${sanitizeTableCell(String(result.metadata.model))} |`);
  lines.push(`| **Execution time** | ${timeSeconds}s |`);
  lines.push('');

  // Collapsible full review
  lines.push('<details>');
  lines.push('<summary>Full Review Details</summary>');
  lines.push('');
  lines.push(formatFindingsMarkdown(result));
  lines.push('');
  lines.push('</details>');
  lines.push('');

  // Footer
  lines.push(`---`);
  lines.push(`*Generated by [GHAGGA](https://github.com/JNZader/ghagga) v${version}*`);

  return lines.join('\n');
}

/**
 * Format findings as markdown for the collapsible section.
 */
function formatFindingsMarkdown(result: ReviewResult): string {
  const lines: string[] = [];

  // Summary and findings are LLM output derived from the PR diff — sanitize
  // to block mention spam, hidden HTML comments, and raw HTML injection.
  lines.push(`**Summary:** ${sanitizeMarkdownText(result.summary, 2000)}`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('No findings. Clean! 🎉');
    return lines.join('\n');
  }

  for (const finding of result.findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    // Backticks would let a hostile file path escape the inline code span.
    const safeLocation = sanitizeTableCell(location).replace(/`/g, "'");
    const safeSeverity = sanitizeTableCell(String(finding.severity).toUpperCase());
    const safeMessage = sanitizeTableCell(finding.message);
    lines.push(`- **[${safeSeverity}]** \`${safeLocation}\` — ${safeMessage}`);
    if (finding.suggestion) {
      lines.push(`  - 💡 ${sanitizeTableCell(finding.suggestion)}`);
    }
  }

  return lines.join('\n');
}
