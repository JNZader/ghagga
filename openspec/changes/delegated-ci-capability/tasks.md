# Tasks: Delegated CI Capability

## Phase 1: Database & Core Types (Foundation)

- [ ] 1.1 Update `packages/db/src/schema.ts` to add `delegatedCiPolicy` JSONB field to `repositories` table.
- [ ] 1.2 Update `packages/db/src/schema.ts` to create the new `delegated_ci_runs` table with state, correlation IDs, and timings.
- [ ] 1.3 Add CRUD and query helpers in `packages/db/src/queries.ts` for reading/writing `delegatedCiPolicy` and `delegated_ci_runs`.
- [ ] 1.4 Add shared runtime types (`DelegatedCiJobPolicy`, `DelegatedCiClassification`, `DelegatedCiRunState`) to a new file `packages/types/src/delegated-ci.ts` and re-export from `packages/types/src/index.ts`.
- [ ] 1.5 Add API request/response contracts for delegated CI settings to `packages/types/src/api.ts`.
- [ ] 1.6 Generate Drizzle migration for the new `delegatedCiPolicy` column and `delegated_ci_runs` table using `pnpm drizzle-kit generate`.

## Phase 2: Validations & Guardrails (Policy Evaluator)

- [ ] 2.1 Create `apps/server/src/delegated-ci/profiles.ts` to define the registry of supported MVP curated execution profiles (e.g., `node-lint`, `node-unit`).
- [ ] 2.2 Create `apps/server/src/delegated-ci/policy.ts` to normalize policy, default to `sensitive/no-delegable`, and validate MVP guardrails (no secrets, safe artifacts).
- [ ] 2.3 Write pure-function unit tests in `apps/server/src/delegated-ci/policy.test.ts` to verify classification mapping and rejection reasons.

## Phase 3: Runner Template (Execution Surface)

- [ ] 3.1 Create `templates/ghagga-delegated-ci.yml` dedicated to executing delegated CI jobs. Use the JSON config input packing strategy: security-critical inputs (`callbackUrl`, `callbackSecret`, `token`, `repoFullName`, `headSha`, `baseBranch`) as separate `workflow_dispatch` inputs, and remaining CI-specific inputs (`jobKey`, `profile`, `allowArtifacts`, `allowCache`, `maxDurationMinutes`, `prNumber`) packed into a single `config` JSON input parsed via `fromJSON()`.
- [ ] 3.2 Add explicit security guardrails to `ghagga-delegated-ci.yml`: suppress logs, block arbitrary artifact uploads, and mask sensitive values (repo names, tokens).
- [ ] 3.3 Ensure `ghagga-delegated-ci.yml` implements the callback integration (start and final state) with HMAC verification.

## Phase 4: Orchestrator & Runner Dispatch (Execution Engine)

- [ ] 4.1 Refactor `apps/server/src/github/runner.ts` to use a generic `RunnerWorkflowDescriptor` interface, separating static analysis from delegated CI.
- [ ] 4.2 Update `apps/server/src/github/runner.ts` to handle dynamic workflow injection for `ghagga-delegated-ci.yml` alongside the existing `ghagga-analysis.yml`.
- [ ] 4.3 Add unit tests in `apps/server/src/github/runner.test.ts` for building the delegated CI dispatch descriptor with correctly provisioned ephemeral secrets.

## Phase 5: Inngest & Lifecycle (Async Workflows)

- [ ] 5.1 Add delegated CI event schemas (`ghagga/delegated-ci.requested`) to `apps/server/src/inngest/client.ts`.
- [ ] 5.2 Create new Inngest workflow in `apps/server/src/inngest/delegated-ci.ts` to manage the delegated run lifecycle (create record, dispatch, wait for callback, timeout handling).
- [ ] 5.3 Modify `apps/server/src/routes/runner-callback.ts` to parse `executionKind` and emit separate Inngest events by execution kind: `ghagga/runner.callback` for `static-analysis` (unchanged), `ghagga/delegated-ci.callback` for `delegated-ci`. The delegated CI Inngest function resumes via `step.waitForEvent("ghagga/delegated-ci.callback", { match: "data.callbackId" })`.
- [ ] 5.4 Update `apps/server/src/routes/webhook.ts` (or create a dedicated trigger route) to evaluate PR events against the Delegated CI policy and trigger the Inngest workflow if approved.

## Phase 6: API & Dashboard UX (Control Plane & UI)

- [ ] 6.1 Update `apps/server/src/routes/api/settings.ts` to support reading and mutating the repo-only `delegatedCiPolicy`.
- [ ] 6.2 Create `apps/server/src/routes/api/delegated-ci.ts` to expose read-only run history, rejection reasons, and status to the dashboard.
- [ ] 6.3 Update `apps/dashboard/src/lib/types.ts` and `apps/dashboard/src/lib/api.ts` to consume the new delegated CI API endpoints and types.
- [ ] 6.4 Update `apps/dashboard/src/pages/Settings.tsx` to add UI controls for opting in, configuring jobs, and selecting curated profiles per repository.
- [ ] 6.5 Add a new dashboard UI component or table (e.g., in a run history view) to display the status and outcomes of recent `delegated_ci_runs` for the repository.

## Phase 7: Documentation

- [ ] 7.1 Update `docs/runner-architecture.md` to document the delegated CI execution kind, the template split between `ghagga-analysis.yml` and `ghagga-delegated-ci.yml`, and the `RunnerWorkflowDescriptor` abstraction.
- [ ] 7.2 Update `docs/security.md` to document delegated CI safety boundaries, the MVP non-goals, and the guardrails for logs, artifacts, cache, tokens, and secrets.