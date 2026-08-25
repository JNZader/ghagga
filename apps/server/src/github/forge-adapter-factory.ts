/**
 * GitHub forge-adapter composition root (SDD forge-agnostic 1.4b).
 *
 * This is the SOLE module in apps/server that wires the concrete `client.ts`
 * forge-adapter functions into the forge-agnostic {@link GitHubClientPort}. Every
 * forge consumer (the review worker AND the webhook issue_comment handler) builds
 * its adapter through {@link makeGitHubAdapter} — so the 12 `client.ts`
 * forge-adapter fns have EXACTLY ONE sanctioned consumer (this factory). That
 * single chokepoint is what makes the 1.5/1.6 lockdown trivial.
 *
 * BOUNDARY (R-AGNOSTIC): this file lives in apps/server. It MAY import both
 * `ghagga-forge` (the adapter + port type) and the local `client.ts` — the
 * dependency-inversion rule only forbids `packages/forge` importing
 * `apps/server`, never the reverse. The factory is the composition root that
 * performs that wiring.
 *
 * LAZY-GETTER TECHNIQUE (load-bearing — do NOT inline-bind):
 * Each port member is a GETTER that reads the client export LAZILY (only when
 * the adapter actually invokes that method). This is what lets the existing
 * test mocks of `../github/client.js` still intercept: vitest's ESM mock proxy
 * THROWS on access of any export the mock doesn't declare, so the GitHub flows
 * that never call certain members (e.g. webhook never calls fetchPRDiff /
 * fetchGraphMetadata) never trip the proxy. The namespace import accesses
 * members at call time, not at module-eval time.
 */

import type { GitHubClientPort } from 'ghagga-forge';
import { GitHubForgeAdapter } from 'ghagga-forge';
// Namespace import (NOT named imports): the GitHubClientPort is assembled from
// these at runtime. A namespace import accesses members lazily at call time, so
// members the EXISTING test mocks of '../github/client.js' don't export stay
// `undefined` instead of triggering vitest's named-import mock validation —
// keeping the baseline tests passing UNMODIFIED.
import * as githubClient from './client.js';

/**
 * The forge-agnostic port assembled from the real `client.ts` functions.
 *
 * CRITICAL: these bindings come from `./client.js`, the SAME module the existing
 * tests mock — so the adapter ends up calling the mocked functions. Each member
 * is a lazy getter (see file header).
 */
const githubClientPort: GitHubClientPort = {
  get fetchPRDiff() {
    return githubClient.fetchPRDiff;
  },
  get fetchPRDetails() {
    return githubClient.fetchPRDetails;
  },
  get getPRFileList() {
    return githubClient.getPRFileList;
  },
  get getPRCommitMessages() {
    return githubClient.getPRCommitMessages;
  },
  get postComment() {
    return githubClient.postComment;
  },
  get findExistingComment() {
    return githubClient.findExistingComment;
  },
  get deleteComment() {
    return githubClient.deleteComment;
  },
  get updateComment() {
    return githubClient.updateComment;
  },
  get addCommentReaction() {
    return githubClient.addCommentReaction;
  },
  get fetchGraphFromBranch() {
    return githubClient.fetchGraphFromBranch;
  },
  get fetchGraphMetadata() {
    return githubClient.fetchGraphMetadata;
  },
  get fetchFileContents() {
    return githubClient.fetchFileContents;
  },
};

/** Per-call composition input for {@link makeGitHubAdapter}. */
export interface MakeGitHubAdapterDeps {
  /** Repository owner (login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Installation access token used for all calls on this adapter. */
  token: string;
}

/**
 * Build a {@link GitHubForgeAdapter} wired to the real `client.ts` forge fns.
 *
 * BEHAVIOR-IDENTICAL: this returns the exact same adapter the call-sites
 * previously constructed inline, with the same `githubClientPort` wiring. The
 * caller still owns its token model (mint count / phase boundaries) — this
 * factory just performs the wiring.
 */
export function makeGitHubAdapter({
  owner,
  repo,
  token,
}: MakeGitHubAdapterDeps): GitHubForgeAdapter {
  return new GitHubForgeAdapter({ client: githubClientPort, token, owner, repo });
}

/**
 * Post a single plain comment to an issue (or PR) and return its created id.
 *
 * SANCTIONED CONSUMER: the forge-boundary lint makes THIS factory module the
 * SOLE place in apps/server allowed to touch the @internal `client.ts`
 * forge-adapter fns. The issue-draft approval route
 * (routes/api/issue-drafts.ts) posts the human-approved draft body through this
 * helper rather than importing the @internal `postComment` directly — the
 * GitHubForgeAdapter itself only exposes marker-deduped `upsertSummaryComment`
 * (wrong semantics for a fresh, one-shot issue comment), so a thin sanctioned
 * passthrough is the minimal boundary-respecting seam. Behavior-identical to a
 * direct `client.postComment(owner, repo, issueNumber, body, token)`.
 */
export async function postIssueComment(
  { owner, repo, token }: MakeGitHubAdapterDeps,
  issueNumber: number,
  body: string,
): Promise<{ id: number }> {
  return githubClient.postComment(owner, repo, issueNumber, body, token);
}
