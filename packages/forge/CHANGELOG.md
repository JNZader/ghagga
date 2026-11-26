# ghagga-forge

## 3.9.0

### Minor Changes

- 5e647bb: Review comments now post inline only for critical and high findings. Each inline comment includes a collapsed "How to verify" section and a collapsed prompt an AI agent can use to fix the finding. The summary comment is still posted and, when a previous review exists, lists findings that have disappeared since then. The summary itself continues to be edited in place.
- 2c35f26: The GitHub App publishes a `ghagga/security` check run. It fails when a security finding is at or above a configurable threshold (default: critical) and stays failed on that commit until a later review no longer contains the finding. The App also uploads a SARIF report to GitHub code scanning. `checks: write` and `security_events: write` are required, and adding them asks existing installations to re-consent.
- 79d57b3: The security lens now reports REACHABILITY (`external`, `internal`, `unreachable`) and EXPLOITABILITY (`trivial`, `moderate`, `difficult`, `theoretical`). Review comments show both as columns when a finding carries them. Trivy CVE labels (`exploitable`, `potentially-exploitable`, `not-exploitable`) reuse the same Exploitability column.
- c0314f5: Security findings must include SOURCE, PATH, MISSING_GUARD, and SINK, each as a file and a line, before they are published as open. Critical and high findings also pass a refuter checklist (duplicate, mitigated, speculative, test-only, dead code, unreachable). Refuted findings stay in the review comment inside a collapsed block with the reason. A refuter failure does not block the review.
- 28b5d39: Config, lenses, and the dependency graph are read only from the default branch or a protected branch. `ghagga/graph` was an unprotected orphan branch; it is used only when that branch is protected, and a graph file on the default branch is preferred. `ghagga review --pr` and `--mr` do not load `.ghagga.json`, `.ghagga/lenses`, or `.ghagga/graph.json` from the pull request head. A fork or an author without write permission cannot supply those inputs.

### Patch Changes

- Updated dependencies [5e647bb]
- Updated dependencies [2c35f26]
- Updated dependencies [79d57b3]
- Updated dependencies [c0314f5]
- Updated dependencies [28b5d39]
  - ghagga-core@3.9.0

## 3.8.0

### Minor Changes

- 455967a: Add an opt-in nightly health digest for SaaS/App repositories: set `digestsEnabled` on a repository (or at the installation level for repos using global settings) and the server aggregates the stored review findings in the database — zero LLM calls, zero tokens — and publishes them nightly at 03:00 UTC as ONE `GHAGGA Health Digest` issue per repository, updated in place on every run (per-severity window counts, score trend, top-10 riskiest files by severity weight x recency). Runs with no new findings skip without touching the issue; publication failures (e.g. missing Issues-write permission) are recorded as `FAILED` on the digest history row, never silently dropped, and the next nightly run still fires.
  
  Digest scheduling is a SaaS/App-only capability by design (the CLI's `ghagga health` and the GitHub Action path are unchanged); publication is GitHub-only in v1 (the GitLab port exposes MR notes only). The feature defaults to OFF for every repository.

### Patch Changes

- d9827d0: Fix wave: 24 backlog items from the day's five SDD 4R reviews. Correctness: spec three-writer reconciliation, extractChangedSymbols tail-fallback reset, staleness NaN fail-closed, per-side token split guards (workflow/consensus/fan-out), watermark clock-skew pin. Resilience: diagram lazy-load error boundary, digest worker lazy forge seam (deleted repo → SKIPPED not 3 attempts), settings scheduler hooks surfaced, reconciler NaN guard. Quality: fixture score-docs, 30-day window cross-refs, GRAPH_STALE_DAYS constant, mermaid-lazy regex tightened, comparePaths deduplicated, double graph load skipped. Investigation: CLI markdown output now renders Blast Radius; GatewayResponse accepts token split (bridge-side pending); semgrep failures surface as errors instead of silent 0-findings; NEEDS_HUMAN_REVIEW added to the reviewer's STATUS menu. Diagram redesigned for legibility: flowchart LR, theme-adaptive palette, 2-segment clusters, test files collapsed into per-cluster summary nodes. Comment format overhauled: top-10 visible findings with the rest collapsed (byte-capped), diagram positioned after Summary, AI summary headings normalized, cost footer honest about partial token measurement.
- Updated dependencies [d9827d0]
- Updated dependencies [97ee9af]
- Updated dependencies [97a5c74]
- Updated dependencies [07a06f8]
- Updated dependencies [455967a]
- Updated dependencies [0ebccde]
  - ghagga-core@3.8.0

## 3.7.1

### Patch Changes

- Updated dependencies [870b616]
  - ghagga-core@3.7.1

## 3.7.0

### Minor Changes

- Add Groq as a direct provider. The CLI and GitHub Action call Groq chat completions at api.groq.com with an API key instead of remapping `groq` to gateway.

### Patch Changes

- Updated dependencies
  - ghagga-core@3.7.0

## 3.6.1

### Patch Changes

- 48ebc73: Fail CI when OSV reports a lockfile advisory, restore the Test GHAGGA Action workflow, and move the floating major tag when a stable release is published.
- Updated dependencies [48ebc73]
  - ghagga-core@3.6.1

## 3.6.0

### Minor Changes

- Lockstep v3.6.0 with ghagga, ghagga-core, and ghagga-db. No public API change. Runtime dependencies are unchanged; this package moves so the fixed group stays on one version.

### Patch Changes

- Updated dependencies
  - ghagga-core@3.6.0

## 3.5.0

### Minor Changes

- TypeScript 7, pnpm 12, esbuild Action bundle (ncc removed), public docs aligned with the runtime, and live GitLab `--mr` write-path E2E.

### Patch Changes

- Updated dependencies
  - ghagga-core@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [fefa99e]
- Updated dependencies [56dca64]
- Updated dependencies [8411136]
- Updated dependencies [a1239d3]
- Updated dependencies [fdfacff]
- Updated dependencies [089a5b6]
- Updated dependencies [91930f4]
- Updated dependencies [8f11441]
- Updated dependencies [a86a886]
- Updated dependencies [3a25d6f]
  - ghagga-core@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies [8989e0d]
  - ghagga-core@3.3.0

## 3.2.0

### Minor Changes

- 8cc5cdd: Publish semantic-memory retrieval across the CLI, core engine, and storage backends, including configurable embedding providers, hybrid keyword/vector search, safe schema metadata, backfill tooling, and graceful keyword-only fallback.

  Include the post-3.1.0 reliability, security, forge-integration, and distribution corrections, and keep the four published package versions aligned for the coordinated release.

### Patch Changes

- Updated dependencies [8cc5cdd]
  - ghagga-core@3.2.0

## 3.1.0

### Minor Changes

- a2a537e: forge-agnostic: GitHub/GitLab forge abstraction + CLI review post-back

  **New `ghagga-forge` package** (first publish) — a forge-agnostic adapter layer that decouples ghagga from any single git host:
  - `ForgeAdapter` port + canonical domain model (RepoRef, ChangeRequestRef, CommentId, UnifiedDiff, …) and a `ForgeCredentialProvider` seam.
  - `GitHubForgeAdapter` and `GitLabForgeAdapter` (summary-comment post-back; GitLab supports self-hosted via host-derived API base + `GITLAB_HOST` / `GITLAB_API_BASE`).
  - `GitHubAppCredentialProvider` (TTL cache + singleflight + in-job 401/403 recovery) and `StaticTokenProvider` (PAT).

  **CLI — post review findings back to a PR/MR:**
  - `ghagga review --pr <n>` → posts the summary to a GitHub PR (`GITHUB_TOKEN` / `GH_TOKEN`). Unlocks the Jenkins+GitHub / CI use case.
  - `ghagga review --mr <n>` → posts to a GitLab MR (`GITLAB_TOKEN` / `GL_TOKEN`), incl. self-hosted instances.
  - Post-back is blocking by default when explicitly requested (non-zero exit on failure; `--pr-soft-fail` to opt out); discloses the target host on stderr before posting.

  **Server (`ghagga-core` / review worker):**
  - Review worker and webhook `issue_comment` handler routed through the forge adapter (behavior-identical), via a single `makeGitHubAdapter` composition root.
  - Static-analysis tool diagnostics moved to stderr so `--output sarif` / `--output json` stdout stays clean for CI consumers.
  - Comment/note listing paginates fully (no more duplicate review comments on large PRs), bounded by a wall-clock budget.

### Patch Changes

- Updated dependencies [a2a537e]
  - ghagga-core@3.1.0
