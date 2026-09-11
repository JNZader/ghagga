# Exploration: GHAGGA PR-Native Read-Only Experience

## Exploration Scope

This exploration covers Phase 0 baseline reconciliation and the first independently releasable PR-native, read-only experience: explicit review/explanation intents plus truthful progress. GHAGGA remains the review engine. Sandboxes, progressive skills, immutable patches, mutation authority, and AI SDK migration are excluded. No live model or forge calls and no baseline suite were run during exploration.

## Current State

- **Baseline:** The worktree is on `feat/ghagga-pr-native-readonly` at `ddc7a02c7c6b6ee59dd2fa1ca3b72a2227ce2610`. The only observed pre-existing worktree entry is the untracked approved research document. This supersedes the research document's older local-checkout caveat for this worktree.
- **Invocation parsing:** `parseCommentCommand` recognizes a closed command set and maps `describe` to a simple review; its parsed value carries only `command` and `reviewMode`, so it cannot retain an explanation question (`apps/server/src/routes/webhook.ts:117-210`).
- **Authorization:** The PR-review gate admits owner, member, collaborator, contributor, first-timer, and first-time contributor associations, but does not distinguish explanation from review or bind an immutable actor identifier (`apps/server/src/routes/webhook.ts:87-106`, `apps/server/src/routes/webhook.ts:533-610`, `packages/forge/src/types.ts:110-116`).
- **Invocation identity:** A fresh short random review identifier is generated for every accepted comment. PR details, including `headSha`, are fetched best-effort and processing continues when that fetch fails (`apps/server/src/routes/webhook.ts:613-614`, `apps/server/src/routes/webhook.ts:624-750`).
- **Repository identity:** `RepoRef` combines forge kind and forge-native identity but does not identify a forge installation/instance; `Actor` exposes login and kind only (`packages/forge/src/types.ts:66-116`). Core must remain distribution-agnostic under the existing core-engine specification.
- **Snapshot acquisition:** The worker fetches diff, commits, and file list as separate current-PR reads, while `fetchDiff` accepts only a change reference and returns text without base/head proof (`apps/server/src/queues/review.ts:598-606`, `packages/forge/src/adapters/github/github-forge-adapter.ts:149-167`). The event's optional `headSha` therefore does not prove that all gathered inputs describe one immutable snapshot.
- **Pipeline semantics:** The review pipeline is a review-specific prepare/gather/execute/enrich/finalize sequence. Finalization can persist review observations and attaches coverage semantics to review results (`packages/core/src/pipeline.ts:38-65`, `packages/core/src/pipeline/finalize.ts:29-63`). Treating explanation as a review-mode alias would risk findings, verdict, persistence, and coverage semantics leaking into a finding-free answer.
- **Progress:** Core already accepts a synchronous `onProgress` callback with open-ended string steps, but the server's `ReviewInput` does not wire it. Worker progress is currently coarse queue percentages and logs (`packages/core/src/types.ts:64-79`, `packages/core/src/types.ts:131-135`, `apps/server/src/queues/review.ts:906-947`).
- **Replay and publication:** Queue jobs use the fresh review ID, allow three attempts, and save a new database review before postback. `saveReview` is an insert without an invocation uniqueness key (`apps/server/src/queues/review.ts:330-340`, `apps/server/src/queues/review.ts:949-975`, `apps/server/src/queues/review.ts:1081-1086`, `packages/db/src/queries.ts:328-344`). GitHub summary upsert uses the fixed `<!-- ghagga-review -->` marker even when a different marker is supplied, so explanation/progress publication cannot safely share this channel (`packages/forge/src/adapters/github/github-forge-adapter.ts:215-286`).
- **Existing coverage:** Direct test seams already exist for comment parsing/authentication, webhook dispatch, queue baseline and auth retry, core pipeline progress/degradation, and database integration. Relevant files include `apps/server/src/routes/webhook.test.ts`, `apps/server/src/routes/webhook.baseline.test.ts`, `apps/server/src/__integration__/webhook-dispatch.integration.test.ts`, `apps/server/src/queues/review.baseline.test.ts`, `apps/server/src/queues/review.auth-retry.test.ts`, `packages/core/src/pipeline.test.ts`, and `packages/db/src/__integration__/queries.integration.test.ts`.

## Affected Areas

- `packages/core/src/types.ts` — typed intent, explanation result, bounded progress event, and immutable invocation/snapshot contracts.
- `packages/core/src/pipeline.ts` and `packages/core/src/pipeline/*` — reusable read-only preparation/context seams; the existing review finalizer must not be the explanation finalizer.
- `packages/forge/src/types.ts` and `packages/forge/src/ports/forge-adapter.ts` — stable forge/repository/actor/change identity and snapshot-aware read contracts without importing forge concepts into core.
- `packages/forge/src/adapters/github/github-forge-adapter.ts` — GitHub implementation of pinned snapshot reads and isolated publication markers.
- `apps/server/src/routes/webhook.ts` — explicit intent parsing, question capture, eligibility checks, invocation-key derivation, and dispatch.
- `apps/server/src/queues/review.ts` — current review control path, progress projection, retry behavior, and the seam from webhook identity to execution.
- `packages/db/src/queries.ts` and review schema/migrations — durable invocation claim/result replay rather than insert-only duplicate work.
- Existing webhook, queue, pipeline, forge-adapter, and database integration tests — behavior-first coverage for parsing, authorization, snapshot mismatch, replay, finding-free results, and publication isolation.

## Approaches

| Approach | Pros | Cons | Effort |
|---|---|---|---|
| **A. Extend review modes (`describe` as review alias)** | Smallest apparent change; reuses current queue and formatter | Cannot carry a question today; mixes answer semantics with findings/verdict/coverage/memory; inherits mutable fetches, retries, duplicate persistence, and marker collision | Medium initially, high remediation risk |
| **B. Typed intent envelope with a separate explanation path over shared read-only primitives** | Preserves the existing review control path; makes finding-free behavior explicit; supports immutable identity, replay, and truthful progress; reversible by intent/wiring flag | Requires new contracts and carefully extracted shared preparation/context seams; cross-package coordination | Medium-high, divisible into narrow slices |
| **C. New monolithic conversational PR subsystem** | Maximum UX freedom and transcript support | Duplicates engine/policy behavior, expands scope across surfaces, increases security and rollback risk, and conflicts with the approved first read-only slice | High |

### Recommended Reversible Slice Sequence

| Slice | Purpose | Estimated authored change |
|---|---|---:|
| 1. Pure intent and explanation-result contracts | Define read-only behavior without server or forge side effects | 150-250 lines |
| 2. Parsing and invocation identity | Capture an explicit question and derive a stable target/invoker identity | 250-380 lines |
| 3. Immutable snapshot read contract | Ensure diff/context are bound to the requested PR revision | 250-400 lines |
| 4. Durable replay claim/result | Deduplicate retries and replay the same terminal outcome | 250-400 lines |
| 5. Finding-free explanation service | Reuse safe preparation/context primitives without review finalization | 250-400 lines |
| 6. Pure progress reducer | Map internal stages to monotonic, truthful public states | 180-300 lines |
| 7. Isolated progress/explanation publication | Use distinct markers/channels so review summaries cannot collide | 250-400 lines |
| 8. Opt-in server wiring | Connect the first approved surface while retaining the old review path as control | 250-400 lines |

These are exploration estimates, not a promise that a delivery unit stays below the 400-line review budget. Task planning must measure coupling and choose PR boundaries.

## Recommendation

Choose **Approach B** after the pending product decisions are confirmed. Preserve `/ghagga review` as the control path and introduce a typed, read-only intent envelope whose identity is stable across webhook redelivery and queue retries. Acquire or reject an immutable PR snapshot before model execution; do not answer from a silently newer diff. Build explanation as a distinct finding-free result path that may reuse pure parsing, token-budget, and context-gathering primitives but cannot invoke review finalization or review-memory persistence.

Model public progress as a pure monotonic reducer first, then project it through an isolated, intent-specific publication marker. Persist an invocation claim and terminal result before allowing retries to recompute or repost. Make the first surface opt-in and reversible; broader distribution parity should be planned only after the GitHub App/read-only experience is evaluated, if GitHub App is the confirmed launch surface.

## Constraints and Coupling

- Core cannot import the forge package; identity and snapshot data must cross a neutral input contract.
- A webhook-provided SHA alone is insufficient while diff/commits/files are fetched independently from the moving PR.
- Review status and `coverageComplete` are orthogonal and must remain truthful; explanation needs its own completion/degradation semantics.
- Synchronous core callbacks cannot directly perform unreliable network publication; server-side progress handling needs buffering/coalescing and idempotent projection.
- Queue retries span compute, persistence, and postback. Deduplication limited to GitHub comments would still permit duplicate model cost and database rows.
- Separate marker namespaces are required before review, explanation, and progress can coexist on one PR.
- Existing OpenSpec rules require future planning to consider all four distribution modes, but the first launch surface is itself an unresolved product decision.

## Pending Product Decisions

The following decisions are **unconfirmed** and must be resolved by the orchestrator/user before proposal. This exploration does not select defaults:

1. Explicit `/ghagga explain <question>` versus transcript-derived conversational intent.
2. Eligible associations and whether contributors may invoke only on their own PRs.
3. Reject stale targets versus answer from an explicitly identified historical snapshot.
4. Separate explanation/progress outputs versus one evolving shared summary.
5. Behavior when AI is disabled or every provider is unavailable.
6. GitHub App first versus simultaneous multi-surface launch.

## Risks

- **Authorization/cost risk:** the current lenient review gate may be inappropriate for arbitrary explanation questions, especially without PR-ownership checks or immutable actor identity.
- **Snapshot race:** answering after the PR changes can misattribute an explanation to the requested revision.
- **Duplicate side effects and cost:** random invocation IDs plus whole-job retries can recompute and persist the same logical request.
- **Semantic contamination:** reusing the whole review pipeline can emit findings, review memory, or verdict-shaped output for an explanation.
- **Publication collision:** the fixed review marker can overwrite or prune unrelated progress/explanation content.
- **False progress:** queue percentages and successful activity do not establish coverage or a terminal answer.
- **Scope expansion:** transcript state, sandbox tools, patches, mutation, skills, and SDK migration would make the first slice difficult to evaluate or roll back.
- **Unmeasured baseline:** no tests, live providers, forge calls, review-quality benchmark, latency measurement, or cost baseline were executed in this exploration.

## Ready for Proposal

**No.** The architecture is sufficiently mapped and Approach B is recommended, but the six product decisions above remain unresolved. The orchestrator should present them as one complete decision envelope, optionally offer source-backed `sdd-research` immediately after exploration, and invoke `sdd-propose` only after the selected research is complete (or declined) and all decisions are confirmed.
