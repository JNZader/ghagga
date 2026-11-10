# Distribution Delta

> **Change**: `nightly-health-digest`
> **Base spec**: `openspec/specs/distribution/spec.md`
>
> **Merge seam**: no open change modifies `SaaS Mode (Server + Webhook)`; no rebase
> interaction with `coolify-migration` or `ghagga-pr-native-readonly`.

## MODIFIED Requirements

### Requirement: SaaS Mode (Server + Webhook)

The system MUST support deployment as a centralized server receiving GitHub webhooks. This is the primary mode for private repositories.

Additionally, the nightly health digest (scheduled aggregation of stored findings published as one issue per repo) MUST be a SaaS/App-only capability: it requires the server's scheduler, database, and the GitHub App's Issues write permission. Parity is intentional, not a gap — the CLI already exposes local health via `ghagga health`, and the GitHub Action path is a per-run review surface with no scheduling or shared review history. Publication is GitHub-only in v1 (GitLab port exposes MR notes only).

(Previously: the requirement covered webhook-driven reviews and 1-click self-hosting only.)

#### Scenario: End-to-end SaaS review

- GIVEN a deployed Hono server with Inngest configured
- WHEN a PR is opened on a repository with the GHAGGA GitHub App installed
- THEN the server MUST receive the webhook, dispatch to Inngest, execute the review pipeline, and post a comment on the PR
- AND the entire flow MUST work without user intervention after initial setup

#### Scenario: 1-Click Deploy for community self-hosting

- GIVEN a community member wants their own GHAGGA instance
- WHEN they click the "Deploy to Railway" or "Deploy to Koyeb" button in the README
- THEN the deployment MUST prompt for required env vars (DATABASE_URL, GITHUB_APP_ID, GITHUB_PRIVATE_KEY, INNGEST_EVENT_KEY)
- AND the deployment MUST complete without manual file editing
- AND the resulting instance MUST be fully functional

#### Scenario: Nightly digest is App-only parity

- GIVEN a repository with the GHAGGA GitHub App installed and `digestsEnabled: true`
- WHEN the nightly digest fires
- THEN the digest issue MUST be published through the server's GitHub App installation
- AND no digest publication surface MUST exist in the CLI or the GitHub Action path

#### Scenario: CLI and Action health unaffected

- GIVEN the nightly digest capability ships
- WHEN a user runs `ghagga health` locally, or a GitHub Action run executes a review
- THEN both MUST behave identically to pre-change behavior
- AND neither MUST gain digest scheduling, digest publication, or any dependency on it
