/**
 * Code-in-evidence for SERVER-SIDE (checkout-less) issue triage.
 *
 * The CLI triage path locates code from a local checkout; the webhook worker has
 * none. This collects the code an issue REFERENCES by fetching it remotely at the
 * repository default branch, so triage can weigh the claim against real source —
 * the server-side analogue of the CLI's LOCATE → buildCodeContext fold.
 *
 * BEST-EFFORT ENHANCEMENT: every failure path (no paths discovered, missing App
 * credentials, a mint failure, a per-file fetch fault) degrades to '' so triage
 * proceeds text-only — it MUST NOT crash or block triage. Nothing here posts.
 *
 * SECURITY: the returned bytes are ATTACKER-INFLUENCEABLE (an issue names the
 * paths; a reporter may control the default-branch content of a fork/PR). The
 * caller folds this string into `memoryContext`, which `runIssueTriage` fences as
 * untrusted DATA via `buildMemoryContext` — never as trusted instructions. The
 * fetch itself is hardened in `client.fetchFileContents` (path traversal guard,
 * size cap, file-vs-dir check).
 */

import { discoverCodePaths } from 'ghagga-core';
import { GitHubAppCredentialProvider } from 'ghagga-forge';
import * as githubClient from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';

/** Max files fetched per issue — bounds cost, API calls, and mint frequency. */
const MAX_CODE_FILES = 6;
/** Per-file char cap — a snippet, not the whole file. */
const MAX_SNIPPET_CHARS = 3000;
/**
 * Total char budget for the assembled code block. Kept below the downstream
 * untrusted-block cap (`UNTRUSTED_BLOCK_CHAR_CAP` = 16000 in prompts.ts) with room
 * for the memoryContext it is folded alongside — so the block is NOT silently
 * truncated inside the fence. Files that would overflow are dropped and COUNTED,
 * and the log reports the chars actually attached (not just how many were
 * fetched), so it never over-reports what the model saw.
 */
const CODE_BLOCK_BUDGET = 10_000;

/** Minimal structured logger surface (a pino child logger satisfies this). */
export interface CodeEvidenceLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Format one fetched file as a fenced markdown section (bounded). */
function section(path: string, content: string): string {
  const snippet =
    content.length > MAX_SNIPPET_CHARS
      ? `${content.slice(0, MAX_SNIPPET_CHARS)}\n… (truncated)`
      : content;
  return `\n### ${path}\n\`\`\`\n${snippet}\n\`\`\``;
}

/**
 * Discover the code paths an issue references, fetch them at the repo default
 * branch, and format a markdown block for the triage `memoryContext`. Returns ''
 * when nothing is discovered or fetched (triage proceeds text-only).
 */
export async function collectIssueCodeEvidence(args: {
  installationId: number;
  repoFullName: string;
  /** Combined issue title + body + comments (the discovery input). */
  issueText: string;
  log: CodeEvidenceLogger;
}): Promise<string> {
  const { installationId, repoFullName, issueText, log } = args;

  const paths = discoverCodePaths(issueText, { limit: MAX_CODE_FILES });
  if (paths.length === 0) return '';

  const slash = repoFullName.indexOf('/');
  const owner = slash > 0 ? repoFullName.slice(0, slash) : '';
  const repo = slash > 0 ? repoFullName.slice(slash + 1) : '';
  if (!owner || !repo) return '';

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    log.warn(
      { discovered: paths.length },
      'code-evidence: GitHub App credentials missing; triaging text-only',
    );
    return '';
  }

  let token: string;
  try {
    const tokenSource = new GitHubAppCredentialProvider({
      mint: githubClient.getInstallationTokenWithExpiry,
      installationId,
      appId,
      privateKey,
    });
    token = await tokenSource.getToken();
  } catch (err) {
    log.warn(
      { discovered: paths.length, err: errMessage(err) },
      'code-evidence: installation-token mint failed; triaging text-only',
    );
    return '';
  }

  const adapter = makeGitHubAdapter({ owner, repo, token });
  // The adapter keys on its ctor owner/repo, so this RepoRef is inert identity.
  const repoRef = { kind: 'github' as const, nativeId: `${owner}/${repo}`, path: repoFullName };

  // Fetch all discovered paths CONCURRENTLY (bounded — at most MAX_CODE_FILES) so
  // the worker never serializes up to 6 × the 10s per-fetch timeout into the job's
  // lock window. Order is preserved (first-appearance). A per-file fault resolves
  // to null (skipped, surfaced) — never fatal.
  const fetched = await Promise.all(
    paths.map(async (path) => {
      try {
        // Empty ref → default branch (an issue has no natural SHA).
        const content = await adapter.fetchFileContents(repoRef, path);
        return content !== null ? { path, content } : null;
      } catch (err) {
        log.warn({ path, err: errMessage(err) }, 'code-evidence: fetch failed for a path');
        return null;
      }
    }),
  );

  // Assemble within CODE_BLOCK_BUDGET so the block is not silently truncated by
  // the downstream fence cap; drop + COUNT any file that would overflow.
  const sections: string[] = [];
  let usedChars = 0;
  let droppedForBudget = 0;
  for (const f of fetched) {
    if (f === null) continue;
    const sec = section(f.path, f.content);
    if (usedChars + sec.length > CODE_BLOCK_BUDGET) {
      droppedForBudget += 1;
      continue;
    }
    sections.push(sec);
    usedChars += sec.length;
  }

  if (sections.length === 0) {
    // Honesty check: discovered paths but attached none — say so, don't proceed
    // silently as if the issue referenced no code.
    log.warn(
      { discovered: paths.length },
      'code-evidence: discovered paths but attached none; triaging text-only',
    );
    return '';
  }

  // Report what the model actually SEES (chars + files attached), plus anything
  // dropped for the budget — never over-report the fetch count as "attached".
  log.info(
    { discovered: paths.length, attached: sections.length, droppedForBudget, chars: usedChars },
    'code-evidence: attached referenced source to triage',
  );
  return [
    '## RELEVANT SOURCE CODE (files the issue references, at the default branch)',
    ...sections,
  ].join('\n');
}
