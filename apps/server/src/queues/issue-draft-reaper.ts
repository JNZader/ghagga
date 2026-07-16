/**
 * Stuck-APPROVED issue-draft REAPER.
 *
 * PROBLEM (see routes/api/issue-drafts.ts approve handler): the approve flow is
 *   CAS claim (DRAFT→APPROVED, stamps claimedAt) → getInstallationToken →
 *   postIssueComment → markIssueDraftPosted (APPROVED→POSTED).
 * If the process is SIGKILL/OOM-killed between postIssueComment returning and
 * markIssueDraftPosted committing, the row is stuck APPROVED with claimedAt set
 * and postedCommentId NULL — and the comment MAY already be live on GitHub.
 * findStaleApprovedDrafts (ghagga-db) DETECTS those rows; this reaper RECOVERS
 * them WITHOUT double-posting, using the invisible per-draft marker that the
 * approve path now embeds in the posted comment body (github/issue-draft-marker).
 *
 * DECISION PER STALE DRAFT:
 *   - list the issue's recent comments; ANY read failure → SKIP (never act on an
 *     ambiguous read — a false "no marker" would double-post on human retry).
 *   - a comment carries THIS draft's marker AND is authored by the app's own bot
 *     → the comment is LIVE → record POSTED (markIssueDraftPosted, APPROVED→POSTED
 *     CAS) with that comment id. NO release.
 *   - a comment carries the marker but is authored by SOMEONE ELSE → treat as a
 *     spoof attempt (a collaborator/public user could paste the marker to trick
 *     the reaper into discarding the real approved comment). This is ambiguous, so
 *     take the SAFE action: SKIP (leave APPROVED) — never mark POSTED (would
 *     discard the genuine comment) and never release (would risk a double-post if
 *     the marker were in fact genuine). See `isAppBotAuthor`.
 *   - no marker for this draft at all → the crash was PRE-post (nothing live) →
 *     release the claim (releaseIssueDraftClaim, APPROVED→DRAFT CAS) so a human
 *     can retry.
 *   Every transition is CAS-guarded: `undefined` means a concurrent late approve
 *   or another reaper tick already moved the row — treated as a no-op, not error.
 *   The ENTIRE per-draft body (read AND write) is isolated in try/catch so one
 *   draft's transient DB/GitHub failure is counted as skipped and never aborts
 *   the batch — every remaining stale draft is still attempted.
 *
 * The marker ships WITH this change and the subsystem has no pre-existing drafts,
 * so "no marker" reliably means a pre-post crash — no pre-marker-orphan heuristic
 * is needed.
 */

import {
  type Database,
  findStaleApprovedDrafts,
  getInstallationById,
  getRepositoryById,
  markIssueDraftPosted,
  releaseIssueDraftClaim,
} from 'ghagga-db';
import type { getInstallationToken, listIssueComments } from '../github/client.js';
import { commentHasIssueDraftMarker } from '../github/issue-draft-marker.js';

/** Minimal structural logger (satisfied by pino + the child loggers used here). */
export interface ReaperLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/**
 * Injected side-effectful collaborators (GitHub token exchange + comment list)
 * so the reaper is unit-testable without real network/DB. The pure DB queries
 * (findStaleApprovedDrafts / getRepositoryById / getInstallationById /
 * markIssueDraftPosted / releaseIssueDraftClaim) are imported directly and
 * driven with the `db` handle — tests mock the `ghagga-db` module.
 */
export interface ReaperDeps {
  getInstallationToken: typeof getInstallationToken;
  listIssueComments: typeof listIssueComments;
  /** GitHub App id (process.env.GITHUB_APP_ID at the call site). */
  appId: string;
  /** GitHub App private key (process.env.GITHUB_PRIVATE_KEY at the call site). */
  privateKey: string;
  /**
   * The app's own bot login used to authenticate a marked comment as genuinely
   * posted by us (anti-spoofing — see the module header). When set (e.g.
   * `${GITHUB_APP_SLUG}[bot]` at the call site), a marked comment counts as proof
   * of posting ONLY if `comment.author === botLogin` (exact match). When UNSET,
   * we fall back to requiring the author to end with `[bot]`, which still closes
   * the main vector (a human collaborator's comment cannot spoof it); the residual
   * limitation is that ANOTHER GitHub App's bot could theoretically match — set
   * this to eliminate it. See `isAppBotAuthor`.
   */
  botLogin?: string;
  /** Reap drafts whose claimedAt is older than now - staleMs. */
  staleMs: number;
  /** How many recent comments to scan for the marker (default 50). */
  commentFetchCount?: number;
  log: ReaperLogger;
}

/** Outcome tally for logging + testing. */
export interface ReaperSummary {
  scanned: number;
  markedPosted: number;
  released: number;
  skipped: number;
}

const DEFAULT_COMMENT_FETCH_COUNT = 50;

/**
 * Is `author` the app's own bot? Anti-spoofing gate for marked comments.
 *   - `botLogin` set → exact match required (`${GITHUB_APP_SLUG}[bot]`).
 *   - `botLogin` unset → fall back to `endsWith('[bot]')`, which still rejects any
 *     human collaborator/public user (the primary spoof vector).
 * A missing/`'unknown'` author (listIssueComments' null fallback) never matches.
 */
function isAppBotAuthor(author: string, botLogin: string | undefined): boolean {
  if (botLogin) return author === botLogin;
  return author.endsWith('[bot]');
}

/**
 * Scan for stuck-APPROVED drafts older than `staleMs` and recover each one.
 * Processes drafts sequentially — the stale set is small (capped at 100 by
 * findStaleApprovedDrafts) and sequential keeps GitHub request pressure low.
 */
export async function reapStaleApprovedDrafts(
  db: Database,
  deps: ReaperDeps,
): Promise<ReaperSummary> {
  const { log } = deps;
  const commentFetchCount = deps.commentFetchCount ?? DEFAULT_COMMENT_FETCH_COUNT;

  const olderThan = new Date(Date.now() - deps.staleMs);
  const stale = await findStaleApprovedDrafts(db, olderThan);

  const summary: ReaperSummary = {
    scanned: stale.length,
    markedPosted: 0,
    released: 0,
    skipped: 0,
  };

  for (const draft of stale) {
    // ── Isolate the ENTIRE per-draft body (read AND write) so a transient
    // failure on ONE draft (DB write error, token mint, GitHub outage) is
    // counted as skipped and the loop CONTINUES to the next stale draft —
    // a single write failure must never abort the whole batch.
    try {
      // ── Resolve owner/repo + installation token (same chain as the approve
      // route: getRepositoryById → getInstallationById → getInstallationToken).
      // Any gap in that chain is unrecoverable read state → SKIP (never act).
      let owner: string;
      let repoName: string;
      let token: string;
      try {
        const repo = await getRepositoryById(db, draft.repositoryId);
        if (!repo) {
          summary.skipped++;
          log.warn(
            { draftId: draft.id, repositoryId: draft.repositoryId },
            'reaper: repository not found for stale draft — skipping',
          );
          continue;
        }
        const installation = await getInstallationById(db, repo.installationId);
        if (!installation) {
          summary.skipped++;
          log.warn(
            { draftId: draft.id, installationId: repo.installationId },
            'reaper: installation not found for stale draft — skipping',
          );
          continue;
        }
        const [ownerPart, repoPart] = repo.fullName.split('/') as [string, string];
        owner = ownerPart;
        repoName = repoPart;
        // Token is minted for the GITHUB installation id, not our internal row id.
        token = await deps.getInstallationToken(
          installation.githubInstallationId,
          deps.appId,
          deps.privateKey,
        );
      } catch (err) {
        // Token mint failure / uninstalled app / transient DB read — AMBIGUOUS.
        // SKIP: neither release nor mark. A later tick retries once state clears.
        summary.skipped++;
        log.warn(
          { err, draftId: draft.id },
          'reaper: failed to resolve token for stale draft — skipping (no action)',
        );
        continue;
      }

      // ── Read the issue's recent comments. ANY throw (GitHub outage, rate
      // limit, uninstalled app) → SKIP: acting on a failed read could double-post.
      let comments: Awaited<ReturnType<typeof listIssueComments>>;
      try {
        comments = await deps.listIssueComments(
          owner,
          repoName,
          draft.issueNumber,
          token,
          commentFetchCount,
        );
      } catch (err) {
        summary.skipped++;
        log.warn(
          { err, draftId: draft.id, issueNumber: draft.issueNumber },
          'reaper: failed to list issue comments for stale draft — skipping (no action)',
        );
        continue;
      }

      // Comments carrying THIS draft's marker (regardless of author).
      const markedComments = comments.filter((c) => commentHasIssueDraftMarker(c.body, draft.id));
      // Proof of posting requires BOTH the marker AND the app's own bot as author.
      const liveComment = markedComments.find((c) => isAppBotAuthor(c.author, deps.botLogin));

      if (liveComment) {
        // The comment IS live → record POSTED (APPROVED→POSTED CAS). Never release.
        const updated = await markIssueDraftPosted(db, draft.id, liveComment.id);
        if (updated) {
          summary.markedPosted++;
          log.info(
            {
              draftId: draft.id,
              commentId: liveComment.id,
              issueNumber: draft.issueNumber,
              repo: `${owner}/${repoName}`,
            },
            'reaper: recovered stuck-APPROVED draft — comment was LIVE, recorded POSTED',
          );
        } else {
          // CAS matched zero rows: a late approve / another tick already decided it.
          log.info(
            { draftId: draft.id, commentId: liveComment.id },
            'reaper: stale draft no longer APPROVED at POSTED transition (race) — no-op',
          );
        }
      } else if (markedComments.length > 0) {
        // The marker is present but NO marked comment is authored by our bot →
        // likely a SPOOF (someone pasted the marker). Ambiguous → SAFE action is
        // SKIP: leave APPROVED for a human / next tick. Do NOT mark POSTED (would
        // discard the genuine approved comment) and do NOT release (would risk a
        // double-post if the marker were in fact genuine but authored oddly).
        summary.skipped++;
        log.warn(
          {
            draftId: draft.id,
            issueNumber: draft.issueNumber,
            repo: `${owner}/${repoName}`,
            authors: markedComments.map((c) => c.author),
          },
          'reaper: marker present but not authored by the app bot — possible spoof, skipping (no action)',
        );
      } else {
        // No marker for this draft → crash was PRE-post (nothing live on GitHub) →
        // release the claim (APPROVED→DRAFT CAS) so a human can retry.
        const released = await releaseIssueDraftClaim(db, draft.id);
        if (released) {
          summary.released++;
          log.info(
            { draftId: draft.id, issueNumber: draft.issueNumber, repo: `${owner}/${repoName}` },
            'reaper: recovered stuck-APPROVED draft — no live comment, released claim to DRAFT',
          );
        } else {
          // CAS matched zero rows: a late approve / another tick already decided it.
          log.info(
            { draftId: draft.id },
            'reaper: stale draft no longer APPROVED at release transition (race) — no-op',
          );
        }
      }
    } catch (err) {
      // Safety net: any UNCAUGHT throw in the per-draft body — notably a write
      // failure (markIssueDraftPosted / releaseIssueDraftClaim) — is isolated
      // here so the batch always attempts every remaining stale draft.
      summary.skipped++;
      log.warn(
        { err, draftId: draft.id },
        'reaper: unexpected failure processing stale draft — skipping (no action)',
      );
    }
  }

  return summary;
}

/** Config for the periodic reaper interval (worker wiring). */
export interface ReaperScheduleConfig {
  db: Database;
  deps: ReaperDeps;
  /** Tick cadence in ms. */
  intervalMs: number;
  log: ReaperLogger;
}

/**
 * Start a self-non-overlapping setInterval that runs the reaper every
 * `intervalMs`. A `running` guard ensures a slow tick never overlaps itself
 * (a fresh tick that fires while one is in flight is skipped, not queued).
 * Returns a stop function that clears the interval (call it on graceful
 * shutdown). Errors inside a tick are caught + logged so the interval survives.
 */
export function startIssueDraftReaper(cfg: ReaperScheduleConfig): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      cfg.log.warn({}, 'reaper: previous tick still running — skipping this interval');
      return;
    }
    running = true;
    try {
      const summary = await reapStaleApprovedDrafts(cfg.db, cfg.deps);
      if (summary.scanned > 0) {
        cfg.log.info(summary, 'reaper: tick complete');
      }
    } catch (err) {
      cfg.log.error({ err }, 'reaper: tick failed');
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, cfg.intervalMs);

  return () => clearInterval(handle);
}
