# Proposal: Delegated CI

## Intent

GHAGGA already uses a delegated runner pattern to execute static analysis for private repositories through a user-owned public runner repository. That pattern solves a real platform constraint: GHAGGA can orchestrate work for private repos without moving all execution into GHAGGA's own runtime or requiring every repository to self-host the full workflow.

The next problem is broader than static analysis. Some repositories have CI jobs that are operationally safe to delegate, but GHAGGA currently has no first-class capability to classify, route, and secure those jobs through the same runner/orchestrator model. This leaves teams with an all-or-nothing choice between keeping all CI local to each private repo or inventing ad hoc delegation patterns outside GHAGGA.

This change proposes a new GHAGGA capability: **Delegated CI**. GHAGGA becomes the platform-level orchestrator for repository-specific CI delegation, but only for jobs that are explicitly classified as `safe/delegable`. Sensitive workflows remain local and non-delegable by design. The goal is not to migrate all CI into GHAGGA. The goal is to create a secure, explicit, repo-by-repo mechanism for delegating a limited subset of low-risk CI work using the technical patterns GHAGGA already established for delegated static analysis.

## Scope

### In Scope

- Define the product and platform concept of **Delegated CI** as a GHAGGA-managed capability for private repositories.
- Introduce a job classification model that distinguishes `safe/delegable` jobs from `sensitive/no delegable` jobs.
- Establish repo-by-repo configuration as the control plane for enabling, disabling, and constraining delegated CI.
- Reuse and extend the existing delegated runner/orchestrator pattern instead of designing a parallel execution architecture.
- Define the MVP security posture for delegated execution, with explicit emphasis on log safety, artifact safety, cache safety, token handling, and secret isolation.
- Bound the MVP to low-risk CI use cases such as validation, linting, tests, and other non-production, non-deployment jobs that can safely run outside the private repo's native CI context.

### Out of Scope

- Universal migration of all repository CI to GHAGGA-managed execution.
- Production deployments, release publishing, infrastructure changes, or any workflow that changes external state in a high-risk way.
- Delegation of jobs that require sensitive long-lived credentials, privileged cloud access, signing keys, or production secrets.
- Automatic job classification without explicit repository-owner configuration and review.
- A promise that every existing GitHub Actions workflow can be delegated unchanged.
- Cross-repository shared secrets, broad token fan-out, or any model that weakens the current delegated runner security assumptions.

## Approach

The proposal extends GHAGGA's existing delegated runner architecture into a more general delegated execution capability while preserving the same core separation of responsibilities:

- GHAGGA remains the **platform/orchestrator** that decides whether a repository is eligible, which jobs are delegable, how execution is configured, and how results are correlated back into GHAGGA.
- The public runner repository remains a **controlled execution surface** for approved delegated work.
- Private repositories remain the **source of truth** for code and for all jobs that are classified as sensitive or non-delegable.

The MVP should be shaped around an explicit trust model rather than convenience. Delegation is only allowed when a repository configuration marks a job as `safe/delegable` and the execution contract proves that the job does not require sensitive secrets, privileged environment access, or high-risk side effects.

At a high level, GHAGGA would:

1. Allow per-repository configuration of eligible delegated CI jobs.
2. Validate that a requested job belongs to the `safe/delegable` class.
3. Dispatch that job through the existing runner/orchestrator pattern.
4. Apply stronger security controls around logs, artifacts, caches, callback payloads, tokens, and secrets than generic CI defaults provide.
5. Refuse delegation for jobs that are sensitive, ambiguous, or violate the MVP safety contract.

This proposal intentionally preserves compatibility with GHAGGA's four distribution modes:

- **SaaS**: primary target for delegated CI orchestration.
- **Action**: no delegated-CI migration required for the MVP; native repo execution remains valid.
- **CLI**: unchanged; local workflows remain local.
- **1-click deploy / self-hosted**: may adopt the capability later, but the MVP should not depend on self-hosted parity.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/server/` | Modified | Extend server-side orchestration, repository settings evaluation, dispatch, callback correlation, and policy enforcement for delegated CI jobs. |
| `apps/dashboard/` | Modified | Add repository-level configuration surfaces for delegated CI enablement, job classification, and safety constraints. |
| `packages/core/` | Modified | Reuse or extend execution/result types so delegated CI results and status can be modeled consistently with existing runner patterns. |
| `templates/ghagga-analysis.yml` or successor runner workflow template(s) | Modified/New | Evolve the runner workflow template to support delegated CI execution contracts beyond static analysis. |
| `docs/runner-architecture.md` | Modified | Document how delegated CI builds on the current runner model and where the new safety boundaries apply. |
| `docs/security.md` | Modified | Define security guarantees and limitations for delegated CI logs, artifacts, caches, tokens, and secrets. |
| `.github/workflows/` | Possibly modified | Internal GHAGGA workflows or validation jobs may need updates if the capability introduces new templates or contract checks. |
| `apps/action/`, `apps/cli/` | Unchanged for MVP | Existing local/native execution modes remain supported and are not migrated by this proposal. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Misclassifying a sensitive job as delegable | Medium | Require explicit per-repo classification, conservative defaults, and policy validation before dispatch. |
| Private data leakage through logs, artifacts, or caches in the public runner repo | Medium | Treat logs/artifacts/caches as first-class security surfaces; minimize output, redact aggressively, constrain retention, and define safe artifact rules. |
| Delegated jobs implicitly depending on secrets or privileged environment state | High | MVP allows only jobs that can run with tightly scoped ephemeral credentials or no sensitive secrets at all. |
| Scope creep into full CI replacement | High | Keep proposal language, spec boundaries, and success criteria focused on limited `safe/delegable` workloads only. |
| Existing runner architecture not being sufficient for more general CI orchestration | Medium | Reuse the current pattern as the baseline, but validate the abstraction and expand only where the MVP proves the model. |
| User confusion about what GHAGGA will and will not delegate | Medium | Make classification explicit in docs and configuration UI, with clear examples of allowed vs blocked jobs. |

## Rollback Plan

This change should be rolled out behind configuration and capability checks so rollback is primarily a control-plane action rather than a destructive migration.

1. Disable Delegated CI at the platform or repository level.
2. Stop dispatching delegated CI jobs while preserving the existing delegated static-analysis path.
3. Revert any runner template additions specific to delegated CI.
4. Keep repositories on their native CI for all jobs until the capability is redesigned.

Rollback should not require data migration. The safe fallback is to keep GHAGGA as observer/orchestrator only and let all CI continue in the repository's native workflows.

## Dependencies

- The existing delegated runner/orchestrator architecture in GHAGGA, including dispatch, callback, and security controls.
- Repository-level settings/configuration support in GHAGGA so delegation can be enabled and constrained per repo.
- A clear security model for ephemeral tokens, callback signing, artifact retention, and cache isolation.
- Future spec/design work to define the exact execution contract for delegable jobs and the boundary between reusable runner templates and repo-specific configuration.

## Success Criteria

- [ ] GHAGGA defines a clear product capability for Delegated CI that extends the current delegated runner pattern without replacing all CI.
- [ ] The system defines and documents the job classes `safe/delegable` and `sensitive/no delegable` with enforceable intent.
- [ ] Repository owners can enable Delegated CI repo by repo rather than through a platform-wide mandatory migration.
- [ ] The MVP explicitly excludes production deploys, sensitive-secret jobs, and other high-risk executions.
- [ ] The proposal establishes security requirements for logs, artifacts, caches, tokens, and secrets as core design constraints rather than implementation details.
- [ ] The future spec/design can build directly from this proposal without reopening the basic platform decision to reuse the existing GHAGGA delegated runner architecture.

## Distribution Mode Impact

| Mode | Impact | Notes |
|------|--------|-------|
| **SaaS** | Major change | GHAGGA becomes the orchestrator for approved delegated CI jobs in private repos. |
| **Action** | No MVP change | Native GitHub Actions execution in the target repo remains the default for sensitive or non-delegable jobs. |
| **CLI** | No change | Local execution stays local; delegated CI is not a CLI concern in the MVP. |
| **1-click deploy / self-hosted** | Deferred | Capability should remain conceptually compatible, but MVP delivery can focus on SaaS first. |
