/**
 * GitHub API client utilities.
 *
 * Uses native fetch for all HTTP calls and Node.js crypto for
 * JWT creation and webhook signature verification. No extra deps.
 *
 * ─── FORGE-ADAPTER BOUNDARY (SDD forge-agnostic 1.5/1.6) ─────────
 *
 * The 12 forge-adapter functions in this module are INTERNAL. They are tagged
 * `@internal` individually and MUST be consumed via `GitHubForgeAdapter`, built
 * through the composition root at
 * `apps/server/src/github/forge-adapter-factory.ts` (`makeGitHubAdapter`). Do
 * NOT import these directly anywhere in `apps/server` outside that factory — the
 * forge-boundary lint (`noRestrictedImports` in biome.json) enforces this.
 *
 * The 12 forge-adapter fns:
 *   fetchPRDiff, fetchPRDetails, getPRFileList, getPRCommitMessages,
 *   postComment, findExistingComment, deleteComment, updateComment,
 *   addCommentReaction, fetchGraphFromBranch, fetchGraphMetadata,
 *   fetchFileContents.
 *
 * NOT forge-adapter fns (remain directly importable everywhere):
 *   - getInstallationToken — the auth/token-mint seam
 *   - verifyWebhookSignature — webhook signature check
 *   plus any shared constants/types exported from this module.
 */

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';

// ─── Errors ─────────────────────────────────────────────────────

/**
 * An error from a GitHub REST call, carrying the HTTP `status`.
 *
 * The forge boundary (GitHubForgeAdapter) inspects this `status` to reclassify
 * 401/403 failures as a `ForgeAuthError` so the worker can drive the in-job
 * token re-mint + retry (P2 401-recovery seam). Non-2xx errors that are NOT
 * 401/403 stay plain failures — the status is still attached for logging.
 *
 * The message is preserved byte-for-byte from the previous plain-Error throws
 * (`GitHub API error <op>: <status> <statusText>`) so existing message-based
 * assertions and logs are unaffected.
 */
export class GitHubApiError extends Error {
  /** The HTTP status of the failed GitHub response. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    Object.setPrototypeOf(this, GitHubApiError.prototype);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Decode and format GitHub App private key from environment variable.
 * Supports:
 *   - Raw PEM with proper newlines
 *   - Base64-encoded PEM
 *   - PEM with spaces instead of newlines
 *   - PEM wrapped in quotes
 */
function decodePrivateKey(key: string): string {
  // Remove surrounding quotes if present
  let cleanKey = key.trim();
  if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
    cleanKey = cleanKey.slice(1, -1);
  }

  // Replace any escaped newline sequences with real newlines.
  // Coolify/Docker can multi-escape: \n → \\n → \\\\n in env vars.
  // Match one or more backslashes followed by 'n' and replace with real newline.
  cleanKey = cleanKey.replace(/\\+n/g, '\n');

  // If key has proper newlines, return as-is
  if (cleanKey.includes('-----BEGIN') && cleanKey.includes('\n')) {
    return cleanKey;
  }

  // If key has spaces instead of newlines, fix it
  if (cleanKey.includes(' ') && !cleanKey.includes('\n')) {
    // Split by spaces and reconstruct with newlines
    const parts = cleanKey.split(' ');
    const result: string[] = [];
    let currentLine = '';

    for (const part of parts) {
      if (part === '-----BEGIN' || part === '-----END' || part.includes('KEY-----')) {
        // These are headers/footers - keep them as separate lines
        if (currentLine) {
          result.push(currentLine);
          currentLine = '';
        }
        result.push(part);
      } else {
        // This is key data - add to current line
        currentLine += part;
        // Standard PEM lines are 64 chars
        if (currentLine.length >= 64) {
          result.push(currentLine);
          currentLine = '';
        }
      }
    }

    // Don't forget the last line
    if (currentLine) {
      result.push(currentLine);
    }

    // Join with newlines
    return result.join('\n');
  }

  return cleanKey;
}

// ─── PR Data ────────────────────────────────────────────────────

/**
 * Fetch pull request details (head SHA, base branch, etc.).
 * Used by the issue_comment handler to enrich the BullMQ job.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ headSha: string; baseBranch: string; prAuthor: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  const data = await githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error fetching PR details: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as {
      head: { sha: string };
      base: { ref: string };
      user: { login: string };
    };
  });

  return { headSha: data.head.sha, baseBranch: data.base.ref, prAuthor: data.user.login };
}

// ─── Issue Data ─────────────────────────────────────────────────
//
// getIssue / listIssueComments are NOT forge-adapter fns — they are the fetch
// boundary for the issue-triage path (webhook handleIssueTriage) and, like
// getInstallationToken/verifyWebhookSignature, stay DIRECTLY importable (they are
// intentionally absent from the biome noRestrictedImports importNames list).

/**
 * Fetch a single issue's title, body, and labels.
 *
 * Used by the issue_comment handler (issue-triage routing) to build the
 * IssueAnalysisJobData payload for a plain (non-PR) issue. The worker does NOT
 * fetch — it consumes a payload-carried snapshot — so this is the authoritative
 * fetch boundary. The caller is responsible for the payload size/count caps.
 *
 * Returns `body` as an empty string when GitHub sends `null` (issues with no
 * body), and `labels` as the label `name` strings.
 */
export async function getIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<{ title: string; body: string; labels: string[] }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;

  const data = await githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error fetching issue: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as {
      title: string;
      body: string | null;
      labels?: Array<{ name: string } | string>;
    };
  });

  const labels = (data.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);

  return { title: data.title ?? '', body: data.body ?? '', labels };
}

/**
 * Fetch the `maxCount` MOST-RECENT issue comments (author + body).
 *
 * SECURITY/DoS: this is the fetch boundary for untrusted issue-comment bodies
 * that end up in a Redis job payload. The triage agent wants the most RECENT
 * comments as context.
 *
 * GitHub's per-issue comments endpoint (GET …/issues/{n}/comments) is ordered
 * oldest-first by ascending comment id and does NOT accept `sort`/`direction`
 * (only `since`/`page`/`per_page` — verified against the REST docs). To return
 * the NEWEST comments we therefore:
 *   1. read the FIRST page with the MAX page size (`per_page = 100`) plus the
 *      `Link` header to learn the LAST page number,
 *   2. fetch that LAST page (the newest comments),
 *   3. if the last page holds FEWER than `maxCount` comments AND a previous page
 *      exists, ALSO fetch the previous page so the newest-`maxCount` window is
 *      complete across the page boundary,
 *   4. concatenate in chronological (oldest→newest) order and keep the trailing
 *      `maxCount`.
 * Because `per_page = 100`, the last two pages always cover ≥ `maxCount` for any
 * sane `maxCount ≤ 100`, so this bounds the fetch to at most 3 HTTP calls (the
 * page-1 probe for the `Link` header, the last page, and one previous page) —
 * never paging the oldest 500 and slicing the tail (the pre-fix behavior on a
 * >500-comment issue returned the OLDEST 500's tail, not the newest).
 *
 * The CALLER additionally enforces a total-payload byte budget (per-comment +
 * body truncation) before enqueue — `maxCount` alone does not bound total bytes
 * because a single comment body can be arbitrarily large.
 *
 * Returns `{ author, body }` pairs, OLDEST→NEWEST within the kept window (so the
 * agent reads them in chronological order). A comment with a missing/null author
 * falls back to the literal `'unknown'`. A present-but-malformed `Link` header
 * does NOT silently return the oldest comments — it logs a warn and falls back
 * to the trailing `maxCount` of whatever page 1 returned.
 *
 * THROWS on a failed page so the caller can distinguish "no comments" from
 * "fetch failed" and log accordingly (the caller degrades to `[]` + a warn).
 */
export async function listIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  maxCount: number,
): Promise<Array<{ id: number; author: string; body: string }>> {
  if (maxCount <= 0) return [];
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  // Always request the MAX page size: this guarantees the last (and, if needed,
  // the previous) page together cover ≥ maxCount for any sane maxCount ≤ 100.
  const perPage = 100;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const parse = (raw: unknown): Array<{ id: number; author: string; body: string }> =>
    (raw as Array<{ id: number; body: string | null; user: { login: string } | null }>).map(
      (c) => ({
        // The GitHub comment id — the reaper (queues/issue-draft-reaper.ts) needs
        // it to record POSTED against a live comment it correlated via marker.
        id: c.id,
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
      }),
    );

  const fetchPage = async (page: number) => {
    const res = await fetch(`${baseUrl}?per_page=${perPage}&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new GitHubApiError(
        res.status,
        `GitHub API error listing issue comments: ${res.status} ${res.statusText}`,
      );
    }
    return res;
  };

  // GitHub exposes the last page via rel="last" in the Link header. Returns the
  // parsed page number, `null` when there is no Link header (single page), or
  // `'malformed'` when a Link header is present but unparseable.
  const lastPageFrom = (link: string | null): number | null | 'malformed' => {
    if (!link) return null;
    const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (!m?.[1]) return 'malformed';
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 'malformed';
  };

  return githubCircuitBreaker.execute(async () => {
    // Probe page 1 — both for its contents and for the Link header.
    const firstRes = await fetchPage(1);
    const firstPage = parse(await firstRes.json());
    const lastPage = lastPageFrom(firstRes.headers.get('link'));

    // No Link header → single page; it already holds every comment.
    if (lastPage === null) {
      return firstPage.slice(-maxCount);
    }

    // Malformed Link header → do NOT silently return the oldest comments; log
    // and fall back to the trailing maxCount of whatever page 1 returned.
    if (lastPage === 'malformed') {
      logger.warn(
        { owner, repo, issueNumber },
        'listIssueComments: malformed GitHub Link header — falling back to page 1 tail',
      );
      return firstPage.slice(-maxCount);
    }

    // rel="last" points at page 1 → page 1 IS the whole set.
    if (lastPage <= 1) {
      return firstPage.slice(-maxCount);
    }

    // Fetch the last page (the newest comments).
    let window = parse(await (await fetchPage(lastPage)).json());

    // The last page can be partial (e.g. 105 total, per_page=100 → page 2 has
    // only 5). If it underfills the window AND a previous page exists, prepend
    // the previous page so the newest-maxCount window is complete across the
    // boundary. page 1 is already in hand — only re-fetch intermediate pages.
    if (window.length < maxCount && lastPage > 1) {
      const prevPage = lastPage - 1;
      const prev = prevPage === 1 ? firstPage : parse(await (await fetchPage(prevPage)).json());
      window = [...prev, ...window];
    }

    return window.slice(-maxCount);
  });
}

/**
 * Fetch the unified diff for a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchPRDiff(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.diff',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error fetching diff: ${response.status} ${response.statusText}`,
      );
    }

    return response.text();
  });
}

/**
 * Post a markdown comment to a pull request via the issues comments API.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<{ id: number }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error posting comment: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { id: number };
    return { id: data.id };
  });
}

/**
 * Find an existing GHAGGA review comment on a PR.
 * Returns the comment ID if found, or null if no previous review comment exists.
 *
 * Searches for the `<!-- ghagga-review -->` marker in issue comments.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function findExistingComment(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ latestId: number; staleIds: number[] } | null> {
  const MARKER = '<!-- ghagga-review -->';
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  // Paginate until exhausted (a page with < 100 items is the last page). The cap
  // is a safety upper bound so a pathological PR can't loop forever: 50 pages ×
  // 100/page = 5000 comments. If hit, we log rather than silently truncate — a
  // stale marker beyond the bound could otherwise produce a DUPLICATE comment.
  // (Was 5 pages / 500 items; raised to close that duplicate edge — backlog #6.)
  const MAX_PAGES = 50;
  // WALL-CLOCK BUDGET (server only): each page fetch can take up to 10s
  // (AbortSignal.timeout(10_000)), so 50 pages worst-case ≈ 500s. The BullMQ
  // review worker lock is `lockDuration: 300_000` (5 min) — see
  // apps/server/src/queues/review.ts createReviewWorker. If pagination alone
  // exceeded ~300s the job would lose its lock mid-run and look stalled →
  // retried/duplicated. We therefore cap total paging at 90s, leaving ~210s of
  // the 5-min lock for the rest of the job (fetch diff + dispatch + poll +
  // postback). On budget exhaustion we stop, warn (non-silent), and proceed with
  // what we found — a missed stale on a 5000-comment PR is acceptable vs. blowing
  // the worker lock. MAX_PAGES stays as belt-and-suspenders.
  // (CLI ports have NO worker lock and keep paging to MAX_PAGES.)
  const PAGINATION_BUDGET_MS = 90_000;
  const deadline = Date.now() + PAGINATION_BUDGET_MS;

  return githubCircuitBreaker.execute(async () => {
    const allMatchIds: number[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      // Budget guard: only AFTER page 1 (the common single-page case always gets
      // its one fetch, baseline byte-identical). If we've already spent the
      // budget, stop paging rather than risk the worker lock.
      if (page > 1 && Date.now() >= deadline) {
        console.warn(
          `[ghagga] findExistingComment hit the ${PAGINATION_BUDGET_MS}ms pagination budget for ${owner}/${repo}#${prNumber} at page ${page}; comment listing truncated to stay under the worker lock`,
        );
        break;
      }

      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error listing comments: ${response.status} ${response.statusText}`,
        );
      }

      const comments = (await response.json()) as Array<{ id: number; body: string }>;

      for (const comment of comments) {
        if (comment.body.includes(MARKER)) {
          allMatchIds.push(comment.id);
        }
      }

      if (comments.length < 100) break;

      if (page === MAX_PAGES) {
        // Reached the safety bound with a still-full last page: there may be
        // more comments (and a stale marker) we did not scan. Surface it so a
        // duplicate-comment outcome is at least observable, not silent.
        console.warn(
          `[ghagga] findExistingComment hit MAX_PAGES (${MAX_PAGES}) for ${owner}/${repo}#${prNumber}; comment listing may be truncated`,
        );
      }
    }

    if (allMatchIds.length === 0) return null;

    // Latest = last in chronological order (GitHub returns oldest first)
    const latestId = allMatchIds[allMatchIds.length - 1];
    if (!latestId) return null;
    const staleIds = allMatchIds.slice(0, -1); // all except the last

    return { latestId, staleIds };
  });
}

/**
 * Delete a comment from a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function deleteComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;

  await githubCircuitBreaker.execute(async () => {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
  });
}

/**
 * Update an existing comment on a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function updateComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;

  await githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error updating comment: ${response.status} ${response.statusText}`,
      );
    }
  });
}

/**
 * Fetch commit messages for a pull request.
 * Paginates through all pages (max 5 pages / 500 commits).
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function getPRCommitMessages(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`;
  const MAX_PAGES = 5;

  return githubCircuitBreaker.execute(async () => {
    const allMessages: string[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error fetching commits: ${response.status} ${response.statusText}`,
        );
      }

      const commits = (await response.json()) as Array<{
        commit: { message: string };
      }>;
      allMessages.push(...commits.map((c) => c.commit.message));

      if (commits.length < 100) break;
    }

    return allMessages;
  });
}

/**
 * Fetch the list of changed file paths for a pull request.
 * Paginates through all pages (max 10 pages / 1000 files).
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function getPRFileList(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
  const MAX_PAGES = 10;

  return githubCircuitBreaker.execute(async () => {
    const allFiles: string[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error fetching files: ${response.status} ${response.statusText}`,
        );
      }

      const files = (await response.json()) as Array<{ filename: string }>;
      allFiles.push(...files.map((f) => f.filename));

      if (files.length < 100) break;
    }

    return allFiles;
  });
}

// ─── Dependency Graph ───────────────────────────────────────────

/**
 * Fetch the dependency graph from the ghagga/graph orphan branch.
 * Returns null if the branch or file doesn't exist.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchGraphFromBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<import('ghagga-core').DependencyGraph | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ghagga/graph.json?ref=ghagga/graph`;

  try {
    const response = await githubCircuitBreaker.execute(async () => {
      return fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[ghagga] Failed to fetch graph: ${response.status}`);
      return null;
    }

    const json: unknown = await response.json();
    // Inline validation — avoids dynamic import issues in test
    return validateGraphJson(json);
  } catch {
    return null;
  }
}

/**
 * Fetch the dependency graph metadata from the ghagga/graph orphan branch.
 * Returns null if the branch or file doesn't exist.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchGraphMetadata(
  owner: string,
  repo: string,
  token: string,
): Promise<import('ghagga-core').GraphMetadata | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ghagga/metadata.json?ref=ghagga/graph`;

  try {
    const response = await githubCircuitBreaker.execute(async () => {
      return fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });
    });

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const json: unknown = await response.json();
    return validateMetadataJson(json);
  } catch {
    return null;
  }
}

// ─── File Contents ──────────────────────────────────────────────

/** Per-file cap — bounds prompt cost; an oversized file is rejected, not truncated. */
const MAX_FILE_BYTES = 512 * 1024;
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GH_REF = /^[A-Za-z0-9._/-]{1,255}$/;
const GH_PATH_SEGMENT = /^[^/\0]+$/;

/**
 * Validate + percent-encode a repo-relative path for the Contents API. Rejects
 * absolute paths, empty/`.`/`..` segments (traversal), and NUL; each segment is
 * `encodeURIComponent`'d and the separating slashes are preserved. Ported from
 * ERE `collectors/github-code.ts` `encodePath`.
 */
function encodeContentsPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) {
    throw new GitHubApiError(
      400,
      `GitHub API error fetching file: invalid path ${JSON.stringify(path)}`,
    );
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (!GH_PATH_SEGMENT.test(seg) || seg === '.' || seg === '..') {
      throw new GitHubApiError(
        400,
        `GitHub API error fetching file: invalid path segment ${JSON.stringify(seg)}`,
      );
    }
  }
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Read one repo-relative file's UTF-8 contents at `ref` via the GitHub Contents
 * API — no local clone. Returns null when the path does not resolve to a file at
 * that ref (404, or a directory/submodule/symlink); throws {@link GitHubApiError}
 * on any real fault (auth, rate-limit, non-2xx, oversize).
 *
 * Hardened for untrusted input (an issue — hence a file path — is attacker-
 * influenceable): owner/repo/ref are charset-validated and the path is
 * traversal-guarded before it reaches the URL; the response is validated to be a
 * `file` and capped at {@link MAX_FILE_BYTES} so a huge file cannot blow prompt
 * cost. Uses the JSON media type + base64 (not raw) precisely so a directory
 * path is distinguishable from a file and returns null instead of a JSON listing.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly; the
 * forge-boundary lint enforces this.
 */
export async function fetchFileContents(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string,
): Promise<string | null> {
  if (!GH_OWNER.test(owner)) {
    throw new GitHubApiError(400, 'GitHub API error fetching file: invalid owner');
  }
  if (!GH_REPO.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubApiError(400, 'GitHub API error fetching file: invalid repo');
  }
  if (!GH_REF.test(ref)) {
    throw new GitHubApiError(400, 'GitHub API error fetching file: invalid ref');
  }
  const encodedPath = encodeContentsPath(path);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;

  const response = await githubCircuitBreaker.execute(async () => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    // A 404 (path absent at this ref) is a valid answer, not a breaker failure.
    // Any OTHER non-2xx is a real failure, thrown INSIDE execute so the circuit
    // breaker counts it toward opening (matching fetchPRDetails/getIssue).
    if (res.status !== 404 && !res.ok) {
      throw new GitHubApiError(
        res.status,
        `GitHub API error fetching file: ${res.status} ${res.statusText}`,
      );
    }
    return res;
  });

  if (response.status === 404) return null; // no such path at this ref

  // Reject a grossly oversized response BEFORE materializing the body. The
  // o.size / decoded-byte guards below are the precise caps; this just bounds the
  // transient allocation. GitHub does not inline content for files >1MB, so a
  // declared length several× the cap cannot be an in-cap file.
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES * 4) {
    throw new GitHubApiError(
      413,
      `GitHub API error fetching file: response ${declaredLength} bytes exceeds cap`,
    );
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new GitHubApiError(502, 'GitHub API error fetching file: malformed JSON response');
  }
  // An array is a directory listing; a non-`file` type is a submodule/symlink —
  // neither is a readable file, so return null (skip) rather than feeding junk.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (o.type !== 'file') return null;
  if (typeof o.size === 'number' && o.size > MAX_FILE_BYTES) {
    throw new GitHubApiError(
      413,
      `GitHub API error fetching file: ${o.size} bytes exceeds ${MAX_FILE_BYTES}`,
    );
  }
  // GitHub omits inline content (or switches encoding) for files >1MB.
  if (o.encoding !== 'base64' || typeof o.content !== 'string') {
    throw new GitHubApiError(413, 'GitHub API error fetching file: content not inline (too large)');
  }
  const compact = o.content.replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new GitHubApiError(502, 'GitHub API error fetching file: content is not valid base64');
  }
  const buf = Buffer.from(compact, 'base64');
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw new GitHubApiError(
      413,
      `GitHub API error fetching file: decoded ${buf.byteLength} exceeds ${MAX_FILE_BYTES}`,
    );
  }
  return buf.toString('utf-8');
}

// ─── Graph Validation (inline to avoid dynamic imports) ─────────

const GRAPH_VERSION = 1;

function validateGraphJson(json: unknown): import('ghagga-core').DependencyGraph | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.version !== 'number' || obj.version !== GRAPH_VERSION) return null;
  if (typeof obj.rootDir !== 'string') return null;
  if (!obj.nodes || typeof obj.nodes !== 'object') return null;
  return json as import('ghagga-core').DependencyGraph;
}

function validateMetadataJson(json: unknown): import('ghagga-core').GraphMetadata | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.lastIndexedCommit !== 'string') return null;
  if (typeof obj.lastIndexedAt !== 'string') return null;
  if (typeof obj.schemaVersion !== 'number') return null;
  if (typeof obj.fileCount !== 'number') return null;
  if (!Array.isArray(obj.languages)) return null;
  if (typeof obj.indexDurationMs !== 'number') return null;
  return json as import('ghagga-core').GraphMetadata;
}

// ─── Reactions ──────────────────────────────────────────────────

/**
 * Add a reaction emoji to an issue comment.
 * Used for acknowledging "ghagga review" trigger comments.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`;

  try {
    await githubCircuitBreaker.execute(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ content: reaction }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(
          `GitHub API error adding reaction: ${response.status} ${response.statusText}`,
        );
      }
    });
  } catch {
    // Non-critical — log but don't throw
    console.warn(`[ghagga] Failed to add reaction`);
  }
}

// ─── Webhook Verification ───────────────────────────────────────

/**
 * Verify a GitHub webhook signature using HMAC-SHA256
 * with constant-time comparison.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  // GitHub sends: sha256=<hex>
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const signatureHex = signature.slice(expectedPrefix.length);

  const computed = createHmac('sha256', secret).update(payload).digest('hex');

  // Constant-time comparison
  try {
    const sigBuffer = Buffer.from(signatureHex, 'hex');
    const computedBuffer = Buffer.from(computed, 'hex');

    if (sigBuffer.length !== computedBuffer.length) return false;

    return timingSafeEqual(sigBuffer, computedBuffer);
  } catch {
    return false;
  }
}

// ─── Installation Token ─────────────────────────────────────────

/**
 * A minted installation token plus its absolute expiry (epoch millis).
 *
 * Structurally matches `MintedInstallationToken` from `ghagga-forge` — the
 * P2 `GitHubAppCredentialProvider` consumes this shape (via the injected
 * expiry-carrying mint) to drive its TTL cache. Declared locally to avoid a
 * value import that would couple the client to the forge package.
 */
export interface InstallationTokenResult {
  /** The installation access token string. */
  token: string;
  /** Absolute expiry, epoch millis (comparable to {@link Date.now}). */
  expiresAtMs: number;
}

/**
 * Conservative fallback installation-token lifetime (ms) used ONLY when the
 * GitHub access-token response omits or returns an unparseable `expires_at`.
 * GitHub installation tokens live ~1h; 55min leaves margin under that.
 */
const FALLBACK_INSTALLATION_TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * Create a JWT for GitHub App authentication and exchange it for an installation
 * access token, returning the token AND its expiry (P2).
 *
 * The GitHub access-token response includes an ISO-8601 `expires_at`; this reads
 * it into an epoch-millis timestamp so the credential provider can TTL-cache.
 * If `expires_at` is missing/unparseable, falls back to a conservative TTL so the
 * provider never treats a token as longer-lived than GitHub actually grants.
 *
 * JWT is created manually using Node.js crypto (RS256).
 */
export async function getInstallationTokenWithExpiry(
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
): Promise<InstallationTokenResult> {
  const now = Math.floor(Date.now() / 1000);

  // Create JWT header + payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60 seconds in the past for clock skew
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Decode and sign with RS256
  const decodedKey = decodePrivateKey(privateKey);
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signatureBuffer = signer.sign(decodedKey);
  const encodedSignature = base64url(signatureBuffer);

  const jwt = `${signingInput}.${encodedSignature}`;

  // Exchange JWT for installation access token
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

  // Build request body — optionally scope token to specific repositories
  const body: Record<string, unknown> = {};
  if (options?.repositoryIds && options.repositoryIds.length > 0) {
    body.repository_ids = options.repositoryIds;
  }

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
      ...(Object.keys(body).length > 0 && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error getting installation token: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { token: string; expires_at?: string };
    const parsed = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const expiresAtMs = Number.isNaN(parsed)
      ? Date.now() + FALLBACK_INSTALLATION_TOKEN_TTL_MS
      : parsed;
    return { token: data.token, expiresAtMs };
  });
}

/**
 * Mint an installation access token (token string only).
 *
 * Back-compat thin wrapper over {@link getInstallationTokenWithExpiry} that
 * discards the expiry — preserves the original `Promise<string>` signature for
 * the direct callers that don't TTL-cache (webhook handlers, workflow injection).
 */
export async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
): Promise<string> {
  const { token } = await getInstallationTokenWithExpiry(
    installationId,
    appId,
    privateKey,
    options,
  );
  return token;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Base64url encode (RFC 4648 §5) — works with strings and Buffers.
 */
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}
