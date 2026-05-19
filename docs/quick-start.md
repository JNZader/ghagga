# Quick Start

## Choose Your Path

| If you want... | Use | Time | Requires | Guide |
|---|---|---|---|---|
| **Easiest setup — install and go** | **SaaS (GitHub App)** ⭐ Recommended | ~5 min | GitHub account | [SaaS Guide](saas-getting-started.md) |
| CI/CD integration — runs in your pipeline | GitHub Action | ~10 min | Repo admin access | [Action Guide](github-action.md) |
| Local review from your terminal | CLI | ~5 min | Node.js >= 20 | [CLI Guide](cli.md) |
| Full control — your own server | Self-Hosted (Docker) | ~30 min | Docker, PostgreSQL | [Self-Hosted Guide](self-hosted.md) |

All modes use the same review engine under the hood. [Learn more about the architecture](architecture.md).

## GitHub Action

The fastest way to get started. No server needed — runs directly in GitHub's infrastructure.

```yaml
# .github/workflows/review.yml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: JNZader/ghagga-action@v1
```

See [GitHub Action](github-action.md) for all inputs and outputs.

## CLI

Review local changes from your terminal. No server required.

```bash
# Install globally
npm install -g ghagga

# Login with GitHub (free — uses GitHub Models, no API key needed)
ghagga login

# Review staged changes (default: simple mode, GitHub Models (free))
ghagga review

# Review with options
ghagga review --mode workflow --output json
```

Check your project's health score:

```bash
ghagga health
```

Optionally, install git hooks for automatic review on every commit:

```bash
ghagga hooks install
```

The CLI also includes a local memory database that learns from your reviews. Use `ghagga memory list`, `ghagga memory search <query>`, and `ghagga memory stats` to inspect stored observations. See [CLI](cli.md) for all options, memory subcommands, and config file support.

## Self-Hosted (Docker)

Full deployment with PostgreSQL, memory, and dashboard support.

```bash
git clone https://github.com/JNZader/ghagga.git
cd ghagga
cp .env.example .env
# Edit .env with your credentials
docker compose up -d
```

This starts PostgreSQL 16 on port 5432 and the GHAGGA Server (Hono) on port 3000 with static analysis tools pre-installed.

See [Self-Hosted](self-hosted.md) for full deployment details.

## SaaS Mode — Static Analysis Setup

If you're using the hosted GHAGGA SaaS, static analysis runs as an **inline GitHub Actions workflow** that the server injects into each target repository at `.github/workflows/ghagga.yml` (built from `templates/ghagga-inline.yml`).

> **Important**: After installing the GitHub App, you must configure an LLM provider in the [Dashboard](https://ghagga.javierzader.com/app/) before reviews will work. See the [SaaS Getting Started Guide](saas-getting-started.md) for the full setup flow.

> **Auth note**: The dashboard signs in with GitHub OAuth Web Flow. That login is separate from GitHub Models credentials in SaaS/server mode.

There is nothing to enable manually for static analysis — on each PR review, the server:

1. PUTs `.github/workflows/ghagga.yml` into your repo (if it's missing or out-of-date).
2. Triggers `workflow_dispatch` with a per-dispatch HMAC callback secret.
3. Receives the signed callback at `/runner/callback` and merges the findings into the AI review.

The workflow uses your repo's own GitHub Actions minutes (unlimited on public repos). If injection is blocked by branch protection or missing permissions, the server falls back to LLM-only review — no hard failure.

See [Architecture — Inline Static-Analysis Workflow](architecture.md#inline-static-analysis-workflow) for details.

## BYOK — Bring Your Own Key

> **Mode note**: GHAGGA is free and open source, but GitHub Models auth differs by mode. SaaS/server mode needs a PAT with `models:read`; CLI and GitHub Action mode can use the GitHub token you already control.

GHAGGA never sees or stores your keys in plaintext. They're encrypted with AES-256-GCM at rest. You bring your own API key from any supported provider:

| Provider | Default Model |
|----------|--------------|
| GitHub Models | `gpt-4o-mini` |
| Anthropic | `claude-sonnet-4-20250514` |
| OpenAI | `gpt-4o` |
| Google | `gemini-2.5-flash` |
| Ollama | `qwen2.5-coder:7b` |
| Qwen | `qwen-coder-plus` |
| Groq | `llama-3.3-70b-versatile` |
| Cerebras | `llama-3.3-70b` |
| DeepSeek | `deepseek-chat` |
| OpenRouter | `deepseek/deepseek-chat` |

Static analysis tools (Semgrep, Trivy, CPD) are always free — they run on GitHub Actions runners (unlimited free minutes for public repos).
