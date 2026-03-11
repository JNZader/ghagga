# Configuration

> **Using the SaaS (GitHub App)?** Configure everything in the [Dashboard](https://jnzader.github.io/ghagga/app/) → Settings. The environment variables and config file below are for **CLI** and **self-hosted** deployments only.

## Environment Variables

### Server Mode

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | Base64-encoded `.pem` file content |
| `GITHUB_WEBHOOK_SECRET` | Yes | Secret configured in GitHub App webhook settings |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth App client ID override for dashboard login (defaults to the hosted public client ID) |
| `GITHUB_CLIENT_SECRET` | Conditionally | Required for dashboard OAuth Web Flow (`/auth/callback`) |
| `REDIS_URL` | No | Full Redis connection URL (e.g., `redis://localhost:6379`). Takes precedence over `REDIS_HOST`/`REDIS_PORT` |
| `REDIS_HOST` | No | Redis hostname (default: `localhost`). Used when `REDIS_URL` is not set |
| `REDIS_PORT` | No | Redis port (default: `6379`). Used when `REDIS_URL` is not set |
| `WORKER_CONCURRENCY` | No | Number of concurrent BullMQ worker jobs (default: `3`) |
| `SERVICE_TYPE` | No | Service role: `server` (API only), `worker` (queue processor only), or omit for both |
| `SERVER_URL` | No | Public server URL for callbacks (default: `https://api.javierzader.com`) |
| `ENCRYPTION_KEY` | Yes | 64-character hex string for AES-256-GCM encryption |
| `STATE_SECRET` | Conditionally | Required for OAuth Web Flow state signing and runner callback HMAC derivation |
| `CALLBACK_TTL_MINUTES` | No | Runner callback secret TTL in minutes (default: `11`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` or `production` |

> **Startup vs runtime**: The server fails fast on core boot variables (`DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`). `GITHUB_CLIENT_SECRET` and `STATE_SECRET` are additionally required when you use dashboard OAuth Web Flow; `STATE_SECRET` is also used for runner callback signing. Redis connection is required for the worker service; without it, the server falls back to synchronous execution.

### CLI Mode

| Variable | Required | Description |
|----------|----------|-------------|
| `GHAGGA_API_KEY` | No | LLM provider API key (not needed for GitHub Models — use `ghagga login` instead) |
| `GHAGGA_PROVIDER` | No | Provider: `github`, `anthropic`, `openai`, `google`, `ollama`, `qwen` (default: `github`) |
| `GHAGGA_MODEL` | No | Model identifier (auto-selects best per provider) |
| `GHAGGA_MEMORY_BACKEND` | No | Memory backend: `sqlite` (default) or `engram` |
| `GHAGGA_ENGRAM_HOST` | No | Engram server URL (default: `http://localhost:7437`) |
| `GHAGGA_ENGRAM_TIMEOUT` | No | Engram connection timeout in seconds (default: `5`) |

### GitHub Action Mode

API key and provider are passed as action inputs, not environment variables. See [GitHub Action](github-action.md).

## Config File (`.ghagga.json`)

Place a `.ghagga.json` in your repo root for project-level defaults:

```json
{
  "mode": "workflow",
  "provider": "github",
  "model": "claude-sonnet-4-20250514",
  "enabledTools": ["ruff", "bandit"],
  "disabledTools": ["markdownlint"],
  "customRules": [".semgrep/custom-rules.yml"],
  "ignorePatterns": ["*.test.ts", "*.spec.ts", "docs/**"],
  "reviewLevel": "strict"
}
```

> The legacy fields `enableSemgrep`, `enableTrivy`, `enableCpd` still work but are deprecated. Use `enabledTools`/`disabledTools` arrays instead.

**Priority**: CLI flags > config file > defaults.

## Default Models

| Provider | Default Model |
|----------|--------------|
| GitHub Models | `gpt-4o-mini` |
| Anthropic | `claude-sonnet-4-20250514` |
| OpenAI | `gpt-4o` |
| Google | `gemini-2.5-flash` |
| Ollama | `qwen2.5-coder:7b` |
| Qwen | `qwen-coder-plus` |

## Token Budget

The diff is automatically truncated to fit each model's context window using a 70/30 split:

| Allocation | Percentage | Purpose |
|-----------|-----------|---------|
| Diff content | 70% | The actual code changes |
| Agent prompts + context | 30% | System prompt, static analysis, memory, stack hints |

## Ignore Patterns

Files matching ignore patterns are excluded from the diff before review. This saves tokens and avoids noisy findings on auto-generated files.

Default ignored patterns:
- `*.lock` — Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml)
- `*.md` — Markdown documentation
- `*.map` — Source maps

Add custom patterns in `.ghagga.json`:

```json
{
  "ignorePatterns": [
    "*.test.ts",
    "*.spec.ts",
    "docs/**",
    "generated/**",
    "*.snap"
  ]
}
```

## Review Levels

| Level | Behavior |
|-------|----------|
| `soft` | Only flag critical and high severity issues. Lenient on style. |
| `normal` | Default. Flag all severities with balanced feedback. |
| `strict` | Zero tolerance. Flag everything including style and naming. |

Set via config file or CLI flag:

```json
// .ghagga.json
{
  "reviewLevel": "strict"
}
```

```bash
ghagga review --config .ghagga.json
```

## Provider Chain (SaaS)

In the SaaS dashboard, you can configure an ordered **provider chain** as a fallback list. If the primary provider fails (rate limit, API error), GHAGGA automatically tries the next provider in the chain.

Example chain: `GitHub Models → OpenAI → Anthropic`

In **SaaS/server mode**, GitHub Models needs a PAT with `models:read` on that provider entry. GitHub App installation tokens do not include that scope, so a `github` entry without an explicit token is skipped at review time. This limitation does **not** apply to the CLI (`ghagga login`) or GitHub Action (`github-token` / `GITHUB_TOKEN`) flows.

Provider chains are configured per-repo or globally (see Global Settings).

## Comment Trigger (SaaS)

In SaaS mode, you can re-trigger a review on any open PR by commenting:

```
ghagga review
```

The keyword is case-insensitive and can appear anywhere in the comment body. GHAGGA reacts with 👀 to acknowledge receipt and 🚀 when the review is posted.

**Permissions**: Only users with a contribution relationship to the repository can trigger reviews — owners, members, collaborators, contributors, and first-time contributors. Users with no association are rejected.

> **Note**: Your GitHub App must be subscribed to the `issue_comment` event. This is configured in the GitHub App settings under "Subscribe to events".

## Global Settings (SaaS)

Installation-wide defaults that apply to all repositories. Each repo can override with its own settings by toggling "Use global settings" off in the dashboard.

Global settings include: provider chain, review mode, AI review enabled/disabled, static analysis tool toggles (via ToolGrid), and ignore patterns.
