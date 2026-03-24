# Getting Started with GHAGGA (SaaS / GitHub App)

Go from zero to your first AI code review in under 5 minutes. This guide walks you through installing the GHAGGA GitHub App, configuring your LLM provider in the [Dashboard](https://ghagga.javierzader.com/app/), and getting your first review on a Pull Request.

## Prerequisites

- A **GitHub account**
- A repository (public or private) with at least one open Pull Request — or the ability to create one
- A modern web browser (for the Dashboard)

> **Not looking for SaaS?** If you need CI/CD integration, try the [GitHub Action](github-action.md). For local terminal reviews, see the [CLI](cli.md). For full self-hosted control, see the [Self-Hosted Guide](self-hosted.md).

---

## Step 1: Install the GitHub App

**[Install the GHAGGA GitHub App](https://github.com/apps/ghagga-review/installations/new)**

1. Click the link above — it opens the GitHub App installation page
2. Choose which repositories GHAGGA should have access to:
   - **All repositories** — GHAGGA reviews PRs on every repo in your account
   - **Only select repositories** — pick specific repos
3. Click **"Install"**

### What permissions does the App request?

| Permission | Access | Why |
|-----------|--------|-----|
| **Pull requests** | Read and write | Fetch PR diffs and post review comments |
| **Actions** | Write | Dispatch and manage runner workflows for static analysis |
| **Secrets** | Read and write | Store and retrieve encrypted LLM API keys per installation |
| **Metadata** | Read-only | List repositories (auto-selected by GitHub) |

> **Important**: After installing the App, reviews will **NOT** work until you configure at least one LLM provider in the [Dashboard](https://ghagga.javierzader.com/app/). Continue to Step 2.

---

## Step 2: Open the Dashboard

**[Open the GHAGGA Dashboard](https://ghagga.javierzader.com/app/)**

1. Click **"Login"** on the Dashboard
2. You'll be redirected to GitHub's **OAuth Web Flow** consent screen
3. Approve the GHAGGA OAuth app
4. GitHub redirects you back to the Dashboard and you are logged in

> **Tip**: The Dashboard uses GitHub Pages, but authentication is completed by the GHAGGA server via OAuth Web Flow. If the server is unavailable, the Dashboard falls back to manual PAT entry.

**Verification**: You should see the Dashboard home page with stats cards (they'll show zeros until your first review).

---

## Step 3: Configure Your LLM Provider

Navigate to **Dashboard** > **Settings** (or **Global Settings** for installation-wide defaults).

### Choose a provider

| Provider | Model | Cost | API Key Needed? | Notes |
|----------|-------|------|-----------------|-------|
| **GitHub Models** | `gpt-4o-mini` | GitHub-side pricing | Yes | In SaaS mode, add a PAT with `models:read`; dashboard OAuth alone is not enough for server-side reviews |
| Anthropic | `claude-sonnet-4-20250514` | BYOK | Yes | Highest quality reviews |
| OpenAI | `gpt-4o` | BYOK | Yes | Fast and capable |
| Google | `gemini-2.5-flash` | BYOK | Yes | Low cost per token |
| Ollama | `qwen2.5-coder:7b` | **Free** (local) | No | Requires local Ollama server |
| Qwen | `qwen-coder-plus` | BYOK | Yes | Alibaba Cloud |
| Groq | `llama-3.3-70b-versatile` | **Free** tier | Yes | Free tier, fast inference |
| Cerebras | `llama-3.3-70b` | **Free** tier | Yes | Ultra-fast (~3000 tok/s) |
| DeepSeek | `deepseek-chat` | Near-free ($0.004/day) | Yes | High quality, low cost |
| OpenRouter | `deepseek/deepseek-chat` | BYOK | Yes | Multi-model gateway |

### GitHub Models setup (server mode)

1. In **Settings**, select **"GitHub"** as the provider
2. Paste a GitHub Personal Access Token with `models:read`
3. Save the provider; the default model is `gpt-4o-mini`

> **Important**: The dashboard login token is used for dashboard/API access and runner setup. Reviews triggered by the SaaS server run with GitHub App installation credentials, so GitHub Models needs its own PAT in the provider chain.

### BYOK setup (Bring Your Own Key)

1. In **Settings**, select your preferred provider (e.g., "Anthropic")
2. Paste your API key in the **"API Key"** field
3. Click **"Save"**

> **Security**: API keys are encrypted with **AES-256-GCM** at rest. GHAGGA never stores or logs your keys in plaintext. You can rotate or delete keys at any time from Settings.

**Verification**: The Settings page should show your selected provider with a green status indicator.

---

## Step 4: Enable the Runner (Optional)

The Runner enables **static analysis** (Semgrep for security, Trivy for vulnerabilities, CPD for code duplication) alongside the AI review. Without it, reviews are LLM-only — still useful, but without Layer 0 static findings.

1. Go to **Dashboard** > **Global Settings**
2. Click **"Enable Runner"** in the Static Analysis Runner card
3. A public repository named `ghagga-runner` will be created in your GitHub account from the [official template](https://github.com/JNZader/ghagga-runner-template)

> **Note**: If your GitHub OAuth token was created before the `public_repo` scope was added, you'll be prompted to re-authenticate. This is a **one-time** step.

**What the runner provides**:

| Component | Without Runner | With Runner |
|-----------|---------------|-------------|
| AI review (LLM analysis) | Yes | Yes |
| Static analysis (16 tools) | No | Yes |

The runner provides access to the full 16-tool plugin registry: Semgrep, Trivy, CPD, Gitleaks, ShellCheck, markdownlint, Lizard, Ruff, Bandit, golangci-lint, Biome, PMD, Psalm, clippy, Hadolint, and zizmor. Tools are automatically selected based on the detected tech stack in your PR.

The runner uses **GitHub Actions free minutes** (unlimited for public repos, 7GB RAM per run). First run takes ~3-5 minutes (tool installation); subsequent runs take ~18 seconds (cached).

**Verification**: Check your GitHub account — you should see a new public repo named `ghagga-runner`.

---

## Step 5: Open a PR and Get Your First Review

1. Create a new Pull Request (or push a commit to an existing one) on a repository where you installed the App
2. Wait **~1-2 minutes** for the review to arrive

### What to expect

GHAGGA posts a **review comment** on your PR with:

- **Status**: `PASSED`, `FAILED`, `NEEDS_HUMAN_REVIEW`, or `SKIPPED`
- **Summary**: A brief overview of the changes
- **Findings**: Individual issues with severity (Critical, High, Medium, Low, Info), description, file location, and suggested fix
- **Static analysis results** (if runner is enabled): Security vulnerabilities, known CVEs, duplicated code

> **Tip**: You can re-trigger a review at any time by commenting `ghagga review` on the PR.

**Verification**: You should see a comment from the GHAGGA bot on your Pull Request.

---

## What Just Happened?

Here's what GHAGGA did when you opened that PR:

```mermaid
sequenceDiagram
    participant You as Your PR
    participant App as GitHub App
    participant Server as GHAGGA Server
    participant Runner as ghagga-runner
    participant LLM as LLM Provider

    You->>App: PR opened/updated
    App->>Server: Webhook event
    Server->>Server: Parse diff, detect stack
    alt Runner enabled
        Server->>Runner: Dispatch static analysis
        Runner->>Runner: Static analysis (16 tools)
        Runner->>Server: Callback with findings
    end
    Server->>LLM: Diff + findings + memory
    LLM->>Server: Structured review
    Server->>You: PR comment posted
    Server->>Server: Extract & persist observations
```

1. GitHub sends a **webhook** to the GHAGGA server when your PR is opened or updated
2. The server **parses the diff**, detects the tech stack, and checks your token budget
3. If the runner is enabled, it **dispatches static analysis** to your `ghagga-runner` repo (16 tools via plugin registry)
4. The server sends the diff + static findings + project memory to your configured **LLM provider**
5. The LLM returns a structured review, which is **posted as a PR comment**
6. Observations from the review are **extracted and stored** in project memory for future reviews

---

## What Happens Without Configuration

| State | What you get |
|-------|-------------|
| App installed, **no LLM provider configured** | No review comment posted — the server has no AI provider to analyze the diff |
| App installed, **LLM configured, no runner** | AI-only review — findings from the LLM but no static analysis (no Semgrep/Trivy/CPD) |
| App installed, **LLM configured, runner enabled** | Full review — static analysis findings + AI review + project memory |

---

## Troubleshooting

### No review comment posted

1. **Check your LLM provider**: Go to [Dashboard](https://ghagga.javierzader.com/app/) > Settings and verify a provider is configured with a valid API key. For **GitHub Models** in SaaS mode, that means a PAT with `models:read`.
2. **Check the App is installed on that repo**: Go to your GitHub Settings > Applications > GHAGGA > Configure — make sure the repo is in the list
3. **Check the PR is on the right event type**: GHAGGA triggers on `opened`, `synchronize`, and `reopened` events. Draft PRs may not trigger reviews depending on your config.

### Review comment is empty or minimal

- **Enable the runner** for static analysis findings — without it, the review relies entirely on the LLM
- **Check your review mode**: Try `workflow` mode (5 specialist agents) in Settings for more thorough reviews
- **Small diffs may produce minimal reviews** — this is expected for trivial changes

### Runner not discovered

- The runner repo **must be named exactly `ghagga-runner`** in your GitHub account
- The runner repo **must be public** (GitHub Actions free minutes require public repos)
- If you created the runner manually, ensure it was created from the [official template](https://github.com/JNZader/ghagga-runner-template)

### OAuth re-authentication prompt

If clicking "Enable Runner" triggers a re-authentication prompt, this means your GitHub token needs the `public_repo` scope to create the runner repository. This is a **one-time** step — authorize the additional scope and the runner will be created. See the [security documentation](security.md) for details on OAuth scopes and token handling.

---

## Cost Summary

| Component | Cost |
|-----------|------|
| **GHAGGA** | Free and open source (MIT license) |
| **Hosted SaaS** | Free to use |
| **GitHub Models** (`gpt-4o-mini`) | Requires your own PAT with `models:read` in SaaS/server mode |
| **Other LLM providers** (Anthropic, OpenAI, Google, Qwen) | BYOK — you pay those providers directly at their standard rates |
| **Ollama** | Free — runs on your own machine |
| **Static analysis** (Semgrep, Trivy, CPD) | Free — runs on GitHub Actions runners (unlimited free minutes for public repos) |

---

## Step 6: Configure Delegated CI (Optional)

Delegated CI allows GHAGGA to run your CI jobs (lint, tests) on Pull Requests without you needing to set up GitHub Actions workflows in your repository.

1. Go to **Dashboard → Settings → [Select Repository] → Delegated CI**
2. Toggle **"Enabled"** to create a policy
3. Click **"+ Add Job"** to configure lint or test jobs
4. Select an execution profile (Node.js Lint, Python Pytest, Go Test, etc.)
5. Click **"Save Settings"**

See the **[Delegated CI Guide](delegated-ci.md)** for detailed configuration, security model, and troubleshooting.

---

## Next Steps

- **[Delegated CI](delegated-ci.md)** — Run lint/tests on PRs without repo workflows
- **[Review Modes](review-modes.md)** — Learn about Simple, Workflow, and Consensus modes
- **[Memory System](memory-system.md)** — How GHAGGA learns from past reviews
- **[Configuration](configuration.md)** — Environment variables and config file options
- **[Runner Architecture](runner-architecture.md)** — Deep dive into delegated static analysis
- **[Static Analysis](static-analysis.md)** — Semgrep rules, Trivy scanning, CPD detection
