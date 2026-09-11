# Distribution Specification

> **Origin**: Archived from `ghagga-v2-rewrite` change, domain `distribution` (2026-03-07)

## Purpose

GHAGGA supports 4 distribution modes to maximize flexibility and minimize cost. Each mode is a thin adapter that wraps the core review engine with different input/output mechanisms.

## Requirements

### Requirement: SaaS Mode (Server + Webhook)

The system MUST support deployment as a centralized server receiving GitHub webhooks. This is the primary mode for private repositories.

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

### Requirement: GitHub Action Mode

The system MUST support execution as a GitHub Action for public repositories (free unlimited minutes).

#### Scenario: Action triggered on PR

- GIVEN a repository with `.github/workflows/ghagga.yml` configured
- WHEN a pull_request event occurs
- THEN the Action MUST:
  1. Check out the repository
  2. Install Semgrep, Trivy, and CPD (from container or setup steps)
  3. Compute the diff from the PR
  4. Run the core review pipeline
  5. Post the review as a PR comment using the GitHub token

#### Scenario: Action configuration

- GIVEN a user setting up the GHAGGA Action
- WHEN they configure the workflow YAML
- THEN the Action MUST accept inputs:
  - `provider`: LLM provider (default: "anthropic")
  - `model`: LLM model (default: provider's default)
  - `mode`: review mode (default: "simple")
  - `api-key`: LLM API key (from GitHub Secrets)
  - `enable-semgrep`: boolean (default: true)
  - `enable-trivy`: boolean (default: true)
  - `enable-cpd`: boolean (default: true)

#### Scenario: Action without database

- GIVEN the Action mode running in GitHub's ephemeral environment
- WHEN the review pipeline needs memory
- THEN memory MUST gracefully degrade (no past context available)
- AND the review MUST complete successfully without a database connection

### Requirement: CLI Mode

The system MUST support local execution via command-line interface, including git hook integration for automated review on every commit.

#### Scenario: Review staged changes

- GIVEN a user in a git repository with staged changes
- WHEN the user runs `npx ghagga review`
- THEN the CLI MUST:
  1. Compute the diff from staged changes (or HEAD if no staged changes)
  2. Run static analysis tools (if available locally)
  3. Execute the review pipeline using the configured LLM provider
  4. Output the review result to stdout in formatted markdown

#### Scenario: CLI configuration

- GIVEN a user running the CLI for the first time
- WHEN the user runs `npx ghagga review`
- THEN the CLI MUST check for an API key in:
  1. `--api-key` flag
  2. Environment variable `GHAGGA_API_KEY`
  3. `.ghagga.json` file in the repository root
- AND if no key is found, the CLI MUST display a helpful error message

#### Scenario: CLI with optional tools

- GIVEN a user without Semgrep installed locally
- WHEN the user runs `npx ghagga review`
- THEN the CLI MUST skip Semgrep with a warning "Semgrep not found, skipping security scan. Install with: pip install semgrep"
- AND the review MUST continue with available tools

#### Scenario: CLI output formats

- GIVEN a completed review
- WHEN the CLI outputs results
- THEN the CLI MUST support output formats:
  - `--format markdown` (default): human-readable markdown
  - `--format json`: machine-readable JSON
  - `--format sarif`: SARIF format for IDE integration

#### Scenario: CLI registers hooks command group

> Added by change: cli-git-hooks

- GIVEN the GHAGGA CLI binary is executed
- WHEN the user runs `ghagga --help`
- THEN the help output MUST list `hooks` as an available command alongside `review`, `login`, `logout`, `status`, and `memory`

#### Scenario: CLI review with --staged flag

> Added by change: cli-git-hooks

- GIVEN a user in a git repository with staged changes
- WHEN the user runs `ghagga review --staged`
- THEN the CLI MUST compute the diff using `git diff --cached` instead of the full working tree diff
- AND the review pipeline MUST run with the staged diff
- AND the output MUST indicate the review scope was limited to staged changes

#### Scenario: CLI review with --quick flag

> Added by change: cli-git-hooks

- GIVEN a user in a git repository with changes
- WHEN the user runs `ghagga review --quick`
- THEN the CLI MUST run only static analysis (Semgrep, Trivy, CPD)
- AND no LLM API call MUST be made
- AND the output MUST complete significantly faster than a full review

#### Scenario: CLI review with --commit-msg flag

> Added by change: cli-git-hooks

- GIVEN a user with a commit message file at `.git/COMMIT_EDITMSG`
- WHEN the user runs `ghagga review --commit-msg .git/COMMIT_EDITMSG`
- THEN the CLI MUST read the commit message from the specified file
- AND the CLI MUST validate the commit message quality
- AND the CLI MUST NOT compute or review any code diff

#### Scenario: CLI review with --exit-on-issues flag

> Added by change: cli-git-hooks

- GIVEN a review completes with a critical-severity finding
- WHEN the `--exit-on-issues` flag is active
- THEN the CLI process MUST exit with code 1
- AND the finding details MUST be displayed before exit

#### Scenario: CLI review without new flags retains existing behavior

> Added by change: cli-git-hooks

- GIVEN a user runs `ghagga review .` without any of the new flags
- WHEN the review pipeline executes
- THEN the behavior MUST be identical to the pre-change CLI
- AND exit codes, output format, and pipeline execution MUST be unchanged

#### Scenario: CLI authentication not required for --quick

> Added by change: cli-git-hooks

- GIVEN a user has NOT run `ghagga login`
- AND no API key is configured
- WHEN the user runs `ghagga review --quick`
- THEN the review MUST succeed (static analysis does not need an API key)
- AND no authentication error MUST be displayed

### Requirement: Docker Support

The system MUST provide a Docker image for self-hosting on any infrastructure.

#### Scenario: Docker Compose deployment

- GIVEN a user with Docker and Docker Compose installed
- WHEN the user runs `docker compose up` with the provided `docker-compose.yml`
- THEN the system MUST start the Hono server with all static analysis tools pre-installed
- AND a PostgreSQL database MUST be started as a service
- AND the server MUST be accessible on the configured port

#### Scenario: Pre-built container with tools

- GIVEN the GHAGGA Docker image
- WHEN the container starts
- THEN Semgrep, Trivy, and PMD/CPD MUST be pre-installed and available on PATH
- AND Node.js runtime MUST be available

---

### Requirement: Docker Image Digest Pinning

> **Origin**: Archived from `docker-digest-pinning` change (2026-03-07)

All Docker base images in project-owned Dockerfiles and Compose files MUST be pinned to their SHA256 multi-architecture manifest digest to ensure reproducible, tamper-proof builds.

Every `FROM` instruction MUST use the format `FROM <image>:<tag>@sha256:<digest>`.

Every `image:` field in `docker-compose.yml` MUST use the format `image: <image>:<tag>@sha256:<digest>`.

The digest MUST be the multi-architecture manifest digest (not platform-specific) so builds work on amd64, arm64, and other supported platforms.

The human-readable tag (e.g., `22-slim`, `16-alpine`) MUST be preserved alongside the digest for developer readability.

#### Scenario: Action Dockerfile uses pinned images

- GIVEN `apps/action/Dockerfile` contains two `FROM` statements (builder + runtime stages)
- WHEN the Dockerfile is built
- THEN both `FROM` lines MUST include `@sha256:` digest syntax
- AND each line MUST retain the human-readable tag (e.g., `node:22.22.2-slim@sha256:...`)

#### Scenario: Server Dockerfile uses pinned images

- GIVEN `apps/server/Dockerfile` contains two `FROM` statements (builder + runner stages)
- WHEN the Dockerfile is built
- THEN both `FROM` lines MUST include `@sha256:` digest syntax
- AND each line MUST retain the human-readable tag (e.g., `node:22.22.2-slim@sha256:...`)

#### Scenario: Docker Compose uses pinned PostgreSQL image

- GIVEN `docker-compose.yml` contains a PostgreSQL service
- WHEN the compose file is parsed
- THEN the `image:` field MUST include `@sha256:` digest syntax
- AND the human-readable tag MUST be preserved (e.g., `postgres:16-alpine@sha256:...`)

#### Scenario: No unpinned Docker images in project files

- GIVEN all project-owned Dockerfiles and `docker-compose.yml`
- WHEN scanning for `FROM` and `image:` directives
- THEN every directive MUST contain `@sha256:`
- AND no `TODO` comments referencing digest pinning MUST remain

---

### Requirement: Hook-Triggered Review Scope

> Added by change: cli-git-hooks

When the CLI is invoked from a git hook context (identifiable by the combination of `--staged --exit-on-issues --plain` or `--commit-msg <file> --exit-on-issues --plain`), the review MUST be scoped and optimized for that context.

#### Scenario: Pre-commit hook invocation

- GIVEN the CLI is invoked as `ghagga review --staged --exit-on-issues --plain`
- WHEN the review pipeline executes
- THEN the diff MUST come from `git diff --cached`
- AND the output MUST be in plain mode (no ANSI, no spinners)
- AND the exit code MUST be 1 if critical/high issues are found, 0 otherwise

#### Scenario: Commit-msg hook invocation

- GIVEN the CLI is invoked as `ghagga review --commit-msg .git/COMMIT_EDITMSG --exit-on-issues --plain`
- WHEN the pipeline executes
- THEN only the commit message validation MUST run
- AND the output MUST be in plain mode
- AND the exit code MUST be 1 if the commit message has high/critical issues, 0 otherwise

#### Scenario: Hook invocation saves to memory

- GIVEN the CLI is invoked from a hook context
- AND memory is not disabled (`--no-memory` not passed)
- WHEN the review completes
- THEN observations MUST be saved to the SQLite memory store at `~/.config/ghagga/memory.db`

#### Scenario: Hook invocation with --no-memory via GHAGGA_HOOK_ARGS

- GIVEN the CLI is invoked from a hook
- AND `GHAGGA_HOOK_ARGS="--no-memory"` is set in the environment
- WHEN the review completes
- THEN no observations MUST be saved to memory

---

### Requirement: SaaS and Action Modes Unaffected

> Added by change: cli-git-hooks

The hook management commands and new review flags MUST NOT affect the SaaS server mode or GitHub Action mode. These are CLI-only features.

#### Scenario: SaaS server does not expose hooks commands

- GIVEN the GHAGGA server is running in SaaS mode
- WHEN a webhook is received
- THEN the server MUST NOT invoke any hooks-related logic
- AND the review pipeline MUST behave identically to pre-change behavior

#### Scenario: GitHub Action does not use new flags

- GIVEN the GHAGGA GitHub Action is triggered
- WHEN the Action runs the review pipeline
- THEN the Action MUST NOT use `--staged`, `--commit-msg`, `--exit-on-issues`, or `--quick` flags
- AND the Action MUST continue to use the full diff from the PR
