# Proposal: PR-Native Read-Only Explanation

## Intent

GitHub App users need an explicit way to ask why code changed without turning the answer into another review. Add `/ghagga explain <question>` with truthful progress, immutable target identity, and replay-safe publication while preserving the established review experience.

## Scope Decision

**Selective.** Ship the smallest evaluable GitHub App slice: explanation, identity, idempotency, and progress are inseparable trust requirements; conversational state, mutation, and simultaneous distribution rollout would obscure whether the read-only experience is valuable.

## Scope

### In Scope
- Accept explanations only from `OWNER`, `MEMBER`, or `COLLABORATOR`; leave review eligibility unchanged.
- Bind principal (forge instance/installation, stable actor identity) and target (repository, PR, requested head SHA); reject superseded requests.
- Produce finding-free answers, isolated monotonic progress, durable retry/republication idempotency, and explicit AI-unavailable outcomes.
- Launch behind a reversible GitHub App opt-in while preserving CLI, Action, GitLab, 1-click, and existing review behavior.

### Out of Scope
- Persistent transcripts, sandbox/tools, patches or mutation, skills, SDK/dependency migrations, live benchmarks, and broader UX rollout.

## Capabilities

### New Capabilities
- `pr-explanation`: Explicit question parsing, eligibility, immutable snapshot execution, finding-free results, and unavailable semantics.
- `invocation-replay`: Stable invocation claims and terminal-result replay across webhook delivery, queue retries, and publication retries.
- `pr-progress-publication`: Truthful monotonic progress and separate explanation/progress publication namespaces.

### Modified Capabilities
- `core-engine`: Expose provider/forge/runtime-neutral read-only intent, snapshot, progress, and explanation contracts without forge dependencies or review finalization.
- `server`: Route authorized explanation commands, preserve review authorization, and execute opt-in GitHub App orchestration.

## Approach

Introduce a typed intent envelope and a distinct explanation path over shared pure preparation/context primitives. Require a pinned snapshot before AI execution. Persist a stable invocation claim and terminal outcome, then project progress and answers through separate markers with idempotent upserts. Keep the current review path as the control and rollback path.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `packages/core` | Modified | Neutral contracts and finding-free execution seams |
| `packages/forge` | Modified | Principal/snapshot reads and isolated markers |
| `apps/server` | Modified | Parsing, policy, dispatch, progress, replay |
| `packages/db` | Modified | Durable invocation claim/result |

## Risks

| Risk | Mitigation |
|---|---|
| Stale or cross-principal answer | Verify full identities and requested SHA; reject mismatch |
| Duplicate cost/output | Claim once; replay terminal state; idempotent marker updates |
| Review contamination | Separate result/finalizer; no findings, verdict, coverage, or review-memory writes |
| False progress | Bounded monotonic states; explicit failure/unavailable terminal state |

## Rollback Plan

Disable the opt-in explanation route and workers; retain stored records for audit and leave review processing/publication untouched.

## Dependencies

- Existing forge adapters, BullMQ/Redis, database, and configured AI providers; no new libraries.

## Success Criteria

- [ ] Eligible users receive an answer only for the requested SHA; stale requests are rejected.
- [ ] Ineligible users and unavailable AI receive explicit non-answer outcomes without model fallback review.
- [ ] Retries cause no duplicate model execution, database result, or public output.
- [ ] Explanation/progress never overwrite the prior review and emit no review findings or memory.
- [ ] Opt-out restores unchanged review behavior across all distribution modes.
