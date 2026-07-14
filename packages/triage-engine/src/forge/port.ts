/**
 * ForgeAdapter — the ONLY I/O boundary to the issue tracker (design.md
 * "Module Architecture" boundaries). GitLab and GitHub adapters implement
 * this interface via their respective CLIs (`glab`/`gh`); no other module
 * talks to the forge directly.
 *
 * `postComment` accepts ONLY a `PostableReply` — a branded string
 * constructible exclusively via `approveDraft` (see ../types/postable.ts).
 * This makes it a compile-time error to post an `IssueDraft.report`
 * (internal technical analysis) or raw reproduction evidence to the forge.
 */

import type { PostableReply } from '../types/postable.js';

/** A single comment/note on an issue, forge-agnostic. */
export interface ForgeComment {
  body: string;
  author?: string;
  createdAt?: string;
}

/** Normalized issue shape shared by every forge adapter. */
export interface ForgeIssue {
  /** Issue number (GitLab "iid" / GitHub "number"), always as a string. */
  iid: string;
  title: string;
  /** Issue body/description, with forge-specific metadata (e.g. widget blocks) stripped. */
  description: string;
  labels: string[];
  url: string;
  comments: ForgeComment[];
}

export interface ForgeIssueFilter {
  /** Restrict to issues carrying this label. */
  label?: string;
  /** Max number of issues to return. Defaults to a forge-specific sane cap. */
  limit?: number;
}

export interface ForgeAdapter {
  /** Lists issues matching an optional filter. Does NOT include comments (list views are lightweight). */
  listIssues(filter?: ForgeIssueFilter): Promise<ForgeIssue[]>;
  /** Fetches a single issue in full, including comments. */
  getIssue(iid: string): Promise<ForgeIssue>;
  /** Posts a comment. Accepts ONLY a PostableReply — see module doc above. */
  postComment(iid: string, reply: PostableReply): Promise<void>;
}
