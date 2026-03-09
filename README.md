<p align="center">
  <img src="assets/logo.svg" alt="GHAGGA Logo — AI-powered code review with static analysis" width="200" height="200" />
</p>

# GHAGGA — AI-Powered Code Review

> Inspired by [Gentleman Guardian Angel (GGA)](https://github.com/Gentleman-Programming/gentleman-guardian-angel) and [Engram](https://github.com/Gentleman-Programming/engram), two projects by [Gentleman Programming](https://youtube.com/@GentlemanProgramming).

**Multi-agent code reviewer** that posts intelligent comments on your Pull Requests. Combines LLM analysis with up to 15 static analysis tools and project memory that learns across reviews.

**[Website](https://jnzader.github.io/ghagga/)** · **[Documentation](https://jnzader.github.io/ghagga/docs/)** · **[Dashboard](https://jnzader.github.io/ghagga/app/)**

## Table of Contents

- [What is this?](#what-is-this)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Review Modes](#review-modes)
- [Static Analysis](#static-analysis)
- [Runner Architecture](#runner-architecture)
- [Memory System](#memory-system)
- [Dashboard](#dashboard)
- [Security](#security)
- [Monorepo Structure](#monorepo-structure)
- [Configuration](#configuration)
- [Development](#development)
- [Tech Stack](#tech-stack)
- [What changed from v1](#what-changed-from-v1)
- [License](#license)

---

## What is this?

GHAGGA is an AI code review tool that:

1. **Receives** a PR diff (via webhook, CLI, or GitHub Action)
2. **Scans** it with static analysis tools — zero LLM tokens for known issues
3. **Searches** project memory for past decisions, patterns, and bug fixes
4. **Sends** the diff + static analysis context + memory to AI agents
5. **Posts** a structured review comment on the PR with findings, severity, and suggestions
6. **Learns** by extracting observations from the review and storing them for next time

You bring your own API key (BYOK). GHAGGA never sees or stores your keys in plaintext — they're encrypted with AES-256-GCM at rest.

### Key Features

| Feature | Description |
|---------|-------------|
| **3 Review Modes** | Simple (single LLM), Workflow (5 specialist agents), Consensus (multi-model voting) |
| **15 Static Analysis Tools** | Semgrep, Trivy, CPD, Gitleaks, ShellCheck, markdownlint, Lizard + 8 auto-detect tools — zero tokens |
| **Project Memory** | Learns patterns, decisions, and bug fixes across reviews (PostgreSQL + tsvector FTS) |
| **Multi-Provider** | 6 providers: GitHub Models, Anthropic, OpenAI, Google, Ollama (local), Qwen (Alibaba). **Mode note**: SaaS/server mode needs a PAT with `models:read` for GitHub Models; CLI and GitHub Action mode can use the GitHub token you already control. |
| **3 Distribution Modes** | SaaS, GitHub Action, CLI |
| **Pagination** | Full GitHub API pagination for PRs with >100 files/commits — no silent truncation |
| **Comment Trigger** | Type `ghagga review` on any PR to re-trigger a review on demand |
| **Dashboard** | React SPA on GitHub Pages — review history, stats, settings, memory browser |
| **BYOK Security** | AES-256-GCM encryption, HMAC-SHA256 webhook verification, privacy stripping |

---

## Quick Start

### Option 0: GitHub App (SaaS) — ⭐ Recommended

The easiest way to get started. Install the App, configure in the Dashboard, get reviews.

1. **[Install the GHAGGA GitHub App](https://github.com/apps/ghagga-review/installations/new)** on your repositories
2. **[Open the Dashboard](https://jnzader.github.io/ghagga/app/)** and log in with GitHub
3. **Configure your LLM provider** — in SaaS mode, GitHub Models requires a PAT with `models:read`, or bring your own provider key
4. **Open a PR** — get an AI-powered review in ~1-2 minutes

> **Important**: After installing the App, reviews won't work until you configure an LLM provider in the [Dashboard](https://jnzader.github.io/ghagga/app/). See the [full SaaS guide](https://jnzader.github.io/ghagga/docs/#/saas-getting-started) for detailed steps.

---

### Option 1: GitHub Action (Free for Public Repos)

No server needed — runs directly in GitHub's infrastructure. 100% free for public repos with GitHub Models.

```yaml
# .github/workflows/ghagga.yml
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

#### Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider` | No | `github` | LLM provider: `github`, `anthropic`, `openai`, `google`, `ollama`, `qwen` |
| `model` | No | Auto | Model identifier (auto-selects best per provider) |
| `mode` | No | `simple` | Review mode: `simple`, `workflow`, `consensus` |
| `api-key` | No | — | LLM provider API key. Not required for `github` provider (free default). |
| `github-token` | No | `${{ github.token }}` | GitHub token for PR access. Automatic. |
| `enabled-tools` | No | — | Comma-separated list of tools to force-enable |
| `disabled-tools` | No | — | Comma-separated list of tools to force-disable |
| `enable-memory` | No | `true` | Enable SQLite review memory (cached across runs) |

#### Action Outputs

| Output | Description |
|--------|-------------|
| `status` | Review result: `PASSED`, `FAILED`, `NEEDS_HUMAN_REVIEW`, `SKIPPED` |
| `findings-count` | Number of findings detected |

> Static analysis tools (up to 15) run **directly on the GitHub Actions runner** — no server or Docker image required. First run installs tools (~3-5 min), subsequent runs use `@actions/cache` (~1-2 min).

> ⚠️ **FAILED status**: When the review finds critical issues, the Action calls `core.setFailed()` which fails the CI check. Add `continue-on-error: true` to the step for advisory-only (non-blocking) reviews. See the [full GitHub Action Guide](docs/github-action.md) for details.

📋 **[Full GitHub Action Guide](docs/github-action.md)** — Complete setup guide with provider examples, troubleshooting, and configuration reference.

### Option 2: CLI

Review local changes from your terminal. No server required.

```bash
# Install
npm install -g ghagga

# Login with GitHub (free, no API key needed)
ghagga login

# Review staged changes
ghagga review

# Review with options
ghagga review --mode workflow --provider openai --api-key sk-xxx
ghagga review --provider ollama --model qwen2.5-coder:7b

# Project health check
ghagga health
ghagga health ./src --top 5

# Manage review memory
ghagga memory list
ghagga memory search "error handling"
ghagga memory stats

# Install git hooks (optional)
ghagga hooks install
```

#### CLI Commands

| Command | Description |
|---------|-------------|
| `ghagga login` | Authenticate with GitHub (free AI models) |
| `ghagga logout` | Clear stored credentials |
| `ghagga status` | Show auth and configuration |
| `ghagga review [path]` | Review local code changes |
| `ghagga memory <subcommand>` | Inspect, search, and manage review memory (`list`, `search`, `show`, `delete`, `stats`, `clear`) |
| `ghagga hooks <subcommand>` | Install, uninstall, and check status of git hooks (`install`, `uninstall`, `status`) |
| `ghagga health [path]` | Run project health assessment with scoring, trends, and recommendations |

#### CLI Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `[path]` | — | `.` | Path to repository or subdirectory |
| `--mode <mode>` | `-m` | `simple` | Review mode: `simple`, `workflow`, `consensus` |
| `--provider <provider>` | `-p` | `github` | LLM provider: `github`, `anthropic`, `openai`, `google`, `ollama`, `qwen` |
| `--model <model>` | — | Auto | Model identifier (or `GHAGGA_MODEL` env var) |
| `--api-key <key>` | — | — | API key (or `GHAGGA_API_KEY` env var) |
| `--output <format>` | `-o` | `markdown` | Output format: `markdown`, `json`, `sarif` |
| `--format <format>` | `-f` | — | **Deprecated** — use `--output`. Output format |
| `--enhance` | — | — | AI-powered post-analysis enhancement (groups findings, adds fix suggestions) |
| `--issue <target>` | — | — | Create (`new`) or update (`<number>`) a GitHub issue with review results |
| `--enable-tool <name>` | — | — | Force-enable a specific tool |
| `--disable-tool <name>` | — | — | Force-disable a specific tool |
| `--list-tools` | — | — | Show all 15 tools with status |
| `--no-memory` | — | — | Disable review memory |
| `--staged` | — | — | Review only staged files (for pre-commit hook usage) |
| `--quick` | — | — | Static analysis only, skip AI review (~5-10s vs ~30-60s) |
| `--commit-msg <file>` | — | — | Validate commit message from file |
| `--exit-on-issues` | — | — | Exit with code 1 if critical/high issues found |
| `--memory-backend <type>` | — | `sqlite` | Memory backend: `sqlite` or `engram` |
| `--plain` | — | — | Disable styled terminal output (auto-enabled in non-TTY/CI) |
| `--config <path>` | `-c` | `.ghagga.json` | Path to config file |
| `--verbose` | `-v` | — | Show real-time progress of each pipeline step |

#### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Review passed or was skipped |
| `1` | Review failed or needs human review |

#### Config File (`.ghagga.json`)

Place a `.ghagga.json` in your repo root for project-level defaults:

```json
{
  "mode": "workflow",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "enabledTools": ["ruff", "bandit"],
  "disabledTools": ["markdownlint"],
  "customRules": [".semgrep/custom-rules.yml"],
  "ignorePatterns": ["*.test.ts", "*.spec.ts", "docs/**"],
  "reviewLevel": "strict"
}
```

Use `--config` to point to a specific config file: `ghagga review --config .ghagga.json`

Priority: CLI flags > config file > env vars > defaults.

📋 **[Full CLI Guide](docs/cli.md)** — Complete setup guide with all commands, provider examples, and troubleshooting.

### Option 3: Self-Hosted (Docker)

Full deployment with PostgreSQL, memory, and dashboard support.

```bash
# Clone
git clone https://github.com/JNZader/ghagga.git
cd ghagga

# Configure
cp .env.example .env
# Edit .env with your credentials (see Configuration section below)

# Start
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port 5432 with health checks
- **GHAGGA Server** (Hono) on port 3000 with static analysis tools pre-installed

---

## Architecture

```mermaid
graph TB
  subgraph Distribution["Distribution Layer"]
    Server["Server<br/>Hono"]
    Action["Action<br/>GitHub Action"]
    CLI["CLI"]
  end

  subgraph Runner["Delegated Runner"]
    RunnerRepo["ghagga-runner<br/>GitHub Actions"]
    RunnerTools["Static Analysis Tools<br/>7GB RAM"]
  end

  subgraph Core["@ghagga/core"]
    SA["Static Analysis<br/>15-tool registry"]
    Agents["AI Agents<br/>Simple · Workflow · Consensus"]
    Memory["Memory<br/>Search · Persist · Privacy"]
  end

  subgraph DB["@ghagga/db"]
    PG["PostgreSQL<br/>+ tsvector"]
    Drizzle["Drizzle ORM<br/>+ Migrations"]
    Crypto["AES-256-GCM<br/>Encryption"]
  end

  Server -- "workflow_dispatch" --> RunnerRepo
  RunnerRepo --> RunnerTools
  RunnerTools -- "callback" --> Server

  Server --> Core
  Action --> Core
  CLI --> Core
  Core --> DB
```

### Core + Adapters Pattern

The review engine (`@ghagga/core`) knows **nothing** about HTTP, webhooks, or CLI. It receives a diff + config, runs analysis, orchestrates agents, and returns a structured result.

Each distribution mode (`apps/*`) is a thin adapter:

| Adapter | Input | Output | Memory | Static Analysis |
|---------|-------|--------|--------|----------------|
| **Server** | GitHub webhook | PR comment via GitHub API | Yes (PostgreSQL) | Delegated to runner |
| **Action** | PR event in GitHub Actions | PR comment via Octokit | Yes (SQLite) | Direct on runner |
| **CLI** | Local `git diff` | Terminal output (markdown/json/sarif) | Yes (SQLite) | If installed locally |

### Review Pipeline

Every review follows the same pipeline regardless of distribution mode:

```mermaid
flowchart LR
  Input["Input<br/>diff + config"] --> S1["Validate"]
  S1 --> S2["Parse &<br/>Filter Diff"]
  S2 --> S3["Detect<br/>Stacks"]
  S3 --> S4["Token<br/>Budget"]
  S4 --> S5["Static Analysis<br/>+ Memory Search"]
  S5 --> S6["AI Agent<br/>Execution"]
  S6 --> S7["Merge<br/>Findings"]
  S7 --> S8["Persist<br/>Memory"]
  S8 --> Output["ReviewResult"]
```

Each step degrades gracefully — if static analysis fails, or memory is unavailable, the pipeline continues with what it has.

---

## Review Modes

### Simple Mode

Single LLM call with a comprehensive system prompt. Best for small-to-medium PRs.

```mermaid
flowchart LR
  Input["Diff + Static Analysis<br/>+ Memory + Stack Hints"] --> LLM["1 LLM Call"]
  LLM --> Output["STATUS / SUMMARY / FINDINGS"]
```

**Token usage**: ~1x (one call)
**Best for**: Quick reviews, small PRs, low token budget

### Workflow Mode

5 specialist agents run **in parallel**, then a synthesis step merges their findings.

```mermaid
flowchart LR
  Input["Diff + Context"] --> S1["Scope Analysis"]
  Input --> S2["Coding Standards"]
  Input --> S3["Error Handling"]
  Input --> S4["Security Audit"]
  Input --> S5["Performance"]
  S1 --> Synth["Synthesis<br/>merge + deduplicate"]
  S2 --> Synth
  S3 --> Synth
  S4 --> Synth
  S5 --> Synth
  Synth --> Output["Structured Response"]
```

**Token usage**: ~6x (5 specialists + 1 synthesis)
**Best for**: Thorough reviews, large PRs, when you want focused analysis per area

### Consensus Mode

Multiple models review with assigned stances (for/against/neutral), then a weighted vote determines the outcome.

```mermaid
flowchart LR
  Input["Diff + Context"] --> A["Advocate<br/>looks for good"]
  Input --> C["Critic<br/>looks for problems"]
  Input --> O["Observer<br/>balanced view"]
  A --> Vote["Weighted Vote"]
  C --> Vote
  O --> Vote
  Vote --> Status["Final STATUS"]
```

**Token usage**: ~3x (3 stances)
**Best for**: Critical code paths, high-confidence decisions, security-sensitive changes

---

## Static Analysis

Layer 0 analysis runs **before** any LLM call. Zero tokens consumed. Known issues are injected into agent prompts so the AI focuses on logic, architecture, and things static analysis can't detect.

GHAGGA supports **15 static analysis tools** across 5 categories, organized into two tiers:

- **7 always-on tools** run on every review: Semgrep (security), Trivy (SCA), CPD (duplication), Gitleaks (secrets), ShellCheck (shell lint), markdownlint (docs lint), Lizard (complexity)
- **8 auto-detect tools** activate when matching files are in the diff: Ruff (Python), Bandit (Python security), golangci-lint (Go), Biome (JS/TS), PMD (Java), Psalm (PHP), clippy (Rust), Hadolint (Docker)

> See [Static Analysis](docs/static-analysis.md) for the full tool table, tier system, and per-tool control.

### Graceful Degradation

Tools are optional. If a tool isn't installed, it's silently skipped. The review continues with whatever tools are available.

| Distribution | Tools Available | How |
|-------------|---------------|-----|
| Docker (server) | All pre-installed | Included in Docker image |
| GitHub Action (node20) | All auto-installed + cached | `@actions/cache` on runner |
| CLI | If installed locally | Uses local binaries |

> The GitHub Action installs tools directly on the `ubuntu-latest` runner and caches binaries with `@actions/cache`. First run takes ~3-5 minutes (installation); subsequent runs use cache (~1-2 minutes). Tool failures degrade gracefully — the review continues with whatever tools succeed.

### Custom Semgrep Rules

GHAGGA ships with 20 security rules in `packages/core/src/tools/semgrep-rules.yml`. You can add custom rules via the `customRules` config option:

```json
{
  "customRules": [".semgrep/my-rules.yml"]
}
```

---

## Runner Architecture

> SaaS mode only. GitHub Action and CLI run tools directly.

The Render free tier (512MB RAM) can't run all static analysis tools simultaneously. GHAGGA solves this by delegating static analysis to **user-owned GitHub Actions runners** on public repos (unlimited free minutes, 7GB RAM).

### How It Works

1. **Setup**: User creates a public repo from the [`ghagga-runner-template`](https://github.com/JNZader/ghagga-runner-template)
2. **Discovery**: Server checks if `{owner}/ghagga-runner` exists (convention-based, GET → 200/404)
3. **Secret**: Server sets a per-dispatch HMAC secret on the runner repo via GitHub API
4. **Dispatch**: Server triggers `workflow_dispatch` with 10 inputs (repo, PR, SHA, callback URL, tools config)
5. **Execution**: Runner installs/caches static analysis tools and runs analysis (~18 seconds)
6. **Callback**: Runner POSTs results to `POST /runner/callback` with HMAC-SHA256 signature
7. **Merge**: Server merges static findings with AI review and posts the combined comment

### Security Model

Private repo code analyzed via public runner is protected by **4 security layers**:

| Layer | Protection |
|-------|-----------|
| **Output suppression** | All tool output redirected to `/dev/null` — nothing in workflow logs |
| **Log masking** | `::add-mask::` applied to all sensitive values |
| **Log deletion** | Workflow run logs deleted via GitHub API after completion |
| **Retention policy** | Runner repo configured with 1-day log retention |

Each dispatch generates a unique `callbackSecret` stored in an in-memory Map with 11-minute TTL. HMAC-SHA256 verification ensures only the legitimate runner can deliver results.

### Graceful Fallback

If no runner repo is discovered, the server falls back to **LLM-only review** (no static analysis). The review still works — it just skips Layer 0.

---

## Memory System

GHAGGA learns from past reviews using PostgreSQL full-text search. Design patterns inspired by [Engram](https://github.com/Gentleman-Programming/engram) (session model, topic-key upserts, deduplication, privacy stripping) — implemented directly in PostgreSQL for multi-tenancy and scalability.

### How It Works

1. **After each review**, observations are automatically extracted (decisions, patterns, bugs, learnings)
2. **Deduplication** prevents storing the same observation twice (content hash + 15-minute rolling window)
3. **Topic-key upserts** evolve existing knowledge instead of creating duplicates
4. **Before each review**, relevant observations are retrieved via tsvector full-text search and injected into agent prompts
5. **Privacy stripping** removes API keys, tokens, and secrets before anything is stored

### Observation Types

| Type | Description | Example |
|------|-------------|---------|
| `decision` | Architecture and design choices | "Team decided to use Zustand over Redux for state management" |
| `pattern` | Code patterns and conventions | "All API routes use zod validation middleware" |
| `bugfix` | Common errors and their fixes | "React useEffect cleanup missing causes memory leak in Dashboard" |
| `learning` | General project knowledge | "The billing module uses Stripe webhooks for payment confirmation" |
| `architecture` | System design decisions | "Microservices communicate via event bus, not direct HTTP" |
| `config` | Configuration patterns | "Environment-specific configs are in /config/{env}.ts" |
| `discovery` | Codebase discoveries | "Legacy auth module in /lib/auth is deprecated, use /modules/auth" |

### Privacy Stripping

Before any observation is stored in memory, GHAGGA strips sensitive data using 16 regex patterns:

| Pattern | Example | Redacted As |
|---------|---------|-------------|
| Anthropic API keys | `sk-ant-api03-...` | `[REDACTED_ANTHROPIC_KEY]` |
| OpenAI API keys | `sk-proj-...` | `[REDACTED_OPENAI_KEY]` |
| AWS Access Key IDs | `AKIA...` | `[REDACTED_AWS_KEY]` |
| GitHub tokens | `ghp_...`, `gho_...`, `ghs_...`, `github_pat_...` | `[REDACTED_GITHUB_*]` |
| Google API keys | `AIza...` | `[REDACTED_GOOGLE_KEY]` |
| Slack tokens | `xoxb-...`, `xoxp-...` | `[REDACTED_SLACK_TOKEN]` |
| Bearer tokens | `Bearer eyJ...` | `Bearer [REDACTED_TOKEN]` |
| JWT tokens | `eyJ...eyJ...xxx` | `[REDACTED_JWT]` |
| PEM private keys | `-----BEGIN PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` |
| Password/secret assignments | `password = "..."` | `[REDACTED]` |
| Base64 credentials | `SECRET=aGVsbG8...` | `[REDACTED_BASE64]` |

> Memory is available in **all 3 distribution modes**: Server uses PostgreSQL + tsvector FTS, Action uses SQLite, and CLI uses SQLite by default with an optional [Engram](https://github.com/Gentleman-Programming/engram) backend (`--memory-backend engram`). The Engram backend connects via HTTP API and enables cross-tool memory sharing with Claude Code, OpenCode, Gemini CLI, and other Engram-compatible tools. If Engram is unreachable, the CLI falls back to SQLite automatically.

---

## Dashboard

React SPA deployed on GitHub Pages. Dark theme with GitHub-dark palette and purple accent.

**Live**: [https://jnzader.github.io/ghagga/app/](https://jnzader.github.io/ghagga/app/)

### Pages

| Page | Description |
|------|-------------|
| **Login** | GitHub OAuth Web Flow login with PAT fallback |
| **Dashboard** | 4 stat cards (total reviews, pass rate, avg findings, avg time) + Recharts area chart with review trends |
| **Reviews** | Filterable table with status badges, severity indicators, detail expansion, and pagination |
| **Settings** | Per-repo or global settings — provider chain, review mode, tools, ignore patterns |
| **Global Settings** | Installation-wide provider chain and defaults that apply to all repos |
| **Memory** | Observation list with severity badges, StatsBar (counts by type/project), session sidebar, delete/clear/purge actions (3-tier confirmation), ObservationDetailModal (PR links, file paths, revision count, relative timestamps), severity and sort filters |

### Tech Details

- React 19 + TypeScript + Vite
- TanStack Query 5 for data fetching and caching
- Recharts for data visualization
- Tailwind CSS 4 with dark theme
- HashRouter for GitHub Pages compatibility (no server-side routing needed)
- Code-split: lazy-loaded page components with vendor chunk splitting
- Base path: `/ghagga/app/` for GitHub Pages deployment

### Memory Management

The Memory page provides full CRUD management of review observations and sessions with a **3-tier confirmation system** for destructive actions:

| Tier | Action | Confirmation | Example |
|------|--------|-------------|---------|
| **Tier 1** | Delete single observation | Simple confirm modal | Delete one observation |
| **Tier 2** | Clear repo observations | Type repo name to confirm | Clear all observations for `owner/repo` |
| **Tier 3** | Purge ALL observations | Type "DELETE ALL" + 5-second countdown | Wipe entire memory database |

Additional management actions:
- **Delete sessions** — remove individual memory sessions
- **Clean up empty sessions** — remove sessions with no remaining observations

The **ObservationDetailModal** shows full observation details including PR links, file paths, revision count, and relative timestamps. All destructive actions trigger **Toast notifications** confirming success or failure.

---

## Security

| Measure | Implementation |
|---------|---------------|
| **API key encryption** | AES-256-GCM with per-installation encryption keys. Keys are never stored in plaintext. |
| **Webhook verification** | HMAC-SHA256 signature verification with `crypto.timingSafeEqual` (constant-time comparison to prevent timing attacks) |
| **JWT generation** | RS256 manual JWT construction for GitHub App installation tokens (no external JWT library needed) |
| **Privacy stripping** | 16 regex patterns remove API keys, tokens, passwords, and secrets before storing to memory |
| **No secret logging** | Console outputs and error messages never contain sensitive data (verified by automated security tests) |
| **BYOK model** | Users provide their own LLM API keys. GHAGGA never pays for or sees your LLM usage in plaintext. |
| **Installation scoping** | API routes are scoped by GitHub installation ID — users can only access their own repos |
| **HTTP timeouts** | All `fetch()` calls use `AbortSignal.timeout()` (10s/15s/5s) to prevent resource exhaustion |
| **Env validation (fail-fast)** | Server validates all required environment variables at startup, exiting immediately with a clear error if any are missing |
| **Error IDs** | All 500 responses include an `errorId` (8-char UUID) for support ticket correlation with server logs |
| **Correlation IDs** | Each review generates a `reviewId` propagated through webhook → Inngest → pipeline → PR comment for end-to-end tracing |
| **FK cascade delete** | All foreign keys use `ON DELETE CASCADE` to prevent orphaned data when installations are removed |
| **Dockerfile HEALTHCHECK** | Container health monitoring via Docker `HEALTHCHECK` instruction |

### Automated Security Tests

The test suite includes 14 dedicated security audit tests that verify:

- No `console.log` calls with sensitive variable names across the entire codebase
- No hardcoded API keys, tokens, or passwords in source files
- No use of `eval()` or `Function()` constructors
- AES-256-GCM encryption roundtrip correctness
- Tampered ciphertext detection
- `timingSafeEqual` usage for webhook signature comparison
- Privacy stripping covers all 16 secret patterns

---

## Monorepo Structure

```
ghagga/
├── packages/
│   ├── core/                  # @ghagga/core — Review engine
│   │   └── src/
│   │       ├── pipeline.ts        # Main orchestrator (validate → analyze → agent → persist)
│   │       ├── types.ts           # All TypeScript interfaces and types
│   │       ├── index.ts           # Public API exports
│   │       ├── agents/
│   │       │   ├── prompts.ts     # All agent prompts (rescued from v1)
│   │       │   ├── simple.ts      # Simple single-pass review
│   │       │   ├── workflow.ts    # 5-specialist parallel workflow
│   │       │   └── consensus.ts   # Multi-model voting
│   │       ├── tools/
│   │       │   ├── semgrep.ts     # Semgrep runner + JSON parser
│   │       │   ├── trivy.ts       # Trivy runner + JSON parser
│   │       │   ├── cpd.ts         # PMD/CPD runner + XML parser
│   │       │   ├── runner.ts      # Parallel orchestrator
│   │       │   └── semgrep-rules.yml  # 20 custom security rules
│   │       ├── memory/
│   │       │   ├── search.ts      # tsvector full-text search
│   │       │   ├── persist.ts     # Observation extraction + dedup
│   │       │   ├── context.ts     # Format observations as markdown
│   │       │   └── privacy.ts     # Privacy stripping (16 patterns)
│   │       ├── providers/
│   │       │   ├── index.ts       # Vercel AI SDK provider factory
│   │       │   └── fallback.ts    # Fallback chain with retry logic
│   │       └── utils/
│   │           ├── diff.ts        # Diff parsing, filtering, truncation
│   │           ├── stack-detect.ts # File extension → tech stack
│   │           └── token-budget.ts # Model-aware token allocation
│   │
│   └── db/                    # @ghagga/db — Database layer
│       └── src/
│           ├── schema.ts          # Drizzle table definitions (7 tables)
│           ├── client.ts          # Database connection factory
│           ├── crypto.ts          # AES-256-GCM encrypt/decrypt
│           ├── queries.ts         # All typed query functions
│           └── index.ts           # Re-exports
│
├── apps/
│   ├── server/                # @ghagga/server — Hono API
│   │   └── src/
│   │       ├── index.ts           # Hono app (CORS, health, webhook, Inngest, API)
│   │       ├── middleware/auth.ts  # GitHub PAT authentication middleware
│   │       ├── inngest/           # Durable review function (7 steps + runner dispatch)
│   │       ├── github/
│   │       │   ├── client.ts      # GitHub API client (diff, comment, verify, JWT)
│   │       │   └── runner.ts      # Runner discovery, secret setup, dispatch
│   │       ├── routes/
│   │       │   ├── runner-callback.ts # POST /runner/callback (HMAC verification)
│   │       │   └── ...               # Webhook + 8 REST API endpoints
│   │
│   ├── dashboard/             # @ghagga/dashboard — React SPA
│   │   └── src/
│   │       ├── App.tsx            # HashRouter with lazy-loaded routes
│   │       ├── lib/               # API hooks, auth context, utilities
│   │       ├── components/        # Layout, Card, StatusBadge, SeverityBadge,
│   │       │   │                  #   ConfirmDialog (3-tier), Toast, ObservationDetailModal
│   │       │   ├── ConfirmDialog.tsx      # 3-tier destructive action confirmation
│   │       │   ├── Toast.tsx              # Non-blocking success/error notifications
│   │       │   └── ObservationDetailModal.tsx  # Full observation detail with PR links
│   │       └── pages/             # Login, Dashboard, Reviews, Settings, Memory
│   │
│   ├── cli/                   # ghagga — CLI tool
│   │   └── src/
│   │       ├── index.ts           # Commander entry point
│   │       ├── commands/
│   │       │   ├── review.ts      # Git diff → pipeline → output
│   │       │   ├── review-commit-msg.ts  # Commit message validation
│   │       │   ├── hooks/         # Git hooks management
│   │       │   │   ├── index.ts   # Hooks command group
│   │       │   │   ├── install.ts # Install pre-commit/commit-msg hooks
│   │       │   │   ├── uninstall.ts # Remove GHAGGA-managed hooks
│   │       │   │   └── status.ts  # Show hook status
│   │       │   └── memory/        # Memory management subcommands
│   │       │       ├── list.ts    # List observations (with filters)
│   │       │       ├── search.ts  # Full-text search across memory
│   │       │       ├── show.ts    # Show observation/session detail
│   │       │       ├── delete.ts  # Delete observation or session
│   │       │       ├── stats.ts   # Memory statistics by type/repo
│   │       │       ├── clear.ts   # Clear repo or all observations
│   │       │       └── utils.ts   # Shared formatting helpers
│   │       └── ui/                # Terminal UI components
│   │           ├── tui.ts         # Interactive TUI renderer
│   │           ├── theme.ts       # Color theme and styling
│   │           └── format.ts      # Output formatters (table, json)
│   │
│   └── action/                # @ghagga/action — GitHub Action
│       ├── action.yml             # Action definition (node20 runtime)
│       ├── Dockerfile             # Docker variant with static analysis tools
│       └── src/index.ts           # Fetch diff → pipeline → comment
│
├── templates/                 # Runner dispatch templates
│   ├── ghagga-analysis.yml       # GitHub Actions workflow for static analysis
│   └── ghagga-runner-README.md   # Template repo README
│
├── landing/                   # Marketing landing page
│   └── index.html                # Static HTML (GitHub Pages)
│
├── docs/                      # Documentation site (Docsify)
│   ├── index.html                # Docsify configuration
│   ├── _sidebar.md               # Navigation structure
│   └── *.md                      # Documentation pages
│
├── openspec/                  # Spec-Driven Development artifacts
│   └── changes/ghagga-v2-rewrite/
│       ├── proposal.md            # Full rewrite proposal
│       ├── design.md              # Architecture decisions
│       ├── tasks.md               # 10 phases, tracked tasks
│       └── specs/                 # Detailed specs per module
│
├── Dockerfile                 # Multi-stage build (static analysis tools pre-installed)
├── docker-compose.yml         # PostgreSQL + server for local dev
├── render.yaml                # Render Blueprint for SaaS deployment
├── .github/workflows/
│   ├── ci.yml                 # Typecheck + build + test pipeline
│   └── deploy-pages.yml       # Auto-deploy dashboard to GitHub Pages
└── README.md
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Server only | PostgreSQL connection string |
| `GITHUB_APP_ID` | Server only | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Server only | Base64-encoded `.pem` file content |
| `GITHUB_WEBHOOK_SECRET` | Server only | Secret configured in GitHub App webhook settings |
| `INNGEST_EVENT_KEY` | Server only | Inngest event ingestion key |
| `INNGEST_SIGNING_KEY` | Server only | Inngest webhook signing key |
| `ENCRYPTION_KEY` | Server only | 64-character hex string for AES-256-GCM encryption |
| `GHAGGA_MEMORY_BACKEND` | CLI only | Memory backend: `sqlite` (default) or `engram` |
| `GHAGGA_ENGRAM_HOST` | CLI only | Engram server URL (default: `http://localhost:7437`) |
| `GHAGGA_ENGRAM_TIMEOUT` | CLI only | Engram connection timeout in seconds (default: `5`) |
| `CALLBACK_TTL_MINUTES` | No | Runner callback secret TTL in minutes (default: `11`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` or `production` |

### Default Models

| Provider | Default Model |
|----------|--------------|
| GitHub Models | `gpt-4o-mini` |
| Anthropic | `claude-sonnet-4-20250514` |
| OpenAI | `gpt-4o` |
| Google | `gemini-2.5-flash` |
| Ollama | `qwen2.5-coder:7b` |
| Qwen | `qwen-coder-plus` |

### Token Budget

The diff is automatically truncated to fit each model's context window using a 70/30 split:

| Allocation | Percentage | Purpose |
|-----------|-----------|---------|
| Diff content | 70% | The actual code changes |
| Agent prompts + context | 30% | System prompt, static analysis, memory, stack hints |

---

## Development

### Prerequisites

- **Node.js** 22+
- **pnpm** 9+ (exact version managed via `packageManager` in package.json)
- **PostgreSQL** 16+ (or use Docker)

### Setup

```bash
# Clone and install
git clone https://github.com/JNZader/ghagga.git
cd ghagga
pnpm install

# Start PostgreSQL (via Docker)
docker compose up postgres -d

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
pnpm --filter @ghagga/db db:push

# Start development server
pnpm --filter @ghagga/server dev

# Start dashboard dev server (in another terminal)
pnpm --filter @ghagga/dashboard dev
```

### Commands

```bash
pnpm exec turbo typecheck    # Typecheck all packages
pnpm exec turbo build         # Build all packages
pnpm exec turbo test          # Run all ~2,859 tests
```

### Test Suite

~2,859 tests across 8 packages. All passing. 4 audit rounds completed (62 improvements).

| Package | Tests | What's Covered |
|---------|------:|----------------|
| `@ghagga/core` | 1,328 | Pipeline, diff parsing, stack detection, token budget, prompts, agents (simple, workflow, consensus), fallback provider, privacy, memory (search, persist, context), static analysis tools (semgrep, trivy, cpd), parsers, security audit, review calibration, Engram memory adapter, circuit breaker |
| `@ghagga/db` | 118 | Queries (CRUD, effective settings, provider chain), AES-256-GCM crypto (roundtrip, tamper, edge cases), index verification |
| `@ghagga/server` | 523 | API routes (6 domain modules), webhook handlers, auth middleware + token cache, provider validation, Inngest review function, GitHub client, runner dispatch, callback verification, graceful shutdown, health checks, correlation IDs, error IDs, HTTP timeouts, env validation, Zod negative tests |
| `ghagga` (CLI) | 272 | Config resolution, review command — input validation, output formatting, exit codes, git hooks (install, uninstall, status) |
| `@ghagga/action` | 195 | Input parsing, output setting, comment formatting, error handling, tool installation, cache management |
| `@ghagga/dashboard` | 342 | Component rendering, ErrorBoundary, a11y (7 axe tests), focus trap, virtual scrolling |
| `@ghagga/types` | 24 | Shared API type exports and contract validation |
| E2E | 14 | Webhook→pipeline→comment, CLI review flow, Action review flow |

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Monorepo** | pnpm workspaces + Turborepo | Fast installs, parallel builds, caching |
| **Language** | TypeScript 5.7 (strict mode) | Type safety across all packages |
| **Backend** | Hono 4 | Fastest TS framework, 14KB, runs anywhere |
| **Database** | PostgreSQL 16 + Drizzle ORM | Zero-overhead SQL, tsvector FTS, plain TS migrations |
| **AI** | Vercel AI SDK 6 | Multi-provider (6 providers), streaming, structured output, fallback chains |
| **Async** | Inngest 3 | Zero-infra durable functions, step checkpointing, automatic retries |
| **Frontend** | React 19 + Vite + Tailwind 4 | Lazy-loaded routes, vendor splitting, dark theme |
| **Data Fetching** | TanStack Query 5 | Caching, background refetching, optimistic updates |
| **Charts** | Recharts 2 | Composable React chart components |
| **UI Patterns** | ConfirmDialog (3-tier) + Toast | Tiered destructive action safety, non-blocking notifications |
| **CLI** | Commander 13 | Standard CLI framework for Node.js |
| **Testing** | Vitest 4 | Fast, ESM-native, compatible with Jest API |
| **Static Analysis** | 15-tool plugin registry | Security, SCA, duplication, linting, complexity — zero tokens |
| **Encryption** | Node.js `crypto` (AES-256-GCM) | No external dependencies for cryptographic operations |

### Why These Choices

- **Vercel AI SDK over LangGraph/agentlib**: GHAGGA's review flow is predictable (not a dynamic graph). AI SDK gives multi-provider support with less overhead. [agentlib](https://github.com/sammwy) was evaluated but is OpenAI only and has zero multi-agent support.
- **Hono over Express/Fastify**: 14KB, fastest benchmarks, runs on Node/Bun/Deno/Workers. Express is legacy, Fastify is heavier than needed.
- **Drizzle over Prisma**: Zero-overhead SQL, no binary dependencies, supports raw tsvector operations.
- **PostgreSQL memory over Engram**: Engram has great design patterns but no multi-tenancy, no auth, and is SQLite single-writer. We adopted its patterns (sessions, topic_key upserts, deduplication, privacy stripping) in PostgreSQL.
- **Inngest over BullMQ**: Zero infrastructure (no Redis). 50k events/month free. Step-based checkpointing means LLM retries don't re-run static analysis.

---

## What Changed from v1

GHAGGA v2 is a **complete rewrite** from scratch. The v1 codebase (~11,000 lines) is preserved on the `main-bkp` branch.

### What Was Wrong with v1

| Problem | Details |
|---------|---------|
| **Duplicate implementations** | TWO review flows: webhook inline handler AND a ReviewService class that was never called |
| **Dead code** | Hebbian Learning stored data but never consumed it. Threads, chunking, and embedding cache modules existed but were orphaned |
| **Heavy dependencies** | Required Supabase CLI, Docker, Deno runtime, and a separate Python microservice for Semgrep |
| **Hybrid search fallback** | Fell back to client-side filtering instead of using the SQL RPC function |
| **Complex deployment** | Multiple manual steps, multiple runtimes, multiple services |

### What Was Rescued from v1

| Component | Details |
|-----------|---------|
| **Agent prompts** | All system prompts (simple, 5 workflow specialists, synthesis, consensus stances) — battle-tested and well-designed |
| **Multi-provider abstraction** | Concept of supporting multiple LLM providers with fallback |
| **Crypto module** | AES-256-GCM encryption pattern for API keys |
| **Semgrep rules** | 20 custom security rules across 7+ languages |
| **Stack detection** | File extension → tech stack mapping for review hints |
| **Privacy stripping** | Pattern-based secret redaction before memory persistence |

### v1 vs v2 Comparison

| Aspect | v1 | v2 |
|--------|----|----|
| Lines of code | ~11,000 | ~6,000 (implementation) + ~3,000 (tests) |
| Runtime | Deno + Node.js + Python | Node.js only |
| Database | Supabase (hosted PostgreSQL) | Any PostgreSQL (self-hosted or cloud) |
| Deploy steps | 10+ manual steps | 3 env vars + `docker compose up` |
| Test suite | 0 tests | ~2,859 tests |
| Distribution modes | 1 (webhook only) | 3 (SaaS, Action, CLI) |
| Static analysis | Semgrep only (via microservice) | 15 tools via plugin registry (direct binary execution) |
| Memory | Partial (stored but never consumed) | Full pipeline (search → inject → review → extract → persist) |
| Dead code | ~40% of codebase | 0% |

---

## License

MIT — see [LICENSE](LICENSE) for details.
