/**
 * GitLab client PORT (dependency inversion seam for the GitLab adapter).
 *
 * R-AGNOSTIC / boundary rule: `packages/forge` MUST NOT import a concrete HTTP
 * client. Mirroring {@link GitHubClientPort}, the {@link GitLabForgeAdapter}
 * declares — here — the exact GitLab REST function-set it depends on, and the
 * CALLER (the CLI, P4) injects a native-fetch implementation at construction.
 *
 * This interface is intentionally GitLab-native (numeric note ids, numeric
 * project id, MR iid): the adapter is the layer that maps GitLab-native shapes ↔
 * canonical forge types. Note ids cross THIS seam as PLAIN numbers
 * (GitLab-native) — boxing into the canonical `CommentId` (kind:'gitlab') happens
 * caller-LOCAL via {@link gitlabCommentId}, NOT here.
 *
 * SCOPE (P4 — MR summary post-back + inline-note publish):
 *   REAL members the adapter folds over:
 *     - listMrNotes   (GET    /projects/:id/merge_requests/:iid/notes)
 *     - createMrNote  (POST   /projects/:id/merge_requests/:iid/notes)
 *     - deleteMrNote  (DELETE /projects/:id/merge_requests/:iid/notes/:note_id)
 *     - updateMrNote  (PUT    /projects/:id/merge_requests/:iid/notes/:note_id)
 *   The CLI injects real fetch-backed impls (P4); read fns the adapter does not
 *   need (diff/details/file-list/commits/graph) are deliberately NOT on this
 *   port — the GitLab v1 deliverable is the summary-comment, and the CLI sources
 *   the diff locally (same posture as the GitHub CLI port).
 */

/** A single GitLab MR note as returned by the list endpoint (subset used). */
export interface GitLabNote {
  /** GitLab-native numeric note id. */
  id: number;
  /** Note body (markdown) — scanned for the GHAGGA marker. */
  body: string;
}

/**
 * The GitLab text-diff position payload for a discussion (`position_type=text`).
 *
 * Mirrors the GitLab discussions API `position[...]` fields. `oldPath`/`newPath`
 * are BOTH required by GitLab for a text diff note (they coincide for a
 * non-renamed file). At least one of `oldLine`/`newLine` must be set.
 */
export interface GitLabDiffPosition {
  baseSha: string;
  headSha: string;
  startSha: string;
  oldPath: string;
  newPath: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * The set of GitLab REST functions the {@link GitLabForgeAdapter} depends on.
 *
 * Calls are project-id + MR-iid positional (the GitLab MR API path is
 * `/projects/:id/merge_requests/:iid/...`). `projectId` is the GitLab NUMERIC
 * project id (canonical — the group/project path is mutable). The adapter
 * receives an implementation via its constructor (dependency inversion) so the
 * forge package never imports a concrete client.
 */
export interface GitLabClientPort {
  /** List the notes on an MR (chronological); returns id + body per note. */
  listMrNotes(projectId: string, mrIid: number, token: string): Promise<GitLabNote[]>;

  /** Create a fresh MR note; returns the GitLab-native numeric note id. */
  createMrNote(
    projectId: string,
    mrIid: number,
    body: string,
    token: string,
  ): Promise<{ id: number }>;

  /** Delete an MR note by its GitLab-native numeric note id. */
  deleteMrNote(projectId: string, mrIid: number, noteId: number, token: string): Promise<void>;

  /** Update an MR note in place by its GitLab-native numeric note id. */
  updateMrNote(
    projectId: string,
    mrIid: number,
    noteId: number,
    body: string,
    token: string,
  ): Promise<void>;

  /**
   * Create a diff-anchored MR DISCUSSION (`POST /merge_requests/:iid/discussions`
   * with `position[position_type]=text`). Used by `publishInline` when the
   * caller supplies a {@link GitLabDiffPosition}. Returns the GitLab-native
   * numeric id of the discussion's FIRST note (so it boxes like a note id).
   *
   * OPTIONAL: an injected client MAY omit this (older CLI builds). When absent,
   * `publishInline` degrades a positioned comment to a plain `path:line` note.
   */
  createMrDiscussion?(
    projectId: string,
    mrIid: number,
    body: string,
    position: GitLabDiffPosition,
    token: string,
  ): Promise<{ id: number }>;
}
