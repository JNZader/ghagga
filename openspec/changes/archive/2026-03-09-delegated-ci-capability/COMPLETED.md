# Completed: Delegated CI Capability

Date completed: 2026-03-09

## Pull Requests

- #62 -- Phase 1: Database schema and core types (delegatedCiPolicy JSONB, delegated_ci_runs table, shared types)
- #63 -- Phase 2: Policy evaluator and profiles registry with unit tests
- #64 -- Phase 3: Runner workflow template (ghagga-delegated-ci.yml) with security guardrails and callback integration
- #65 -- Phase 4: Runner dispatch refactor (RunnerWorkflowDescriptor abstraction, delegated CI dispatch support)
- #66 -- Phase 5: Inngest delegated CI orchestration, execution-kind-aware callback routing, webhook trigger integration
- #67 -- Phase 6: API endpoints and dashboard UI for delegated CI policy management and run history
- #68 -- Phase 7: Documentation updates for runner architecture and security boundaries
- #69 -- Drizzle migration for delegatedCiPolicy column and delegated_ci_runs table

## Summary

Added Delegated CI as a first-class GHAGGA capability that extends the existing delegated runner pattern to orchestrate low-risk CI jobs (linting, tests, validation) for private repositories through the public ghagga-runner repo.

Key deliverables:
- Repo-scoped opt-in policy model with explicit job classification (safe/delegable vs sensitive/no-delegable)
- Curated execution profiles with conservative MVP defaults (no secrets, no production deploys)
- Dedicated Inngest orchestration flow with full state tracking (approved, rejected, dispatched, running, completed, failed, timed_out)
- Separate runner workflow template (ghagga-delegated-ci.yml) with log suppression, artifact restrictions, and HMAC callback verification
- Dashboard UI for policy configuration and run history visibility
- Security guardrails for logs, artifacts, caches, and tokens
