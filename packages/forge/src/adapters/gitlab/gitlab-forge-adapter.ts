/**
 * GitLabForgeAdapter — wraps a GitLab REST client behind the forge-agnostic
 * {@link ForgeAdapterBase} + {@link InlineCapable} surfaces.
 *
 * DEPENDENCY INVERSION (boundary rule R-AGNOSTIC):
 * `packages/forge` MUST NOT import a concrete HTTP client. This adapter depends
 * on the injected {@link GitLabClientPort} (declared inside the forge package);
 * the CLI (P4) constructs the adapter passing a native-fetch implementation:
 *
 *   new GitLabForgeAdapter({ client, token, projectId })
 *
 * IDENTITY (R-GITLAB):
 * - {@link RepoRef.nativeId} is the GitLab NUMERIC project id (the group/project
 *   `path` is mutable → the id is canonical). The adapter is constructed with the
 *   numeric `projectId` and routes EVERY REST call through it — never the path.
 * - {@link ChangeRequestRef.iid} is the MR iid (project-scoped). The GitLab MR
 *   API path is `/projects/:id/merge_requests/:iid/...`.
 *
 * CAPABILITIES: reactions ❌ (GitLab reaction-award is not modelled — no
 * `addReaction`), inlineComments ✅ (publishInline present), graphRead ❌ (no
 * graph methods). The `capabilities` field is a HINT only (R-CAPABILITY): callers
 * guard optional methods by method-presence, never by these flags.
 *
 * SCOPE — v1 deliverable is the SUMMARY COMMENT (upsertSummaryComment). The
 * adapter also implements {@link InlineCapable.publishInline} to satisfy
 * R-LEAK-PUBLISH: it posts N INDEPENDENT inline posts, returning a
 * {@link PublishReport} where partial failure is FIRST-CLASS (never swallowed).
 * INLINE POSITIONING: when an {@link InlineComment} carries `position` and the
 * injected client supports `createMrDiscussion`, v1 posts a TRUE diff-anchored
 * discussion (`position[position_type]=text` + the three SHAs + old/new line +
 * old/new path). When `position` is absent (or the client lacks discussion
 * support) it degrades to a plain MR note carrying the `path:line` prefix in the
 * body. The public {@link InlineComment} type carries `position` + `oldPath`/
 * `newPath` regardless, so broadening positioned coverage needs NO API change.
 *
 * COMMENT IDs: `upsertSummaryComment` returns PLAIN GitLab-native numeric ids
 * (boxing happens caller-LOCAL via {@link gitlabCommentId}). `publishInline`
 * boxes per the {@link PublishReport} contract (CommentId) since the report is
 * the canonical cross-forge shape.
 */

import { gitlabCommentId } from '../../comment-id.js';
import { ForgeAuthError, getErrorStatus, isForgeAuthError } from '../../errors.js';
import type { ForgeAdapterBase, InlineCapable, InlineComment } from '../../ports/forge-adapter.js';
import type {
  ChangedFile,
  ChangeRequest,
  ChangeRequestRef,
  CommentMarker,
  Commit,
  ForgeCapabilities,
  PublishFailure,
  PublishReport,
  UnifiedDiff,
  UpsertSummaryResult,
} from '../../types.js';
import type { GitLabClientPort } from './gitlab-client-port.js';

/** Construction options for {@link GitLabForgeAdapter}. */
export interface GitLabForgeAdapterDeps {
  /** Injected GitLab REST function-set (real impl = the CLI's fetch client). */
  client: GitLabClientPort;
  /** GitLab Personal Access Token used for all calls. */
  token: string;
  /**
   * The GitLab NUMERIC project id (canonical — see R-GITLAB). NOT the mutable
   * group/project path. The CLI resolves this from the path via
   * `GET /projects/:url-encoded-path` before constructing the adapter.
   */
  projectId: string;
}

/**
 * GitLab implementation of the forge adapter.
 *
 * Implements the mandatory base (summary-comment + the read methods, the latter
 * unused by the CLI v1 path and intentionally absent from the client port) plus
 * {@link InlineCapable}. Deliberately does NOT implement reactions or graph read.
 */
export class GitLabForgeAdapter implements ForgeAdapterBase, InlineCapable {
  readonly capabilities: ForgeCapabilities = {
    reactions: false,
    inlineComments: true,
    graphRead: false,
  };

  readonly #client: GitLabClientPort;
  readonly #token: string;
  readonly #projectId: string;

  constructor(deps: GitLabForgeAdapterDeps) {
    this.#client = deps.client;
    this.#token = deps.token;
    this.#projectId = deps.projectId;
  }

  /**
   * Run a client call, reclassifying a 401/403 failure as a {@link ForgeAuthError}
   * (mirrors the GitHub adapter). With a static PAT a 401 is terminal — there is
   * nothing to re-mint — but the typed signal keeps the CLI's error reporting
   * consistent across forges. NON-auth failures rethrow UNCHANGED.
   */
  async #mapAuth<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 401 || status === 403) {
        throw new ForgeAuthError(
          status,
          error instanceof Error ? error.message : `Forge auth failure (HTTP ${status})`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  // ─── Base: reads ───────────────────────────────────────────────
  //
  // The GitLab CLI v1 deliverable is the summary comment; the diff/details/
  // file-list/commits are sourced LOCALLY by the CLI (same posture as the GitHub
  // CLI port). These methods are part of the mandatory base surface but are NOT
  // exercised by the `--mr` flow, so they fail loudly rather than fabricate data.

  fetchDiff(_ref: ChangeRequestRef): Promise<UnifiedDiff> {
    return Promise.reject(
      new Error(
        'GitLabForgeAdapter.fetchDiff is not supported in the CLI summary-comment path — ' +
          'the diff is sourced locally. (GitLab read methods are a v2 deliverable.)',
      ),
    );
  }

  fetchChangeRequest(_ref: ChangeRequestRef): Promise<ChangeRequest> {
    return Promise.reject(
      new Error('GitLabForgeAdapter.fetchChangeRequest is not supported (v2 deliverable).'),
    );
  }

  fetchFileList(_ref: ChangeRequestRef): Promise<ChangedFile[]> {
    return Promise.reject(
      new Error('GitLabForgeAdapter.fetchFileList is not supported (v2 deliverable).'),
    );
  }

  fetchCommits(_ref: ChangeRequestRef): Promise<Commit[]> {
    return Promise.reject(
      new Error('GitLabForgeAdapter.fetchCommits is not supported (v2 deliverable).'),
    );
  }

  // ─── Base: upsert summary comment (fold list/delete/create → 1) ──

  /**
   * Idempotently upsert the single GHAGGA summary note on an MR.
   *
   * Behavior (FORGE-UPSERT-005 remediation — update-in-place, never
   * delete-before-create; mirrors the GitHub adapter):
   * 1. list MR notes; match the GHAGGA-owned ones by `marker.html` substring.
   *    "latest" = the LAST marker-matching note in chronological order
   *    (GitLab list returns notes oldest-first).
   * 2a. NO matching note: create a FRESH note. Failure here just means no
   *     summary was ever created — no regression vs. the previous behavior.
   * 2b. A matching note exists: update the LATEST one IN PLACE via
   *     `client.updateMrNote`. This is the ONLY error that propagates from the
   *     existing-note path — and it propagates BEFORE anything has been
   *     deleted, so a transient update failure (timeout / 5xx) leaves the
   *     MR's PREVIOUS valid review intact instead of no review at all (the
   *     bug this remediation closes). Only AFTER the update confirms success
   *     are the stale duplicate notes removed, BEST-EFFORT: each delete is
   *     per-note try/catch so a 404 (already gone) OR any other failure is
   *     tolerated and does NOT undo the successful update.
   *
   * Returns GitLab-native numeric ids (boxing happens caller-local via
   * {@link gitlabCommentId}).
   */
  async upsertSummaryComment(
    ref: ChangeRequestRef,
    body: string,
    marker: CommentMarker,
  ): Promise<UpsertSummaryResult> {
    const notes = await this.#mapAuth(() =>
      this.#client.listMrNotes(this.#projectId, ref.iid, this.#token),
    );

    const matchIds = notes.filter((n) => n.body.includes(marker.html)).map((n) => n.id);

    if (matchIds.length === 0) {
      // No prior GHAGGA note: the only safe move is to create a fresh one. A
      // 401/403 here is reclassified to ForgeAuthError.
      const created = await this.#mapAuth(() =>
        this.#client.createMrNote(this.#projectId, ref.iid, body, this.#token),
      );

      if (created?.id == null) {
        throw new TypeError(
          'GitLabForgeAdapter.upsertSummaryComment: createMrNote returned no id (expected { id: number })',
        );
      }

      return { created: created.id, deleted: [] };
    }

    // latest = last marker note; the rest are stale. (Guaranteed non-empty
    // inside this `matchIds.length > 0` branch.)
    const latestId = matchIds[matchIds.length - 1] as number;
    const staleIds = matchIds.slice(0, -1);

    // Update the latest note IN PLACE. This is the ONLY error that propagates
    // from the existing-note path — and it propagates BEFORE anything has
    // been deleted, so the previous review remains visible on the MR if this
    // fails transiently. A 401/403 here is reclassified to ForgeAuthError.
    await this.#mapAuth(() =>
      this.#client.updateMrNote(this.#projectId, ref.iid, latestId, body, this.#token),
    );

    // The update confirmed success — now it's safe to prune stale duplicates.
    // BEST-EFFORT: tolerate any delete failure (404 or non-404), since the
    // now-current note already carries the fresh body regardless of whether
    // the old duplicates get cleaned up.
    const deleted: number[] = [];
    for (const noteId of staleIds) {
      try {
        await this.#client.deleteMrNote(this.#projectId, ref.iid, noteId, this.#token);
        deleted.push(noteId);
      } catch {
        // Best-effort: a stale duplicate that cannot be deleted must NOT be
        // treated as a failure of the upsert — the primary note is already
        // updated.
      }
    }

    return { created: latestId, deleted };
  }

  // ─── InlineCapable ─────────────────────────────────────────────

  /**
   * Publish a batch of inline comments as N INDEPENDENT posts (R-LEAK-PUBLISH).
   *
   * PARTIAL FAILURE IS FIRST-CLASS: GitLab posts each comment independently, so
   * each create is wrapped in its own try/catch. A failure records
   * `{index, error, status?, authFailure?}` into `failed` and the loop CONTINUES
   * — failures are NEVER swallowed and never abort the remaining posts. The
   * `status`/`authFailure` tags let a caller tell an AUTH failure (401/403, a
   * static PAT cannot recover) from a transient one without string-parsing the
   * message. Successes are boxed into `CommentId` (kind:'gitlab') and collected
   * into `posted`.
   *
   * POSITION HANDLING (v1):
   * - When a comment carries `position` AND the injected client implements
   *   `createMrDiscussion`, the adapter posts a TRUE diff-anchored discussion
   *   (`position[position_type]=text` with the three SHAs + old/new line +
   *   old/new path — renames are honored via `oldPath`/`newPath`, defaulting to
   *   `path`). The boxed id is the discussion's first-note id.
   * - Otherwise (no `position`, or a client without discussion support) it
   *   degrades to a plain MR note carrying a `path:line` body prefix so the
   *   anchor info is not lost. Either way the partial-failure REPORT SHAPE +
   *   independent-post semantics — the load-bearing R-LEAK-PUBLISH contract —
   *   hold. The public {@link InlineComment} type carries `position` regardless,
   *   so no future API change is needed to broaden positioned coverage.
   */
  async publishInline(ref: ChangeRequestRef, comments: InlineComment[]): Promise<PublishReport> {
    const posted: PublishReport['posted'] = [];
    const failed: PublishFailure[] = [];

    for (let index = 0; index < comments.length; index++) {
      const comment = comments[index];
      if (comment == null) continue;
      try {
        const created = await this.#postInline(ref, comment);
        if (created?.id == null) {
          throw new TypeError('inline post returned no id (expected { id: number })');
        }
        posted.push(gitlabCommentId(created.id));
      } catch (error) {
        // First-class partial failure: record and CONTINUE (never swallow, never
        // abort the rest). No #mapAuth reclassification here — a per-note failure
        // is reported, not thrown, so the batch outcome is observable.
        //
        // TAG the failure so a caller can distinguish an AUTH failure (401/403 —
        // a static PAT cannot recover, surface "fix your token") from a transient
        // one WITHOUT string-parsing `error`. `#postInline` does not run through
        // `#mapAuth`, so the raw client error still carries its numeric `status`;
        // `isForgeAuthError` ALSO catches an already-reclassified ForgeAuthError
        // for robustness.
        const status = getErrorStatus(error);
        const authFailure = isForgeAuthError(error) || status === 401 || status === 403;
        failed.push({
          index,
          error: error instanceof Error ? error.message : String(error),
          ...(status != null ? { status } : {}),
          ...(authFailure ? { authFailure: true } : {}),
        });
      }
    }

    return { posted, failed };
  }

  /**
   * Post a single inline comment: a TRUE diff-anchored discussion when the
   * comment carries `position` AND the client supports it, else a degraded
   * `path:line` plain note. Throws on a missing id (the caller records it as a
   * per-comment failure).
   */
  #postInline(ref: ChangeRequestRef, comment: InlineComment): Promise<{ id: number }> {
    const createDiscussion = this.#client.createMrDiscussion;
    if (comment.position && typeof createDiscussion === 'function') {
      return createDiscussion.call(
        this.#client,
        this.#projectId,
        ref.iid,
        comment.body,
        {
          baseSha: comment.position.baseSha,
          headSha: comment.position.headSha,
          startSha: comment.position.startSha,
          // GitLab requires BOTH paths for a text diff note; default to `path`.
          oldPath: comment.oldPath ?? comment.path,
          newPath: comment.newPath ?? comment.path,
          ...(comment.position.oldLine != null ? { oldLine: comment.position.oldLine } : {}),
          ...(comment.position.newLine != null ? { newLine: comment.position.newLine } : {}),
        },
        this.#token,
      );
    }
    // Degrade: encode the anchor in the body as a plain note.
    const noteBody = `\`${comment.path}:${comment.line}\`\n\n${comment.body}`;
    return this.#client.createMrNote(this.#projectId, ref.iid, noteBody, this.#token);
  }
}
