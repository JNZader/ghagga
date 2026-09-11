# Tasks: PR-Native Read-Only Explanation

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~4,500–6,000 including full snapshot ≥1,027. Separate planning prerequisite: 903 lines plus design/tasks, excluded from Unit 1; overage pending (research alone: 427). |
| 400-line budget risk | High; coherent Unit 2B migration `size:exception` is approved; planning and PR4 scopes remain pending |
| Chained PRs recommended | Yes |
| Suggested split | PR1–PR5 follow Units 1–5; planning separate |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Units 1, 2A, 2H, 2B, 2C, 2D, and 3 are complete and were delivered with PR #383 on `main`. The historical no-services statement applies only to Units 1/2A; Unit 2H launched disposable PostgreSQL with existing journaled migrations, no custom FTS or production migrations. Units 4–5 are also complete in this task list. Live external rollout is unverified and is not claimed here. Single writer. Commands require installed dependencies; forge/server require current dependency exports.

### Units

| Unit | Order / estimate | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| 1 | Candidate: contracts/tests/exports (~180) | `pnpm --filter ghagga-core exec vitest run src/explanation.test.ts` | N/A: no external harness; pure-contract/data tests above | Core contracts/tests |
| 2 | Claim/result/migration (~1,200 plus snapshot ≥1,027); after 1 | `pnpm --filter ghagga-db exec vitest run src/queries.test.ts`; integration below | Authorized PostgreSQL race/CAS; unavailable = proof unproven | DB schema/query/migration |
| 3 | Forge seam (~250); after 2 | `pnpm --filter ghagga-forge exec vitest run src/adapters/github/github-forge-adapter.test.ts` | Mocked pinned snapshot/owner | Forge seam/adapter |
| 4 | Server route/worker/provider/bootstrap (~500); after 1–3 | `pnpm --filter @ghagga/server exec vitest run src/routes/webhook.test.ts src/queues/explanation.test.ts src/index.test.ts` | Mocked provider/worker | Server route/queue/bootstrap |
| 5 | Publication/compatibility (~350); after 4 | `pnpm --filter @ghagga/server exec vitest run src/github/explanation-marker.test.ts src/queues/explanation.test.ts src/routes/webhook.test.ts` | Mocked publication, unknown POST/PATCH | Markers/publisher |
DB integration: `pnpm --filter ghagga-db exec vitest run --config vitest.integration.config.ts src/__integration__/explanation-invocation.integration.test.ts`.

## 1. Core

- [x] 1.1 RED `packages/core/src/explanation.test.ts`: neutral/mismatch/success/unavailable/review; `--head`, environment-prefix, composed commands stay data; typed ref owner/mismatch; no execution/findings.
- [x] 1.2 GREEN new `packages/core/src/explanation.ts`, `packages/core/src/providers/explanation-generate-fn.ts`; modify `packages/core/src/index.ts`: const-derived identity/request/snapshot/outcome, source-comment key/hash; executor/provider deferred to Unit 4.
- [x] 1.3 REFACTOR: preserve review callers.

## 2. Persistence

- [x] 2.1 RED `packages/db/src/queries.test.ts`, `packages/db/src/__integration__/explanation-invocation.integration.test.ts`: race, duplicate/replay, reservation, ambiguity, identity/fence/isolation; omitted settings, inheritance, repository override.
- [x] 2.2 GREEN modify `packages/db/src/{schema.ts,queries.ts}`; add `packages/db/drizzle/{0003_*.sql,meta/0003_snapshot.json,meta/_journal.json}`: unique identity, immutable outcome, fenced CAS; optional `RepoSettings.explanationsEnabled`: installation/repository inheritance, default false.
- [x] 2.3 REFACTOR: append-only history and disposable PostgreSQL SQL proof completed.

## 3. Forge

- [x] 3.1 RED `packages/forge/src/adapters/github/github-forge-adapter.test.ts`: SHA-pinned repo/base/head/diff/files, typed ref ownership, mismatch/tri-state rejection.
- [x] 3.2 GREEN modify `packages/forge/src/{ports/forge-adapter.ts,adapters/github/github-client-port.ts,adapters/github/github-forge-adapter.ts,index.ts}`: pinned snapshot/owner-aware publication seams; review upsert unchanged.
- [x] 3.3 REFACTOR: no live PR reads or process execution.

## 4. Server

- [x] 4.1 RED `apps/server/src/{routes/webhook.test.ts,queues/explanation.test.ts,index.test.ts}`: parsing/eligibility/identity/stale/opt-out; dispatch-time settings reload; bootstrap lifecycle; unchanged distributions.
- [x] 4.2 GREEN modify `apps/server/src/{routes/webhook.ts,github/client.ts,github/forge-adapter-factory.ts,index.ts}`; add `apps/server/src/queues/explanation.ts`: acquire/ack/dispatch; settings default false.
- [x] 4.3 RED then GREEN `apps/server/src/queues/explanation.ts`: CAS before I/O; reload auth/opt-in/head; fixed provider/model one attempt maxRetries 0/no fallback; ambiguity suppresses redispatch/late writes; unavailable/disabled/stale.
- [x] 4N Runtime composition (bounded): inactive server-local persisted explanation publication factory, typed optional worker publisher injection, and fresh trusted publication projection guards.

## 5. Publication

- [x] 5.1 RED `apps/server/src/github/explanation-marker.test.ts`: monotonic/separate markers, numeric owner, create-started unknown POST/PATCH suppression, upsert/version/stale.
- [x] 5.2 GREEN new `apps/server/src/github/explanation-marker.ts`: guarded progress/answer channels; exact owner/invocation reconciliation.
- [x] 5.3 REFACTOR/tests: review markers unchanged; opt-out cancels without fallback; retain rollout/rollback documentation.
