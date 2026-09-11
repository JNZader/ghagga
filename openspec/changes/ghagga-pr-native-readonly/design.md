# Design: PR-Native Read-Only Explanation

## Technical Approach

Add a GitHub-App-only explanation path beside review orchestration. The webhook validates command, principal, authorization, head, and opt-in before reservation. A BullMQ worker consumes an immutable snapshot through neutral core contracts and one fixed provider/model. Generation and publication never enter review state.

## Architecture Decisions

| Decision | Choice and rationale | Rejected alternative |
|---|---|---|
| Isolation | New explanation contracts reuse only pure reads and GenerateTextFn, making findings, verdict, coverage, finalization, and review memory unrepresentable. | Adapting reviewPipeline or ReviewResult leaks review semantics. |
| Snapshot | ExplanationSnapshot contains immutable repository ID, base SHA, requested head SHA, and acquired diff/file contents. A revision-pinned forge seam, implemented by GitHub client/adapter and called by the server, acquires every byte for that head. Missing, mismatched, or unprovable content returns STALE/INVALID. | Live PR-number reads plus surrounding SHA checks have a time-of-check/time-of-use gap and are forbidden; no fallback. |
| Identity | SHA-256 key covers forge instance, installation, actor ID, repository ID, PR, requested SHA, source comment ID, and exact question hash. One non-partial unique index covers every status; identity is insert-only. | Random IDs or partial uniqueness allow duplicate/cross-principal work. |
| Dispatch | Commit fenced CAS to DISPATCH_RESERVED before model I/O. Crash, lost result, expired lease, or uncertain commit becomes AMBIGUOUS; never redispatch, and reject late writes. | PostgreSQL and Redis are not atomic; a network-spanning transaction is unsafe. |
| Provider | Resolve one explicit backend/model. Gateway makes one application POST; Ollama sets maxRetries: 0. Both have bounded aborts and no tools, repair, fallback, or switching. CLI bridge, auto, and unsupported targets return AI_UNAVAILABLE; hidden downstream retries remain uncontrolled. | Existing fallback loops violate fixed-target execution. |
| Publication | Invocation-specific progress/answer markers, expected numeric bot author ID, persisted IDs, versions, and non-reusable fences. Persist CREATE_STARTED before POST. Unknown POST/PATCH suppresses writes. Reconcile only exact marker, channel, invocation, and owner; found/absent/incomplete lookup never makes absence recreation authority. | Review upsert has a shared marker, no author check, and bounded scans. |

## Data Flow

    issue_comment -> parse/auth/opt-in/head -> pinned snapshot -> insert-or-observe
      -> BullMQ -> reload opt-in/auth/head -> CAS reserve -> one model call
      -> immutable outcome -> guarded progress/answer projection

The worker reloads effective inherited opt-in immediately before dispatch; disabled terminates DISABLED without model call or public output. Acquisition, execution, and publication compare the requested SHA. Supersession permits no new write; prior valid progress may remain. Duplicates observe or replay.

## File Changes

| Files | Action |
|---|---|
| packages/core/src/explanation.ts, providers/explanation-generate-fn.ts, index.ts | Add flat const-derived request, snapshot, outcome, executor, and provider contracts. |
| packages/db/src/schema.ts, queries.ts, drizzle/0003_*.sql, drizzle/meta/0003_snapshot.json, _journal.json | Add invocation table, full uniqueness, immutable outcome, and fenced CAS; append history. |
| packages/forge/src/ports/forge-adapter.ts, adapters/github/github-client-port.ts, github-forge-adapter.ts, index.ts | Add optional revision-pinned snapshot/publication capability and owner-aware tri-state lookup; review upsert unchanged. |
| apps/server/src/routes/webhook.ts, github/client.ts, github/forge-adapter-factory.ts | Parse, capture stable actor, acquire pinned content, and wire GitHub APIs. |
| apps/server/src/queues/explanation.ts, github/explanation-marker.ts, index.ts | Add isolated queue/worker, guard reload, markers, and publisher. |
| Adjacent *.test.ts and packages/db/src/__integration__/*.test.ts | Add RED-first deterministic and real-PostgreSQL coverage. |

RepoSettings.explanationsEnabled is optional, inherited at installation/repository level, and defaults false. Review eligibility is unchanged.

## Interfaces / Contracts

ExplanationRequest holds immutable principal, target, request, question, and hash. ExplanationSnapshot holds repo ID, base/head SHAs, unified diff, and revision-pinned file payloads; completeness is validated before GenerateTextFn. ExplanationOutcome uses const-derived ANSWERED, INVALID, UNAUTHORIZED, DISABLED, STALE, AI_UNAVAILABLE, and AMBIGUOUS. Generation outcome is immutable and separate from progress and per-channel publication state/version/ID. Missing identity creates neither invocation nor output.

## Testing Strategy

Strict TDD starts with mocked Vitest unit tests in core/forge/server for parsing, snapshot rejection, prompt-as-data, opt-in reload, stale checks, unavailable isolation, scans, ambiguous POST/PATCH, monotonic versions, and unchanged distributions. Database unit tests mock queries only. Real migration, non-partial uniqueness, concurrent claim races, uncertain transitions, and fence rejection belong in packages/db/src/__integration__ using its PostgreSQL harness. Run only after database readiness and authorization; otherwise report SQL concurrency unproven. No live forge/model calls.

## Threat Matrix

| Boundary | Applicability and RED behavior |
|---|---|
| Documentation-like paths | N/A: no executable classification. |
| Git repository selection | N/A: no git/cwd selection. |
| Commit state | N/A: no index/worktree operation. |
| Push state | N/A: no push/ref resolution. |
| PR commands | Applicable: --head, environment-prefix, and composed-command strings remain question data. RED tests prove no process execution, no review-marker match, typed ref ownership, and mismatch rejection. |

## Migration / Rollout

Deploy appended migration, then code with opt-in false. Enable selected GitHub App installations/repositories and monitor ambiguity, stale, and duplicate counters. Roll back by disabling opt-in/worker; retain audit rows. CLI, Action, GitLab, 1-click, and reviews remain unchanged.

## Open Questions

None.
