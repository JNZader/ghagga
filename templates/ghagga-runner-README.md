# GHAGGA Static Analysis Runner

This repository runs static analysis tools (16 tools including Semgrep, Trivy, PMD/CPD, Gitleaks, zizmor, and more) on behalf of the [GHAGGA](https://ghagga.dev) AI Code Review service. It is automatically managed by the GHAGGA GitHub App.

> **You should not need to modify this repository.** GHAGGA manages the workflow file automatically and will restore it if changes are detected.

## Setup

1. **Create this repo from the template** — it must be **public** (GitHub Actions is free for public repos)
2. **Install the [GHAGGA GitHub App](https://github.com/apps/ghagga-review)** on this repository
3. **That's it** — GHAGGA will automatically dispatch analysis when you open PRs on your connected repos

## How It Works

```mermaid
sequenceDiagram
    participant GH as GitHub (PR opened)
    participant SRV as GHAGGA Server (Render)
    participant RUN as This Runner Repo (Actions)

    GH->>SRV: webhook (PR event)
    SRV->>RUN: workflow_dispatch
    RUN->>RUN: Clone, run static analysis tools
    RUN->>SRV: callback (JSON results)
    SRV->>GH: Post review comment
```

1. You open a Pull Request on one of your repositories
2. GHAGGA receives the webhook and dispatches a `workflow_dispatch` event to this runner repo
3. The runner workflow clones your repo, runs static analysis tools (Semgrep, Trivy, CPD, and more), and sends structured JSON results back
4. GHAGGA combines the static analysis findings with AI-powered code review and posts a comment on your PR

The static analysis tools run here on GitHub Actions (7GB RAM, free for public repos), while the lightweight GHAGGA server handles webhooks, LLM orchestration, and comment posting.

## Security

Your source code is handled with multiple layers of protection:

1. **Silent execution** — All tool stdout/stderr is redirected to `/dev/null`. No file paths, code snippets, or findings text appear in workflow logs.

2. **Log masking** — Repository names, tokens, and clone paths are masked using GitHub's `::add-mask::` so any accidental output is replaced with `***`.

3. **Log deletion** — Workflow logs are automatically deleted via the GitHub API after each run. As a safety net, log retention is set to the minimum (1 day).

4. **Token isolation** — The clone token is stored as an encrypted GitHub repository secret and is never included in the dispatch payload. GitHub automatically masks `${{ secrets.* }}` values in logs.

5. **Workflow integrity** — Before each dispatch, GHAGGA verifies the workflow file hasn't been tampered with by comparing its SHA-256 hash against the canonical version. If tampered, it's automatically restored.

**What this means**: Even though this repository is public, your private source code cannot be seen in the Actions logs. The only data that leaves the runner is a structured JSON payload of findings (severity, file name, line number, message) sent to the GHAGGA server via an HMAC-authenticated callback.

## Troubleshooting

### Workflow runs aren't triggering

- **Is the GHAGGA App installed?** Check your GitHub App installations at `Settings → Applications → Installed GitHub Apps`.
- **Is this repo public?** The repo must be public for free GitHub Actions minutes. Private repos will consume your Actions minutes quota.
- **Is the `GHAGGA_TOKEN` secret set?** GHAGGA automatically sets this secret before each dispatch. If it's missing, the App may need to be reinstalled.

### Clone failures

- The installation token may have expired (1-hour lifetime). GHAGGA generates a fresh token before each dispatch, but long queue times can cause expiration.
- Check that the GHAGGA App has read access to the target repository.

### Tools are failing

- Tool failures don't block the review — GHAGGA falls back to LLM-only analysis for any tools that fail.
- Individual tool results show `status: "error"` in the callback, but other tools continue.

## Tools

The runner supports 16 static analysis tools across 5 categories. Core tools include:

| Tool | Purpose |
|------|---------|
| [Semgrep](https://semgrep.dev) | Static analysis (security, bugs, style) |
| [Trivy](https://trivy.dev) | Dependency vulnerability scanning |
| [PMD/CPD](https://pmd.github.io) | Copy-paste detection |
| [Gitleaks](https://gitleaks.io) | Secret detection |
| [ShellCheck](https://www.shellcheck.net) | Shell script linting |
| [Lizard](https://github.com/terryyin/lizard) | Cyclomatic complexity |

Additional language-specific tools (Ruff, Bandit, golangci-lint, Biome, Psalm, clippy, Hadolint, zizmor) activate automatically when matching files are in the diff. See the [Static Analysis docs](https://jnzader.github.io/ghagga/docs/#/static-analysis) for the full list.

## Links

- [GHAGGA Website](https://ghagga.dev)
- [GHAGGA GitHub App](https://github.com/apps/ghagga-review)
- [Documentation](https://github.com/JNZader/ghagga)
