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
 * R-LEAK-PUBLISH: it posts N INDEPENDENT MR notes, returning a
 * {@link PublishReport} where partial failure is FIRST-CLASS (never swallowed).
 * V2-DEFERRED: full inline POSITIONING (anchoring each note to a diff line via
 * `position{base_sha, head_sha, start_sha, old_line, new_line}` — the GitLab
 * discussion API). v1 posts each inline comment as a plain MR note carrying its
 * `path:line` prefix in the body; the partial-failure SEMANTICS (report shape +
 * independent-post + never-swallow) are fully implemented now. `diffRefs` plumbing
 * for true anchoring lands in v2.
 *
 * COMMENT IDs: `upsertSummaryComment` returns PLAIN GitLab-native numeric ids
 * (boxing happens caller-LOCAL via {@link gitlabCommentId}). `publishInline`
 * boxes per the {@link PublishReport} contract (CommentId) since the report is
 * the canonical cross-forge shape.
 */

import { gitlabCommentId } from '../../comment-id.js';
import { ForgeAuthError, getErrorStatus } from '../../errors.js';
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
   * Behavior (mirrors the GitHub adapter's delete-all-stale + repost-at-bottom):
   * 1. list MR notes; match the GHAGGA-owned ones by `marker.html` substring.
   * 2. delete ALL matches in `[latest, ...stale]` order — BEST-EFFORT: each
   *    delete is per-note try/catch so a 404 (already gone) OR any other failure
   *    is tolerated and does NOT block the repost. Only ids that actually deleted
   *    (no throw) are reported in `deleted`.
   * 3. create a FRESH note at the bottom — this is the ONLY failure that
   *    propagates (a failed create means no summary exists, which is fatal).
   *
   * "latest" = the LAST marker-matching note in chronological order (GitLab list
   * returns notes oldest-first), matching the GitHub adapter's convention.
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

    const deleted: number[] = [];
    if (matchIds.length > 0) {
      // latest = last marker note; the rest are stale. Delete latest FIRST then
      // stale, mirroring the GitHub adapter's baseline order.
      const latestId = matchIds[matchIds.length - 1];
      const staleIds = matchIds.slice(0, -1);
      const ordered = latestId == null ? staleIds : [latestId, ...staleIds];
      for (const noteId of ordered) {
        try {
          await this.#client.deleteMrNote(this.#projectId, ref.iid, noteId, this.#token);
          deleted.push(noteId);
        } catch {
          // Best-effort: tolerate any delete failure (404 or non-404). A stale
          // note that cannot be deleted must NOT block the fresh repost.
        }
      }
    }

    // Always create a fresh note at the bottom. This is the ONLY error that
    // propagates. A 401/403 here is reclassified to ForgeAuthError.
    const created = await this.#mapAuth(() =>
      this.#client.createMrNote(this.#projectId, ref.iid, body, this.#token),
    );

    if (created?.id == null) {
      throw new TypeError(
        'GitLabForgeAdapter.upsertSummaryComment: createMrNote returned no id (expected { id: number })',
      );
    }

    return { created: created.id, deleted };
  }

  // ─── InlineCapable ─────────────────────────────────────────────

  /**
   * Publish a batch of inline comments as N INDEPENDENT MR notes (R-LEAK-PUBLISH).
   *
   * PARTIAL FAILURE IS FIRST-CLASS: GitLab posts each note independently, so each
   * create is wrapped in its own try/catch. A failure records `{index, error}`
   * into `failed` and the loop CONTINUES — failures are NEVER swallowed and never
   * abort the remaining posts. Successes are boxed into `CommentId` (kind:'gitlab')
   * and collected into `posted`.
   *
   * V2-DEFERRED: true line-anchoring via the GitLab discussion `position{}` API
   * (base_sha/head_sha/start_sha/old_line/new_line from {@link UnifiedDiff.diffRefs}).
   * v1 posts each comment as a plain MR note with a `path:line` body prefix so the
   * information is not lost; the partial-failure REPORT SHAPE + independent-post
   * semantics — the load-bearing R-LEAK-PUBLISH contract — are fully delivered now.
   */
  async publishInline(ref: ChangeRequestRef, comments: InlineComment[]): Promise<PublishReport> {
    const posted: PublishReport['posted'] = [];
    const failed: PublishFailure[] = [];

    for (let index = 0; index < comments.length; index++) {
      const comment = comments[index];
      if (comment == null) continue;
      // v1: encode the anchor in the body (true position{} anchoring is v2).
      const noteBody = `\`${comment.path}:${comment.line}\`\n\n${comment.body}`;
      try {
        const created = await this.#client.createMrNote(
          this.#projectId,
          ref.iid,
          noteBody,
          this.#token,
        );
        if (created?.id == null) {
          throw new TypeError('createMrNote returned no id (expected { id: number })');
        }
        posted.push(gitlabCommentId(created.id));
      } catch (error) {
        // First-class partial failure: record and CONTINUE (never swallow, never
        // abort the rest). No #mapAuth reclassification here — a per-note failure
        // is reported, not thrown, so the batch outcome is observable.
        failed.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { posted, failed };
  }
}
