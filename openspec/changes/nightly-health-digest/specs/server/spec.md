# Server Delta

> **Change**: `nightly-health-digest`
> **Base spec**: `openspec/specs/server/spec.md`
>
> **Merge seam**: no open change adds a digest requirement. `graph-context-retrieval`
> and `ghagga-pr-native-readonly` add unrelated server requirements — no interaction.

## ADDED Requirements

### Requirement: Nightly Health Digest Scheduling

The server MUST operate a dedicated `digest` queue with one BullMQ repeatable job per opted-in repository, registered with jobId `digest:{repositoryId}` and cron `0 3 * * *` UTC (fixed v1 default), re-registered idempotently on startup and on settings change. Rationale: health signals accumulate in `reviews.findings` jsonb but are invisible unless someone runs the CLI; a nightly DB-only aggregation published as ONE issue per repo makes them visible at zero token cost. This reverses the single-box "no BullMQ repeatable" decision only for the digest workload (cron fidelity, per-repo identity, durable across restarts); the issue-draft reaper is not converted.

The scheduling surface MUST satisfy:

- **Registration**: only repositories whose effective settings resolve `digestsEnabled` to `true` are registered. Re-registration with the same jobId and cron MUST NOT create a second schedule and MUST NOT fire a duplicate run.
- **Settings plumbing**: `digestsEnabled` resolves through the existing RepoSettings global/per-repo flow and defaults to off when absent (settings delta).
- **One-open-digest invariant**: the database MUST enforce at most one open digest row per repository. The first digest run creates the issue (GitHub-only; the only forge with an issues write surface in v1); every subsequent run updates the same issue in place via the digest marker.
- **Skip-and-record**: when no new findings exist since the last digest watermark, the run MUST record a skipped outcome on the digest row and MUST make zero forge calls.
- **Failure recording**: publication failures — including GitHub App permission drift on Issues write — MUST be recorded on the digest row as a failure state, never silently skipped.
- **Queue isolation**: digest jobs MUST NOT ride the review queue; review jobs assume PR context (headSha, diff, postback marker) that digest jobs do not have.

#### Scenario: First run creates the digest issue

- GIVEN a repository with `digestsEnabled: true`, three reviews with findings since the watermark, and no existing digest row
- WHEN the repeatable job fires and the worker runs
- THEN the digest issue MUST be created via the forge adapter with a marker header
- AND exactly one open digest row MUST exist for the repository
- AND the watermark MUST advance past the aggregated reviews

#### Scenario: Second run updates in place

- GIVEN a repository with an existing open digest row referencing issue #42
- AND new findings arrived since the stored watermark
- WHEN the next digest run executes
- THEN the digest issue #42 MUST be updated in place (same issue number, marker-based lookup)
- AND no second open digest row MUST be creatable for the repository
- AND no new issue MUST be created

#### Scenario: Server restart re-registers without duplicates

- GIVEN a registered repository with repeatable jobId `digest:{repositoryId}` and cron `0 3 * * *` UTC
- WHEN the server restarts and the registration reconciler runs
- THEN the identical repeatable (same jobId and cron) MUST be registered
- AND the queue MUST contain exactly one schedule for that jobId
- AND no extra digest run MUST be triggered by the restart itself

#### Scenario: Empty window skips without forge calls

- GIVEN a repository with an open digest row and zero new findings since the stored watermark
- WHEN the nightly job fires
- THEN the run MUST be recorded as skipped on the digest row
- AND zero forge adapter calls MUST be made
- AND the watermark MUST remain unchanged

#### Scenario: Opting out removes the repeatable

- GIVEN a registered repository whose effective `digestsEnabled` flips to `false`
- WHEN the registration reconciler observes the change
- THEN the repeatable job `digest:{repositoryId}` MUST be removed from the queue
- AND no further digest publication MUST occur
- AND the stored digest row MUST remain for audit
- AND review processing for the repository MUST be unchanged

#### Scenario: Permission failure is recorded, not silent

- GIVEN a registered repository whose GitHub App installation lacks Issues write permission
- WHEN the digest run attempts to create or update the digest issue and the forge call fails
- THEN the failure MUST be recorded on the digest row with a surfaced failure state
- AND the next scheduled run MUST still fire
- AND the failure MUST NOT be swallowed as a successful skip
