# Design: Issue-Triage Agent (v3.1.0, additive)

**Status**: implemented (design followed 6/6 decisions at verify)  
**Proposal**: [proposal.md](./proposal.md)  
**Author**: javier  
**Date**: 2026-06-16  

> Mirrored from engram (`sdd/issue-triage-agent/design`, obs #5287).

## Technical Approach
Hybrid (explore Approach 3). Five additive pieces, PR path untouched: (1) webhook routes `/ghagga triage` on plain issues via a new branch in `handleIssueComment`; (2) a NEW `issue-triage` agent reusing diagnostic.ts's OUTPUT parser (`parseHypotheses`:73) but with an issue-specific system prompt + `wrapUntrustedDescription` input framing; (3) a separate `issue-analysis` BullMQ queue+worker that NEVER auto-posts (opposite of review.ts:826) — it persists a DRAFT; (4) a new keyword dedup query builder over issue title/body; (5) a net-new `issue_drafts` table + dashboard approval page that posts on approval via the EXISTING `postComment`. Gate is enforced server-side BEFORE any LLM call. HARD BLOCKER: ships only after server deploy + PRE-LAUNCH 🔐 list closed; buildable/testable locally now.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale (evidence) |
|---|----------|--------|----------|----------------------|
| 1 | Draft persistence | NEW `issue_drafts` table | Extend `reviews` w/ DRAFT status | `reviews` (schema.ts:141-162) is PR-centric: `prNumber` NOT NULL, `status` varchar(30) doc'd PASSED/FAILED/NEEDS_HUMAN_REVIEW/SKIPPED — no draft lifecycle, no issue cols, no approval audit. Muddying it risks the one shipped path. New table = clean issue semantics. |
| 2 | Issue agent | NEW `issue-triage.ts` reusing parser scaffold | Rewire `runDiagnosticReview` in place | diagnostic.ts:170 hardcodes "diagnostic analysis of the following code changes" + `wrapUntrustedDiff(diff)` (```diff fence). Feeding prose mislabels it as a diff & risks the PR path. `parseHypotheses`:73 is diff-agnostic → reuse OUTPUT only. |
| 3 | Queue | NEW `issue-analysis` queue+worker | Reuse `review` queue | review.ts `processReview` is hardwired: fetchPRDiff/runner dispatch/runner-callback wait + IMMEDIATE post (:826). No draft gate. Separate worker avoids regression + gives draft-not-post semantics. |
| 4 | Dedup | NEW title/body term query builder | Reuse `buildSearchQuery` (path-keyed) / embeddings | search.ts:76 keys off file-path segments; issues have NO paths. Reuse `storage.searchObservations(project, query, {limit})`. Embeddings deferred to 3.2. |
| 5 | Webhook routing | New non-PR branch in `handleIssueComment` (`issue_comment` event) | New `issues` labeled-event case | Scope locks command-gate only; label-gate→3.2. handleIssueComment:355 drops non-PR comments today → invert: route non-PR `/ghagga triage` here. Reuses `parseCommentCommand`:123 + `ALLOWED_ASSOCIATIONS`:77 + Bot-skip:360. |
| 6 | Issue-comment posting | Reuse `postComment` (client.ts:148) | New client method | `postComment` already hits `/repos/{o}/{r}/issues/{n}/comments` — identical endpoint for issues (issue#==arg). Only `issues:write` permission is new. |

## Data Flow
```
issue_comment(created) ──▶ webhook.ts handleIssueComment
   │ Bot-skip → parseCommentCommand('triage') → ALLOWED_ASSOCIATIONS → installation/repo lookup
   │ [SERVER GATE — all checks BEFORE any LLM call / enqueue]
   ▼
issue-analysis queue ──▶ worker stages:
   dedup(title+body keyword search) ──▶ hit≥threshold? ─yes─▶ DRAFT(type=DUPLICATE, links)
                                          └─no─▶ classify ──▶ needs-info? ─yes─▶ DRAFT(type=NEEDS_INFO)
                                                              └─no─▶ analyze(issue-triage agent,
                                                                     wrapUntrustedDescription) ──▶ DRAFT(type=ANALYSIS, cited)
   ▼
issue_drafts (status=DRAFT) ──▶ dashboard approval page
   edit → approve ──▶ postComment(issues API) + status=POSTED
                 └─ reject ──▶ status=REJECTED  (NEVER auto-posts)
```

## Data Model — `issue_drafts` (packages/db/src/schema.ts)
```
id            serial PK
repositoryId  integer FK repositories.id onDelete cascade, notNull
issueNumber   integer notNull
issueTitle    varchar(500) notNull
status        varchar(20) notNull  -- DRAFT | APPROVED | REJECTED | POSTED
draftKind     varchar(20) notNull  -- ANALYSIS | DUPLICATE | NEEDS_INFO
body          text notNull         -- editable markdown report (cited)
sources       jsonb $type<{title;type;ref}[]>  -- cited memory/dedup refs
dedupMatches  jsonb $type<{observationId;title;score}[]>
tokensUsed    integer default 0
postedCommentId  integer            -- set on POSTED
createdAt / updatedAt  timestamp defaultNow notNull
index(repositoryId), index(status), unique(repositoryId, issueNumber, status=DRAFT)  -- 1 open draft/issue
```
Lifecycle: worker inserts DRAFT → human edits `body` → APPROVED (transient) → postComment → POSTED (+postedCommentId); or → REJECTED. No backfill/migration (additive table).

## Contracts

### Agent — `runIssueTriage(input): IssueTriageResult` (packages/core/src/agents/issue-triage.ts)
```
input  { issueTitle; issueBody; labels: string[]; comments?: {author;body}[];
         memoryContext: string|null; provider; model; apiKey; onProgress? }
LLM    system = ISSUE_TRIAGE_SYSTEM (NEW, issue framing) [TRUSTED, outside fence]
       user   = "Analyze the following GitHub issue…" + wrapUntrustedDescription(title+body+comments)
       memoryContext via buildMemoryContext (already fenced)
output { rootCauseHypotheses: Hypothesis[]   (parseHypotheses reused)
         plan: string  (checkboxed markdown)
         filesToTouch: string[]
         sources: {title;type;ref}[]
         report: string  (assembled cited markdown body) }
```
Trusted scaffold (instructions, labels-as-data) stays OUTSIDE the `<USER_DESCRIPTION>` fence.

### Queue payload — `IssueAnalysisJobData`
```
{ installationId; repositoryId; repoFullName; issueNumber;
  issueTitle; issueBody; labels: string[]; triggerCommentId; reviewId(corr) }
```
Worker stages: dedup → (DUPLICATE) | classify → (NEEDS_INFO | analyze→ANALYSIS) → insert issue_drafts(DRAFT). Never calls postComment.

### Dedup query builder — `buildIssueSearchQuery(title, body): string`
Tokenize title+body, lowercase, strip stopwords/punctuation, dedupe, cap at MAX terms → `storage.searchObservations(project, query, {limit:5})`. Hit threshold: top match `strength`/score ≥ THRESHOLD (tune in apply; default conservative) → DUPLICATE draft listing matches; else continue. Never blocks on weak matches.

### Dashboard API (apps/server/src/routes/api/issue-drafts.ts, mounted in api/index.ts via `router.route('/')`; per-user repo scope via `c.get('user')` like reviews.ts:107)
```
GET    /api/issue-drafts?repo=&status=     list (scoped)
GET    /api/issue-drafts/:id               detail
PATCH  /api/issue-drafts/:id               edit body  → {body}
POST   /api/issue-drafts/:id/approve       → postComment + status=POSTED (auth + install token)
POST   /api/issue-drafts/:id/reject        → status=REJECTED
```
UI: NEW `apps/dashboard/src/pages/IssueTriage.tsx` — list (reuse `StatusBadge`,`Card`,`ConfirmDialog`) + detail w/ editable markdown + Approve/Reject; hooks in `lib/api.ts` mirroring `useReviews`/`useDeleteReview`.

## Prompt-Injection Mitigations (first-class, non-negotiable)
1. Issue title+body+comments → `wrapUntrustedDescription` (prompts.ts:442, defangs boundary tokens, NO inner fence). NEVER raw, NEVER via `wrapUntrustedDiff`.
2. Trusted system prompt + instructions + labels stay OUTSIDE the fence.
3. memoryContext fenced via `buildMemoryContext` (already untrusted-wrapped) + anti-priming instruction.
4. Server gate BEFORE enqueue/LLM: command match + `ALLOWED_ASSOCIATIONS` + Bot-skip + tracked-repo (token-cost + drive-by injection defense). Issues are openable by ANYONE → highest-risk channel.
5. Worker NEVER auto-posts — human approval is a hard gate.

## File Changes
| File | Action | Description |
|------|--------|-------------|
| `apps/server/src/routes/webhook.ts` | Modify | add `triage` to COMMAND_MODE_MAP + CommentCommand; invert :355 to route non-PR `/ghagga triage` → enqueue issue-analysis |
| `packages/core/src/agents/issue-triage.ts` | Create | NEW agent; reuses parseHypotheses; ISSUE_TRIAGE_SYSTEM + wrapUntrustedDescription |
| `packages/core/src/agents/prompts.ts` | Modify | add `ISSUE_TRIAGE_SYSTEM` constant |
| `packages/core/src/memory/search.ts` | Modify | add `buildIssueSearchQuery` + issue dedup entrypoint |
| `apps/server/src/queues/issue-analysis.ts` | Create | NEW queue + worker (dedup→classify→draft) |
| `packages/db/src/schema.ts` | Modify | add `issue_drafts` table |
| `apps/server/src/routes/api/issue-drafts.ts` | Create | list/detail/edit/approve/reject |
| `apps/server/src/routes/api/index.ts` | Modify | mount issue-drafts router |
| `apps/dashboard/src/pages/IssueTriage.tsx` | Create | approval UI |
| `apps/dashboard/src/lib/api.ts` | Modify | issue-draft hooks |
| GitHub App manifest | Modify | add `issues:write` (bundle into pre-launch consent) |

## Testing Strategy
| Layer | What | How |
|-------|------|-----|
| Unit | parseHypotheses reuse; buildIssueSearchQuery; wrapUntrustedDescription on injection probes; draft lifecycle transitions | vitest |
| Unit | webhook gate: non-allowed assoc / bot / non-command rejected BEFORE enqueue | mock queue, assert not enqueued |
| Integration | worker stages dedup→classify→draft; approve→postComment; never auto-post | mock storage + gh client |
| E2E (post-deploy) | `/ghagga triage` real issue → draft → approve → comment | deferred to staging |

## Migration / Rollout
Additive only. New table (no backfill), new queue/worker/agent/routes/UI all removable. Disable fully by reverting the `triage` command-map entry. `issues:write` ships with pre-launch deploy consent (no existing installs → no re-consent churn).

## Open Questions (resolved in apply)
- [x] Dedup hit THRESHOLD numeric value — set conservative default in apply, tune with real issues (not a design blocker).
- [x] Classification taxonomy (bug/feature/question/needs-info) — enumerated in apply (does not change architecture).
