```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:016461ec9492f2e35cb675cd31247608c1065719b526da28ce3566d9fbf9d486
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 18/18
scenarios: 35/35
test_command: "/home/javier/programacion/ghagga-pr-native-readonly/apps/server/node_modules/.bin/vitest run --config /tmp/ghagga-unit4c-vitest-20260909.mjs src/github/explanation-marker.test.ts src/queues/explanation-publication.test.ts src/queues/explanation-publisher-factory.test.ts"
test_exit_code: 0
test_output_hash: sha256:09090f9f562e9bda9573a418518de70a4774c7b6b9bf634972ccfeee20b14c71
build_command: "/home/javier/programacion/ghagga-pr-native-readonly/apps/server/node_modules/.bin/tsc --project /tmp/ghagga-unit5-server-noemit.json --noEmit"
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: `ghagga-pr-native-readonly`
**Version**: N/A
**Mode**: Standard

### Completeness

| Metric | Value |
|---|---:|
| Tasks total | 16 |
| Tasks complete | 16 |
| Tasks incomplete | 0 |

All checklist items in `tasks.md` are checked: 1.1–1.3, 2.1–2.3, 3.1–3.3, 4.1–4.3, 4N, and 5.1–5.3.

### Build & Tests Execution

**Build/type check**: PASS. The permitted Unit 5 noEmit command completed with exit 0 and no diagnostics. The OpenSpec configuration does not define a separate build command; no package build was run.

**Tests**: PASS — 142 passed, 0 failed, 0 skipped in 3 files. The Vitest process reported exit 0. The outer output-capture wrapper subsequently failed while assigning the zsh read-only variable `status`; this did not alter the completed Vitest result and is disclosed rather than treated as a clean wrapper trajectory.

**Coverage**: Not configured; `coverage_threshold` is absent from `openspec/config.yaml`.

**Execution boundary**: Unit and integration evidence retained in `apply-progress.md` includes the completed Unit 1–5 scoped proofs. The final Unit 5 direct check was local and mocked; no live GitHub, Redis, database, model, or external HTTP operation was used.

### Task-to-Evidence Matrix

| Task | Status | Evidence |
|---|---|---|
| 1.1 | COMPLETE | Core contract tests cover neutral identity, inert question data, and finding-free outcomes. |
| 1.2 | COMPLETE | `packages/core/src/explanation.ts`, provider seam, and exports are implemented and type-checked. |
| 1.3 | COMPLETE | Existing review callers remain compatible; legacy review regression suites passed. |
| 2.1 | COMPLETE | Registration tests and PostgreSQL evidence cover identity, races, duplicates, settings, and isolation. |
| 2.2 | COMPLETE | Schema, migrations, full-identity uniqueness, immutable outcomes, and fenced CAS are present and tested. |
| 2.3 | COMPLETE | Append-only history and disposable PostgreSQL proof are recorded. |
| 3.1 | COMPLETE | Revision-pinned snapshot, repository binding, SHA, and tri-state rejection tests passed. |
| 3.2 | COMPLETE | Optional snapshot/publication forge seams and owner-aware delegates are implemented. |
| 3.3 | COMPLETE | No live PR read or process fallback is used; full forge regression passed. |
| 4.1 | COMPLETE | Route/worker contract tests cover explicit outcomes, lifecycle, and bootstrap behavior. |
| 4.2 | COMPLETE | Webhook routing, pinned acquisition, registration, enqueue ordering, and credential-free job data are verified. |
| 4.3 | COMPLETE | Queue guard tests cover reservation, revalidation, fixed provider selection, ambiguity, and no review fallback. |
| 4N | COMPLETE | Inactive persisted publisher composition and trusted projection guards are implemented and type-checked. |
| 5.1 | COMPLETE | Marker/publication tests cover channels, numeric ownership, unknown writes, versions, and stale handling. |
| 5.2 | COMPLETE | Exact-reference reconciliation and guarded CREATE/PATCH publication paths are verified. |
| 5.3 | COMPLETE | Review marker isolation, opt-out behavior, and rollback boundaries are verified. |

### Spec Compliance Matrix

| Requirement | Scenario | Test/evidence | Result |
|---|---|---|---|
| Core: neutral contract | Neutral caller | `packages/core/src/providers/explanation-generate-fn.test.ts` > provider metadata/data test | COMPLIANT |
| Core: neutral contract | Snapshot mismatch | Same file > rejects invalid or mismatched snapshots before calling a model | COMPLIANT |
| Core: finding-free boundary | Successful explanation | Same file > treats question, diff, and files as data and returns provider metadata exactly once | COMPLIANT |
| Core: finding-free boundary | Provider unavailable | Same file > unavailable provider configuration and empty provider answer cases | COMPLIANT |
| Core: review compatibility | Existing review caller | Ten-suite regression including `apps/server/src/queues/review.test.ts` and webhook review tests | COMPLIANT |
| Replay: stable claim | First delivery | `apps/server/src/routes/webhook.test.ts` > accepts an eligible explanation with a pinned snapshot before registration and enqueue | COMPLIANT |
| Replay: stable claim | Duplicate delivery | `packages/db/src/queries.test.ts` > registers only a pending row and observes an exact duplicate without a second insert | COMPLIANT |
| Replay: stable claim | Reservation precedes dispatch | `packages/db/src/__integration__/explanation-invocation.integration.test.ts` > commits exactly one reservation and releases a rollback contender | COMPLIANT |
| Replay: terminal outcome | Retry after completed answer | `packages/db/src/queries.test.ts` > replays a complete immutable terminal observation | COMPLIANT |
| Replay: terminal outcome | Crash or ambiguity | `apps/server/src/queues/explanation.test.ts` > generation ambiguity and settled ambiguity replay cases | COMPLIANT |
| Replay: identity/stale protection | Identity mismatch on retry | `packages/db/src/queries.test.ts` > stable SHA-256 key and every immutable identity component | COMPLIANT |
| Replay: durable isolation | Explanation result stored | PostgreSQL integration > leaves review and memory tables unchanged | COMPLIANT |
| Explanation: explicit result | Valid question | Webhook accepted explanation and core finding-free answer tests | COMPLIANT |
| Explanation: explicit result | Missing question | `apps/server/src/routes/webhook.test.ts` > rejects malformed explanation requests before external work | COMPLIANT |
| Explanation: explicit result | Prompt-like question is data | `packages/core/src/providers/explanation-generate-fn.test.ts` > treats question, diff, and files as data | COMPLIANT |
| Explanation: eligibility/identity | Unsupported or revoked actor | `apps/server/src/queues/explanation.test.ts` > does not answer when current authorization is uncertain; unauthorized matrix | COMPLIANT |
| Explanation: eligibility/identity | Missing identity | Webhook malformed explanation request matrix and ingress identity validation | COMPLIANT |
| Explanation: stale revision | SHA changes at acquisition | `apps/server/src/routes/webhook.test.ts` > raw revision snapshot stale or invalid | COMPLIANT |
| Explanation: stale revision | SHA changes before execution | `apps/server/src/queues/explanation.test.ts` > observed/disabled/unauthorized/stale requests do not dispatch | COMPLIANT |
| Explanation: stale revision | SHA changes before publication | Publisher factory stale-head guard and publication stale-result tests | COMPLIANT |
| Explanation: unavailable isolation | Provider unavailable | `apps/server/src/queues/explanation.test.ts` > settles AI_UNAVAILABLE when no fixed provider is configured | COMPLIANT |
| Progress: monotonic truth | Normal progress | `apps/server/src/queues/explanation-publication.test.ts` > guarded progress CREATE before one post and settlement | COMPLIANT |
| Progress: monotonic truth | Terminal non-answer | Coordinator/worker tests for DISABLED, UNAUTHORIZED, STALE, AI_UNAVAILABLE, and AMBIGUOUS | COMPLIANT |
| Progress: separate namespaces | Existing review preserved | `apps/server/src/github/explanation-marker.test.ts` > does not share legacy review marker namespace; seeded-review PostgreSQL proof | COMPLIANT |
| Progress: separate namespaces | Finding and memory isolation | Core finding-free contracts and PostgreSQL review/memory isolation tests | COMPLIANT |
| Progress: idempotent publication | Publication retry | `apps/server/src/queues/explanation-publication.test.ts` > repeated guarded CREATE/PATCH and terminal duplicate cases | COMPLIANT |
| Progress: idempotent publication | Stale publication | Publication recheck/stale settlement tests and persisted STALE evidence | COMPLIANT |
| Progress: idempotent publication | Ambiguous comment publication | Same file > contains unknown post or settlement outcomes without retrying a create | COMPLIANT |
| Progress: distribution compatibility | Opt-out | `apps/server/src/routes/webhook.test.ts` > keeps explanations disabled by default without external work | COMPLIANT |
| Progress: distribution compatibility | Other distributions | Existing review/action/CLI/GitLab/1-click compatibility evidence and review regression suites | COMPLIANT |
| Server: authorized routing | Eligible opted-in command | `apps/server/src/routes/webhook.test.ts` > eligible explanation with pinned snapshot before registration and enqueue | COMPLIANT |
| Server: authorized routing | Unsupported/revoked/disabled request | Webhook disabled/invalid matrix plus current authorization and no-dispatch worker tests | COMPLIANT |
| Server: publication isolation | Retry-safe publication | `apps/server/src/queues/explanation-publication.test.ts` and publisher-factory tests | COMPLIANT |
| Server: publication isolation | Stale target at publication | Publisher factory current-head revalidation and stale publication result tests | COMPLIANT |
| Server: rollback compatibility | Opt-out rollback | Webhook opt-out tests plus unchanged review-path regression tests | COMPLIANT |

**Compliance summary**: 35/35 scenarios compliant.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| Neutral read-only contracts | IMPLEMENTED | Forge-neutral identity, snapshot, outcomes, and finding-free types in `packages/core/src/explanation.ts:8-78`. |
| Finding-free execution | IMPLEMENTED | Prompt-as-data and outcome construction in `packages/core/src/providers/explanation-generate-fn.ts:101-172`; no review fields are representable. |
| Stable invocation claim | IMPLEMENTED | Durable identity and full-identity uniqueness in `packages/db/src/schema.ts:338-443` and query APIs. |
| Terminal replay | IMPLEMENTED | Persisted outcome replay and ambiguity handling in `apps/server/src/queues/explanation.ts:328-513`. |
| Immutable snapshot | IMPLEMENTED | Revision-pinned client acquisition and fail-closed adapter seam. |
| Authorized routing | IMPLEMENTED | Explicit command, role, identity, opt-in, head, snapshot, registration, and enqueue guards in `apps/server/src/routes/webhook.ts:824-990`. |
| Fixed provider execution | IMPLEMENTED | One explicit provider/model selection, no fallback, Ollama `maxRetries: 0`, and bounded signal in `packages/core/src/providers/explanation-generate-fn.ts:45-99`. |
| Truthful worker lifecycle | IMPLEMENTED | Persistence reload, reservation-before-generation, terminal settlement, and optional publisher notification in `apps/server/src/queues/explanation.ts:328-513`. |
| Monotonic publication | IMPLEMENTED | Channel-specific reservation, version, fence, and recheck logic in `apps/server/src/queues/explanation-publication.ts:167-434`. |
| Owner-aware forge publication | IMPLEMENTED | Exact owner/reference validation and tri-state lookup in `apps/server/src/github/client.ts:642-868` and forge adapter ports. |
| Separate markers | IMPLEMENTED | Canonical channel-specific marker and body composition in `apps/server/src/github/explanation-marker.ts`. |
| Durable CREATE/PATCH state | IMPLEMENTED | Per-channel publication state and fenced CAS in DB queries/schema; Unit 4I/4J evidence passed. |
| Bot identity | IMPLEMENTED | Exact GitHub App Bot resolution with safe numeric ID in `apps/server/src/github/client.ts:1561-1650`. |
| Inactive publisher composition | IMPLEMENTED | Server-local trusted projection factory in `apps/server/src/queues/explanation-publisher-factory.ts:176-402`. |
| Review isolation | IMPLEMENTED | Existing review marker/upsert path is not reused by explanation publication. |
| Distribution compatibility | IMPLEMENTED | Explanation is opt-in/default-disabled; existing review routes and distributions remain on their prior paths. |
| Migration provenance | IMPLEMENTED | Additive 0003–0005 migrations and journal entries are present; no legacy backfill is claimed. |
| Error/uncertainty semantics | IMPLEMENTED | INVALID, UNAUTHORIZED, DISABLED, STALE, AI_UNAVAILABLE, and AMBIGUOUS remain distinct through persistence and publication. |

### Coherence (Design)

| Decision | Followed? | Evidence |
|---|---|---|
| Isolated explanation contracts | YES | Core path uses neutral data contracts and does not adapt `reviewPipeline`. |
| Revision-pinned snapshot | YES | GitHub client reads exact commits/trees/blobs and rejects mismatch; no PR-number fallback. |
| Full identity and insert-only claim | YES | Schema/query identity includes all specified components and full uniqueness. |
| Commit-fenced dispatch | YES | Reservation and settlement use fenced CAS; ambiguous states do not redispatch. |
| Fixed provider/model | YES | Only first explicit supported entry is resolved; no fallback or switching. |
| Separate owner-aware publication | YES | Progress/answer channels use dedicated markers, IDs, versions, fences, and exact owner checks. |

### Issues Found

**CRITICAL**: None.

**WARNING**:
1. Verification is offline/source-mapped or mocked at external boundaries. No live GitHub, Redis, database, model, or HTTP integration was run; the configured OpenSpec rules do not provide a runnable build command.
2. The first fresh test capture wrapper errored after the Vitest process completed because zsh rejected the variable name `status`; the successful Vitest output and exact output hash are retained, but the wrapper trajectory was not clean.
3. Other distribution compatibility is regression/static evidence, not a live end-to-end run of CLI, Action, GitLab, or 1-click deployments.

**SUGGESTION**: None.

### Verdict

**PASS WITH WARNINGS**

All 16 tasks and all 18 requirements are structurally satisfied, and all 35 specification scenarios have passing retained runtime evidence. Warnings are limited to deliberately unavailable live/external integration and one post-test capture-wrapper incident; no critical blocker remains.

## Post-Report Critical Remediation Update

The preceding verification report became stale before the manual 4R critical remediation was completed. The following evidence is intentionally scoped to that remediation and the source-aware publication tests; it is not a whole-change final PASS.

| Evidence | Result |
|---|---|
| Source-aware focused verification | `pnpm --filter @ghagga/server test -- --config /tmp/ghagga-unit4c-vitest-20260909.mjs src/queues/explanation-publication.test.ts` — exit 0; 122/122 passed. |
| Dedicated TypeScript verification | `/home/javier/programacion/ghagga-pr-native-readonly/apps/server/node_modules/.bin/tsc --project /tmp/ghagga-unit5-server-noemit.json --noEmit` — exit 0; no diagnostics. |
| Ordinary package test command | Not product evidence: it loads stale `ghagga-db/dist`, lacks `EXPLANATION_PUBLICATION_CREATE_OUTCOMES`, and caused 46 false failures. |
| Source-aware configuration | The focused configuration aliases `ghagga-core`, `ghagga-db`, and `ghagga-forge` to `packages/*/src/index.ts`. |

Manual 4R critical remediation is therefore supported by the two checks above within their declared scope. No commit, PR, delivery, RDD receipt, or whole-change final PASS is claimed.
