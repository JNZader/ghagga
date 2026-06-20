---
"ghagga-forge": minor
"ghagga": minor
"ghagga-core": minor
---

forge-agnostic: GitHub/GitLab forge abstraction + CLI review post-back

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
