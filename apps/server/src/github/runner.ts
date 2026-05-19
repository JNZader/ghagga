/**
 * Inline GitHub Actions workflow integration.
 *
 * Injects the inline static-analysis workflow into the target repository
 * (`.github/workflows/ghagga.yml`, built from `templates/ghagga-inline.yml`),
 * dispatches it via `workflow_dispatch`, and verifies the HMAC-signed
 * callbacks it produces.
 *
 * Architecture: every dispatch derives its callback secret deterministically
 * via `HMAC-SHA256(STATE_SECRET, callbackId)` (see `deriveCallbackSecret`).
 * No per-dispatch state is held in memory, so callbacks survive server
 * restarts, container redeploys, and horizontal scaling.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'runner' });

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowDispatchInputs {
  callbackId: string;
  prNumber: string;
  headSha: string;
  callbackUrl: string;
  callbackSecret: string;
  enableSemgrep: string;
  enableTrivy: string;
  enableCpd: string;
  enabledTools: string;
  disabledTools: string;
}

// ─── Workflow Injection Types ────────────────────────────────────

export interface WorkflowInjectionResult {
  sha: string;
  /** true = file was newly created, false = file was updated or unchanged */
  created: boolean;
}

export interface DispatchParams {
  /** Target repo in "owner/repo" format — the PR's own repo, where the inline workflow runs */
  repoFullName: string;
  prNumber: number;
  headSha: string;
  /** Branch name used as the workflow_dispatch ref */
  baseBranch: string;
  callbackUrl: string;
  callbackSecret: string;
  callbackId: string;
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  enableBlastRadius?: boolean;
  token: string;
}

// ─── Stateless Callback Secret Derivation ───────────────────────
// Callback secrets are derived deterministically from STATE_SECRET +
// callbackId using HMAC-SHA256. This replaces the previous in-memory
// Map<string, StoredSecret> store, ensuring callbacks survive server
// restarts and container redeploys.

/**
 * Return the callback TTL in milliseconds.
 * Reads `CALLBACK_TTL_MINUTES` from env (defaults to 11, minimum 1).
 */
export function getCallbackTtlMs(): number {
  const minutes = parseInt(process.env.CALLBACK_TTL_MINUTES ?? '11', 10);
  return (Number.isNaN(minutes) || minutes < 1 ? 11 : minutes) * 60 * 1000;
}

/**
 * Derive a callback secret deterministically using HMAC-SHA256.
 * Returns a 64-char hex string (32 bytes).
 *
 * @throws {Error} if STATE_SECRET is not configured
 */
export function deriveCallbackSecret(callbackId: string): string {
  const STATE_SECRET = process.env.STATE_SECRET;
  if (!STATE_SECRET) {
    throw new Error('STATE_SECRET is not configured');
  }
  return createHmac('sha256', STATE_SECRET).update(callbackId).digest('hex');
}

/**
 * Verify a callback HMAC signature statelessly.
 *
 * Steps:
 * 1. Extract timestamp from callbackId (after last `.`)
 * 2. Reject if older than getCallbackTtlMs() (default 11 minutes)
 * 3. Derive secret via deriveCallbackSecret
 * 4. Validate `sha256=` prefix on signatureHeader
 * 5. Compute expected HMAC over payload
 * 6. Compare with timingSafeEqual
 */
export function verifyCallbackSignature(
  callbackId: string,
  payload: string,
  signatureHeader: string,
): boolean {
  // Step 1: Extract timestamp from callbackId
  const dotIndex = callbackId.lastIndexOf('.');
  if (dotIndex === -1) {
    logger.warn({ callbackId }, 'Invalid callbackId format — no timestamp separator');
    return false;
  }

  const ts = callbackId.slice(dotIndex + 1);
  const timestamp = parseInt(ts, 36);
  if (Number.isNaN(timestamp)) {
    logger.warn({ callbackId }, 'Invalid callbackId format — unparseable timestamp');
    return false;
  }

  // Step 2: Check TTL
  if (Date.now() - timestamp >= getCallbackTtlMs()) {
    logger.warn({ callbackId }, 'Callback expired — TTL exceeded');
    return false;
  }

  // Step 3: Derive secret
  const secret = deriveCallbackSecret(callbackId);

  // Step 4: Validate sha256= prefix
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    logger.warn({ callbackId }, 'Invalid signature format — missing sha256= prefix');
    return false;
  }

  // Step 5: Compute expected HMAC
  const signatureHex = signatureHeader.slice(expectedPrefix.length);
  const computed = createHmac('sha256', secret).update(payload).digest('hex');

  // Step 6: Timing-safe comparison
  try {
    const sigBuffer = Buffer.from(signatureHex, 'hex');
    const computedBuffer = Buffer.from(computed, 'hex');

    if (sigBuffer.length !== computedBuffer.length) {
      return false;
    }

    const valid = timingSafeEqual(sigBuffer, computedBuffer);

    if (!valid) {
      logger.warn({ callbackId }, 'Callback HMAC verification failed');
    }

    return valid;
  } catch {
    return false;
  }
}

// ─── Workflow Injection ─────────────────────────────────────────

/**
 * Inject (or update) `ghagga.yml` into `.github/workflows/` of the target repo.
 *
 * Steps:
 * 1. Read the inline workflow template from disk (templates/ghagga-inline.yml)
 * 2. GET `/repos/{owner}/{repo}/contents/.github/workflows/ghagga.yml` to check
 *    if the file already exists and retrieve its current SHA
 * 3. If the file exists and its content is already up-to-date (same base64 body),
 *    return immediately — skip the PUT
 * 4. Otherwise PUT the file (with SHA if updating, without SHA if creating)
 * 5. Return `{ sha, created }` where `created` is true on a new file
 *
 * Throws on permission errors (403/422 from branch protection) — callers should
 * handle gracefully and skip static analysis if injection fails.
 */
export async function injectWorkflow(
  owner: string,
  repo: string,
  token: string,
  currentSha?: string | null,
): Promise<WorkflowInjectionResult> {
  // Step 1: Read template from disk.
  // Resolved relative to this compiled file (dist/github/runner.js → ../../../../templates/).
  // This works in both local dev (tsx runs from src/) and Docker (compiled dist/).
  const templatePath = fileURLToPath(
    new URL('../../../../templates/ghagga-inline.yml', import.meta.url),
  );
  const templateContent = readFileSync(templatePath, 'utf8');
  const contentBase64 = Buffer.from(templateContent, 'utf8').toString('base64');

  const apiPath = `.github/workflows/ghagga.yml`;
  const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}`;

  // Step 2: Check if file exists and get its SHA
  let existingSha: string | undefined;
  let existingContentBase64: string | undefined;

  const getResponse = await githubCircuitBreaker.execute(() =>
    fetch(contentsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    }),
  );

  if (getResponse.ok) {
    const data = (await getResponse.json()) as { sha: string; content: string };
    existingSha = data.sha;
    // GitHub returns content with newlines inserted every 60 chars — strip them for comparison
    existingContentBase64 = data.content.replace(/\n/g, '');
  } else if (getResponse.status !== 404) {
    const body = await getResponse.text();
    logger.error(
      { status: getResponse.status, owner, repo, body },
      'GitHub API error checking workflow file',
    );
    throw new Error(`Failed to check workflow file: ${getResponse.status}`);
  }

  // Step 3: Skip if content already matches
  if (existingSha && existingContentBase64 === contentBase64) {
    logger.info({ owner, repo, sha: existingSha }, 'Workflow file already up-to-date — skipping');
    return { sha: existingSha, created: false };
  }

  // Use SHA from currentSha param as fallback if GET didn't find it
  const putSha = existingSha ?? currentSha ?? undefined;

  // Step 4: PUT (create or update)
  const putBody: Record<string, unknown> = {
    message: putSha
      ? 'chore: update GHAGGA inline static analysis workflow'
      : 'chore: add GHAGGA inline static analysis workflow',
    content: contentBase64,
  };
  if (putSha) {
    putBody.sha = putSha;
  }

  const putResponse = await githubCircuitBreaker.execute(() =>
    fetch(contentsUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(putBody),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  if (!putResponse.ok) {
    const status = putResponse.status;
    const body = await putResponse.text();

    if (status === 403 || status === 422) {
      logger.warn(
        { status, owner, repo, body },
        'Workflow injection blocked by branch protection or permissions',
      );
      throw new Error(`branch_protection: cannot write workflow file to ${owner}/${repo}`);
    }

    logger.error({ status, owner, repo, body }, 'GitHub API error injecting workflow file');
    throw new Error(`Failed to inject workflow file: ${status}`);
  }

  const putData = (await putResponse.json()) as { content: { sha: string } };
  const newSha = putData.content.sha;

  logger.info(
    { owner, repo, sha: newSha, created: !putSha },
    `Workflow file ${putSha ? 'updated' : 'created'}`,
  );

  return { sha: newSha, created: !putSha };
}

// ─── Dispatch Workflow ──────────────────────────────────────────

/**
 * Dispatch the `ghagga.yml` workflow directly on the target repo (the PR's repo).
 *
 * `callbackUrl` and `callbackSecret` are passed as workflow inputs, so no
 * GitHub Actions repository secrets need to be set per dispatch.
 *
 * The caller is responsible for generating `callbackId` and `callbackSecret`
 * (via `randomUUID()` plus a base-36 timestamp and `deriveCallbackSecret()`)
 * before calling this function.
 *
 * Returns the callbackId for correlation with the callback.
 */
export async function dispatchWorkflow(params: DispatchParams): Promise<string> {
  const {
    repoFullName,
    prNumber,
    headSha,
    baseBranch,
    callbackUrl,
    callbackSecret,
    callbackId,
    enableSemgrep,
    enableTrivy,
    enableCpd,
    enabledTools,
    disabledTools,
    token,
  } = params;

  const inputs: WorkflowDispatchInputs = {
    callbackId,
    prNumber: String(prNumber),
    headSha,
    callbackUrl,
    callbackSecret,
    enableSemgrep: String(enableSemgrep),
    enableTrivy: String(enableTrivy),
    enableCpd: String(enableCpd),
    enabledTools: JSON.stringify(enabledTools ?? []),
    disabledTools: JSON.stringify(disabledTools ?? []),
  };

  // Dispatch to the PR's own repo, using baseBranch as the ref
  const dispatchUrl = `https://api.github.com/repos/${repoFullName}/actions/workflows/ghagga.yml/dispatches`;

  const response = await githubCircuitBreaker.execute(() =>
    fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: baseBranch,
        inputs,
      }),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    logger.error(
      { status: response.status, statusText: response.statusText, body, repo: repoFullName },
      'GitHub API error dispatching workflow',
    );
    throw new Error('Failed to communicate with GitHub API');
  }

  logger.info({ callbackId, repoFullName, prNumber }, 'Dispatched inline workflow');

  return callbackId;
}
