/**
 * Code-in-evidence for SERVER-SIDE (checkout-less) issue triage.
 *
 * The CLI triage path locates code from a local checkout; the webhook worker has
 * none. This collects the code an issue REFERENCES by fetching it remotely at the
 * repository default branch, so triage can weigh the claim against real source —
 * the server-side analogue of the CLI's LOCATE → buildCodeContext fold.
 *
 * CODE-SEARCH FALLBACK (triage-search-discovery T6): when {@link discoverCodePaths}
 * finds FEWER THAN `PATH_DISCOVERY_SUFFICIENT` paths, an issue may still name a
 * bare identifier (backtick-quoted, e.g. `` `fetchGraph` ``) without a full path.
 * When the adapter supports it (`'searchCode' in adapter` — R-CAPABILITY method
 * presence, never a flag), {@link discoverSearchTerms} extracts up to
 * `SEARCH_TERM_LIMIT` such terms and each is searched SEQUENTIALLY (bounded at
 * `MAX_SEARCH_CALLS`) via `adapter.searchCode`. A search fault (throw) BREAKS the
 * loop immediately — it degrades, it never propagates — keeping whatever results
 * were already found. Path-discovery and search results are merged
 * PATH-PRECEDENCE (paths first, so a path-discovered file is never displaced by a
 * search duplicate), deduped, and capped at `MAX_CODE_FILES` before fetching.
 *
 * BEST-EFFORT ENHANCEMENT: every failure path (nothing discovered, missing App
 * credentials, a mint failure, a per-file fetch fault, a search fault) degrades
 * to '' so triage proceeds text-only — it MUST NOT crash or block triage. Nothing
 * here posts.
 *
 * SECURITY: the returned bytes are ATTACKER-INFLUENCEABLE (an issue names the
 * paths; a reporter may control the default-branch content of a fork/PR). The
 * caller passes this string as `runIssueTriage`'s dedicated `sourceCode` input,
 * which fences it as untrusted DATA via `wrapUntrustedSourceCode` (<SOURCE_CODE>)
 * — never as trusted instructions. The fetch itself is hardened in
 * `client.fetchFileContents` (path traversal guard, size cap, file-vs-dir check).
 */

import { discoverCodePaths, discoverSearchTerms } from 'ghagga-core';
import { GitHubAppCredentialProvider } from 'ghagga-forge';
import * as githubClient from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';

/** Max files fetched per issue — bounds cost, API calls, and mint frequency. */
const MAX_CODE_FILES = 6;
/**
 * Below this many discovered paths, path discovery is considered INSUFFICIENT
 * and the code-search fallback kicks in (when the adapter supports it).
 */
const PATH_DISCOVERY_SUFFICIENT = 2;
/** Max `searchCode` calls per issue (one per discovered term, bounded). */
const MAX_SEARCH_CALLS = 3;
/** Max terms `discoverSearchTerms` extracts to drive the search fallback. */
const SEARCH_TERM_LIMIT = 3;
/** Max results requested per search-term call. */
const SEARCH_PER_TERM_LIMIT = 5;
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
  // NOTE: no early return on paths.length === 0 — the code-search fallback below
  // needs a minted token even when path discovery found nothing, so it can still
  // search for a bare backtick-quoted identifier.

  const slash = repoFullName.indexOf('/');
  const owner = slash > 0 ? repoFullName.slice(0, slash) : '';
  const repo = slash > 0 ? repoFullName.slice(slash + 1) : '';
  if (!owner || !repo) return '';

  // Compute the search terms up front — discoverSearchTerms needs no token. This
  // lets a NO-SIGNAL issue (no discovered paths AND no backtick-quoted terms)
  // return BEFORE minting a throwaway installation token, which the old
  // unconditional early-return removal would otherwise have done for every issue.
  const searchTerms =
    paths.length < PATH_DISCOVERY_SUFFICIENT
      ? discoverSearchTerms(issueText, { limit: SEARCH_TERM_LIMIT })
      : [];
  if (paths.length === 0 && searchTerms.length === 0) return '';

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

  // ── Code-search fallback: too few paths discovered, adapter supports it ────
  // Skip entirely when the shared breaker is already OPEN: /search/code is
  // decoupled from the breaker (its faults never trip it), so without this guard a
  // real GitHub outage would still burn up to MAX_SEARCH_CALLS × the fetch timeout
  // before the file-fetch path fails fast. Reading the breaker state here gives
  // search the same fail-fast the core path gets, without letting search mutate it.
  const searchPaths: string[] = [];
  if (
    searchTerms.length > 0 &&
    'searchCode' in adapter &&
    githubCircuitBreaker.getState() !== 'open'
  ) {
    const budget = Math.min(searchTerms.length, MAX_SEARCH_CALLS);
    for (let i = 0; i < budget; i++) {
      const term = searchTerms[i];
      if (term === undefined) break;
      try {
        const hits = await adapter.searchCode(repoRef, term, SEARCH_PER_TERM_LIMIT);
        searchPaths.push(...hits);
      } catch (err) {
        log.warn({ term, err: errMessage(err) }, 'code-evidence: code search failed; degrading');
        break;
      }
    }
  }

  // Merge PATH-PRECEDENCE (a path-discovered file is never displaced by a search
  // duplicate), deduped, capped at MAX_CODE_FILES.
  const merged: string[] = [];
  const seenPaths = new Set<string>();
  for (const p of [...paths, ...searchPaths]) {
    if (seenPaths.has(p)) continue;
    seenPaths.add(p);
    merged.push(p);
    if (merged.length >= MAX_CODE_FILES) break;
  }
  if (merged.length === 0) return '';

  // Fetch all merged paths CONCURRENTLY (bounded — at most MAX_CODE_FILES) so
  // the worker never serializes up to 6 × the 10s per-fetch timeout into the job's
  // lock window. Order is preserved (first-appearance). A per-file fault resolves
  // to null (skipped, surfaced) — never fatal.
  const fetched = await Promise.all(
    merged.map(async (path) => {
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
      { discovered: merged.length },
      'code-evidence: discovered paths but attached none; triaging text-only',
    );
    return '';
  }

  // Report what the model actually SEES (chars + files attached), plus anything
  // dropped for the budget — never over-report the fetch count as "attached".
  log.info(
    { discovered: merged.length, attached: sections.length, droppedForBudget, chars: usedChars },
    'code-evidence: attached referenced source to triage',
  );
  return [
    '## RELEVANT SOURCE CODE (files the issue references, at the default branch)',
    ...sections,
  ].join('\n');
}
