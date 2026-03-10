# Delegated CI Specification

## Purpose

Delegated CI defines how GHAGGA orchestrates repository-specific CI jobs through the existing delegated runner pattern without turning GHAGGA into a full CI replacement. The capability applies only to jobs that are explicitly approved as safe to delegate on a per-repository basis. Sensitive or ambiguous jobs remain in the repository's native CI context.

---

## Requirements

### Requirement: Repository-Scoped Delegated CI Policy

The system MUST evaluate Delegated CI eligibility per repository. Delegated CI MUST be opt-in for each repository, and enabling it for one repository MUST NOT enable it for any other repository in the same installation.

Each repository policy MUST allow GHAGGA to determine:
- whether Delegated CI is enabled for that repository
- which named jobs are eligible for delegation
- the explicit classification of each configured job
- any repository-specific constraints required for the MVP safety contract

#### Scenario: Delegated CI enabled for one repository only

- GIVEN installation `acme` contains repositories `acme/api` and `acme/web`
- AND `acme/api` has Delegated CI enabled with job `unit-tests`
- AND `acme/web` does not have Delegated CI enabled
- WHEN GHAGGA evaluates a request to delegate `unit-tests` for both repositories
- THEN GHAGGA MUST treat `acme/api` as eligible for policy evaluation
- AND GHAGGA MUST treat `acme/web` as not eligible for delegated execution

#### Scenario: Repository policy constrains which jobs are delegable

- GIVEN repository `acme/api` has Delegated CI enabled
- AND its policy lists `unit-tests` and `lint` as configured jobs
- WHEN GHAGGA receives a request to delegate job `integration-tests`
- THEN GHAGGA MUST treat `integration-tests` as not approved for delegation for that repository
- AND GHAGGA MUST NOT dispatch that job through the delegated runner

### Requirement: Explicit Job Classification

The system MUST classify each configured Delegated CI job as exactly one of the following:
- `safe/delegable`
- `sensitive/no-delegable`

The system MUST NOT infer delegability from job names, workflow files, or historical behavior alone. A job MUST be considered delegable only when the repository policy explicitly marks it `safe/delegable`.

#### Scenario: Explicit safe classification allows policy evaluation to continue

- GIVEN repository `acme/api` has job `unit-tests` configured as `safe/delegable`
- WHEN GHAGGA evaluates a request to delegate `unit-tests`
- THEN GHAGGA MUST recognize `unit-tests` as eligible for delegated safety checks
- AND GHAGGA MAY proceed to dispatch validation for that job

#### Scenario: Sensitive classification blocks delegation

- GIVEN repository `acme/api` has job `release` configured as `sensitive/no-delegable`
- WHEN GHAGGA evaluates a request to delegate `release`
- THEN GHAGGA MUST reject delegated execution for that job
- AND GHAGGA MUST record that the rejection reason is the job classification

### Requirement: Conservative Default Behavior

The system MUST apply a conservative default. Any job that is missing configuration, missing classification, ambiguously classified, or outside the repository's approved job list MUST be treated as `sensitive/no-delegable`.

#### Scenario: Unclassified job defaults to non-delegable

- GIVEN repository `acme/api` has Delegated CI enabled
- AND job `smoke-tests` is present in the repository's native CI but has no Delegated CI classification
- WHEN GHAGGA evaluates a request to delegate `smoke-tests`
- THEN GHAGGA MUST treat the job as `sensitive/no-delegable`
- AND GHAGGA MUST NOT dispatch it to the delegated runner

#### Scenario: Ambiguous policy defaults to non-delegable

- GIVEN repository `acme/api` has conflicting or incomplete policy data for job `build`
- WHEN GHAGGA evaluates a request to delegate `build`
- THEN GHAGGA MUST reject delegated execution
- AND GHAGGA MUST report the decision as a conservative safety rejection rather than a runner failure

### Requirement: Delegation Trigger Timing

GHAGGA MUST evaluate delegation eligibility when a pull request is opened or synchronized (new push to PR branch). Each evaluation is independent — a previously rejected job is re-evaluated on each trigger. Manual trigger via dashboard/API is also supported and follows the same policy evaluation path.

#### Scenario: Delegation is evaluated on PR open

- GIVEN repository `acme/api` has Delegated CI enabled with job `unit-tests` classified as `safe/delegable`
- WHEN a pull request is opened against `acme/api`
- THEN GHAGGA MUST evaluate `unit-tests` for delegation eligibility at PR-open time

#### Scenario: Delegation is re-evaluated on each push to the PR branch

- GIVEN repository `acme/api` has Delegated CI enabled with job `lint` classified as `safe/delegable`
- AND `lint` was previously rejected because the policy was temporarily disabled
- WHEN a new commit is pushed to the PR branch and the policy has since been re-enabled
- THEN GHAGGA MUST re-evaluate `lint` independently, without referencing the prior rejection
- AND GHAGGA MAY approve the job if it now satisfies the eligibility checks

#### Scenario: Manual trigger via dashboard follows the same policy path

- GIVEN repository `acme/api` has Delegated CI enabled with job `unit-tests` classified as `safe/delegable`
- WHEN a user triggers delegated CI for `unit-tests` via the GHAGGA dashboard or API
- THEN GHAGGA MUST evaluate the job against the current repository policy and MVP guardrails
- AND GHAGGA MUST NOT bypass policy checks for manually triggered jobs

### Requirement: Delegation Eligibility and Rejection Handling

Before dispatching a job, the system MUST verify that the requested job satisfies the repository policy and the Delegated CI MVP safety contract. If any eligibility check fails, GHAGGA MUST refuse delegation and MUST return a clear rejection outcome instead of attempting best-effort delegated execution.

The rejection outcome MUST distinguish policy rejection from execution failure.

#### Scenario: Job rejected before dispatch because it is not apt for delegation

- GIVEN repository `acme/api` has job `integration-tests` configured
- AND the job requires an execution context outside the MVP safety contract
- WHEN GHAGGA evaluates the job for delegation
- THEN GHAGGA MUST reject the delegation before runner dispatch
- AND GHAGGA MUST mark the job outcome as rejected or non-delegated
- AND GHAGGA MUST include a machine-readable reason indicating why the job is not apt

#### Scenario: No fallback to unsafe delegated execution

- GIVEN repository `acme/api` requests delegated execution for a job that fails eligibility checks
- WHEN GHAGGA produces the outcome
- THEN GHAGGA MUST NOT downgrade the policy failure into a delegated runner attempt
- AND GHAGGA MUST preserve the repository's native CI as the source of truth for that job

### Requirement: Delegated Job State and Traceability

The system MUST provide traceable state reporting for each delegated CI job so GHAGGA can distinguish policy evaluation, dispatch, execution, callback completion, rejection, and failure states.

At minimum, GHAGGA MUST retain enough status information to answer:
- which repository requested the delegated job
- which named job was evaluated
- whether the job was approved, rejected, dispatched, running, completed, failed, or timed out
- why a job was rejected or failed
- which delegated execution instance or correlation identifier produced the final status

#### Scenario: Approved delegated job reports end-to-end state transitions

- GIVEN repository `acme/api` has job `unit-tests` classified as `safe/delegable`
- WHEN GHAGGA approves, dispatches, and receives completion for that job
- THEN GHAGGA MUST expose a traceable status progression from evaluation to completion
- AND the final status MUST remain correlated to the originating repository and job name

#### Scenario: Rejected job remains visible in reporting

- GIVEN repository `acme/api` requests delegation for job `release`
- AND `release` is not eligible for delegation
- WHEN GHAGGA records the outcome
- THEN GHAGGA MUST retain a visible rejected or non-delegated status for that job
- AND GHAGGA MUST include the rejection reason in the recorded status

### Requirement: MVP Safety Boundaries

The Delegated CI MVP MUST be limited to low-risk CI workloads such as validation, linting, tests, and comparable read-only or non-production checks.

For the MVP, the system MUST NOT delegate:
- production deployments
- release publishing or package publication
- infrastructure mutation
- workflows requiring sensitive long-lived credentials
- workflows requiring production secrets, signing keys, or privileged cloud access
- executions with high-risk external side effects

#### Scenario: Low-risk validation job is within MVP scope

- GIVEN repository `acme/api` configures job `lint` as `safe/delegable`
- AND `lint` requires no production secret, no privileged token, and no external state mutation
- WHEN GHAGGA evaluates the job
- THEN GHAGGA MAY approve the job for delegated execution

#### Scenario: Production deployment is out of scope for MVP

- GIVEN repository `acme/api` configures job `deploy-prod`
- WHEN GHAGGA evaluates `deploy-prod` for delegated execution
- THEN GHAGGA MUST reject the job as outside the Delegated CI MVP scope
- AND GHAGGA MUST classify or treat it as `sensitive/no-delegable`

#### Scenario: Secret-dependent job is out of scope for MVP

- GIVEN repository `acme/api` configures job `sign-release`
- AND that job requires signing keys or sensitive release credentials
- WHEN GHAGGA evaluates the job for delegation
- THEN GHAGGA MUST reject delegated execution
- AND GHAGGA MUST NOT expose those secret requirements to the public runner surface

### Requirement: Guardrails for Logs, Artifacts, Cache, and Tokens

Delegated CI MUST apply explicit guardrails to all delegated execution surfaces, including logs, artifacts, caches, and tokens.

For MVP delegated jobs:
- logs MUST NOT expose private repository contents, sensitive values, or raw secret material
- artifacts MUST be limited to outputs explicitly allowed by the Delegated CI policy and MUST NOT be used to export private source content or sensitive data
- caches MUST be scoped so that one repository's delegated job cannot read another repository's private cache state
- tokens MUST be minimally scoped, time-bounded, and limited to the delegated job's approved purpose
- tokens, secrets, callback credentials, and equivalent sensitive values MUST NOT be emitted in logs, artifacts, or cache keys

#### Scenario: Delegated job completes without leaking sensitive data to logs

- GIVEN GHAGGA dispatches a delegated job for private repository `acme/api`
- WHEN the job produces runtime output
- THEN the exposed delegated logs MUST contain only output allowed by the delegated safety contract
- AND they MUST NOT include private source code, secret values, or raw token material

#### Scenario: Artifact request outside policy is blocked

- GIVEN repository `acme/api` has a delegated job whose policy does not allow source bundle artifacts
- WHEN the delegated execution attempts to publish an artifact containing repository source content
- THEN GHAGGA MUST treat that artifact as disallowed
- AND the delegated job MUST NOT complete successfully with that artifact exposed

#### Scenario: Cache and token scope remain repository-bound

- GIVEN delegated jobs run for `acme/api` and `acme/web`
- WHEN GHAGGA provisions caches and tokens for those jobs
- THEN the cache and token scope for `acme/api` MUST remain isolated from `acme/web`
- AND neither job MUST gain access to the other repository's delegated execution state

### Requirement: Existing Native CI Remains Authoritative for Non-Delegable Work

Delegated CI MUST extend GHAGGA's SaaS orchestration model without replacing native CI for Action, CLI, or other non-delegated execution modes. Jobs that are rejected, sensitive, or out of MVP scope MUST remain the responsibility of the repository's native CI process.

#### Scenario: Action mode remains unchanged for sensitive jobs

- GIVEN a repository uses GHAGGA's Action distribution mode for its own workflows
- WHEN the repository runs a job classified as `sensitive/no-delegable`
- THEN GHAGGA MUST NOT require that job to migrate into Delegated CI
- AND the repository's native workflow MUST remain the authoritative execution path

#### Scenario: Delegated CI does not become mandatory platform-wide

- GIVEN installation `acme` has repositories with and without Delegated CI enabled
- WHEN GHAGGA processes CI job evaluations across the installation
- THEN GHAGGA MUST allow delegated and non-delegated repositories to coexist
- AND repositories without Delegated CI enabled MUST continue using native CI behavior
