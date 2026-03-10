/**
 * GitHub API client utilities.
 *
 * Uses native fetch for all HTTP calls and Node.js crypto for
 * JWT creation and webhook signature verification. No extra deps.
 */

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Decode and format GitHub App private key from environment variable.
 * Supports:
 *   - Raw PEM with proper newlines
 *   - Base64-encoded PEM
 *   - PEM with spaces instead of newlines
 */
function decodePrivateKey(key: string): string {
  // DEBUG: Log key characteristics
  console.error('[DEBUG] Key length:', key.length);
  console.error('[DEBUG] Has BEGIN:', key.includes('-----BEGIN'));
  console.error('[DEBUG] Has newline:', key.includes('\n'));
  console.error('[DEBUG] First 50 chars:', JSON.stringify(key.substring(0, 50)));
  console.error('[DEBUG] Last 50 chars:', JSON.stringify(key.substring(key.length - 50)));

  // If key already has proper newlines and PEM headers, return as-is
  if (key.includes('-----BEGIN') && key.includes('\n')) {
    console.error('[DEBUG] Using key as-is (has newlines)');
    return key;
  }

  // Try to decode as base64 first
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    // Verify it decoded to valid PEM
    if (decoded.includes('-----BEGIN')) {
      console.error('[DEBUG] Decoded from base64');
      return decoded;
    }
  } catch {
    // Not valid base64, continue
  }

  // Fix common formatting issues:
  // Replace all spaces with newlines (aggressive fix for env var formatting)
  let fixed = key;

  // Replace spaces between header and body
  fixed = fixed.replace(/(-----BEGIN RSA PRIVATE KEY-----)\s+/, '$1\n');
  fixed = fixed.replace(/\s+(-----END RSA PRIVATE KEY-----)/, '\n$1');

  // Replace remaining spaces in the body with newlines (every 64 chars typically)
  // But only if no newlines exist
  if (!fixed.includes('\n')) {
    fixed = fixed.replace(/ /g, '\n');
  }

  console.error('[DEBUG] Fixed key, now has newlines:', fixed.includes('\n'));
  return fixed;
}

// ─── PR Data ────────────────────────────────────────────────────

/**
 * Fetch pull request details (head SHA, base branch, etc.).
 * Used by the issue_comment handler to enrich the Inngest event.
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ headSha: string; baseBranch: string }> {
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
      throw new Error(
        `GitHub API error fetching PR details: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as {
      head: { sha: string };
      base: { ref: string };
    };
  });

  return { headSha: data.head.sha, baseBranch: data.base.ref };
}

/**
 * Fetch the unified diff for a pull request.
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
      throw new Error(`GitHub API error fetching diff: ${response.status} ${response.statusText}`);
    }

    return response.text();
  });
}

/**
 * Post a markdown comment to a pull request via the issues comments API.
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
      throw new Error(
        `GitHub API error posting comment: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { id: number };
    return { id: data.id };
  });
}

/**
 * Fetch commit messages for a pull request.
 * Paginates through all pages (max 5 pages / 500 commits).
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
        throw new Error(
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
        throw new Error(
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

// ─── Reactions ──────────────────────────────────────────────────

/**
 * Add a reaction emoji to an issue comment.
 * Used for acknowledging "ghagga review" trigger comments.
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
 * Create a JWT for GitHub App authentication and exchange it
 * for an installation access token.
 *
 * JWT is created manually using Node.js crypto (RS256).
 */
export async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
): Promise<string> {
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

    const data = (await response.json()) as { token: string };
    return data.token;
  });
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Base64url encode (RFC 4648 §5) — works with strings and Buffers.
 */
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}
