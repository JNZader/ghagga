# Configuration

> **Using the SaaS (GitHub App)?** Configure everything in the [Dashboard](https://ghagga.javierzader.com/app/) → Settings. The environment variables and config file below are for **CLI** and **self-hosted** deployments only.

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
| `REDIS_URL` | No | **Primary** Redis connection URL, honoured by every client (shared singleton + BullMQ). Carries auth and TLS: `redis://user:pass@host:6379`, `rediss://user:pass@host:6380` (TLS). Takes precedence over `REDIS_HOST`/`REDIS_PORT` (which are then ignored) |
| `REDIS_HOST` | No | Redis hostname (default: `localhost`). Used ONLY when `REDIS_URL` is not set |
| `REDIS_PORT` | No | Redis port (default: `6379`). Used ONLY when `REDIS_URL` is not set |
| `REDIS_USERNAME` | No | Redis ACL username for the host/port fallback (ignored when `REDIS_URL` is set) |
| `REDIS_PASSWORD` | No | Redis password for the host/port fallback (ignored when `REDIS_URL` is set) |
| `REDIS_TLS` | No | Set to `true` to enable TLS for the host/port fallback (ignored when `REDIS_URL` is set) |
| `WORKER_CONCURRENCY` | No | Number of concurrent BullMQ worker jobs (default: `3`) |
| `SERVICE_TYPE` | No | Service role: `server` (API only), `worker` (queue processor only), or omit for both |
| `SERVER_URL` | No | Public server URL for callbacks (default: `https://api.javierzader.com`) |
| `ENCRYPTION_KEY` | Yes | 64-character hex string for AES-256-GCM encryption |
| `STATE_SECRET` | Conditionally | Required for OAuth Web Flow state signing and runner callback HMAC derivation. The worker process **fails fast at startup** if it is missing (inline static-analysis dispatch derives a callback secret from it). OAuth-state and runner-callback keys are domain-separated from this secret |
| `HEALTH_CHECK_TOKEN` | No | When set, `/health/detailed` returns infrastructure internals (uptime, memory, DB latency, circuit-breaker state) ONLY to callers presenting it via `Authorization: Bearer <token>` or `x-health-token`. Unauthenticated callers get an aggregated `status` only |
| `GHAGGA_ALLOW_PRIVATE_GATEWAY` | No | Set to `true` for self-hosted deployments whose LLM gateway lives on a private network. Skips the SSRF private-IP range checks for gateway URLs; the connection is still pinned to the resolved address, and protocol/userinfo checks always apply |
| `CALLBACK_TTL_MINUTES` | No | Runner callback secret TTL in minutes (default: `11`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` or `production` |

> **Startup vs runtime**: The server fails fast on core boot variables (`DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`). `GITHUB_CLIENT_SECRET` and `STATE_SECRET` are additionally required when you use dashboard OAuth Web Flow; `STATE_SECRET` is also used for runner callback signing and the **worker process fails fast** if it is missing. Redis connection is required for the worker service; without it, the server falls back to synchronous execution. Use `REDIS_URL` (with credentials/TLS baked into the URL) for managed/authenticated Redis — every client reads it first, and the effective mode (auth/TLS) is logged at startup.

### CLI Mode

| Variable | Required | Description |
|----------|----------|-------------|
| `GHAGGA_API_KEY` | No | LLM provider API key (not needed for GitHub Models — use `ghagga login` instead) |
| `GHAGGA_PROVIDER` | No | Provider: `github`, `anthropic`, `openai`, `google`, `ollama`, `qwen`, `groq`, `cerebras`, `deepseek`, `openrouter` (default: `github`) |
| `GHAGGA_MODEL` | No | Model identifier (auto-selects best per provider) |
| `GHAGGA_MEMORY_BACKEND` | No | Memory backend: `sqlite` (default, FTS5 at `~/.config/ghagga/memory.db`) or `engram` (HTTP API for cross-tool memory sharing) |
| `GHAGGA_ENGRAM_HOST` | No | Engram server URL (default: `http://localhost:7437`). Falls back to SQLite if unreachable. |
| `GHAGGA_ENGRAM_TIMEOUT` | No | Engram connection timeout in seconds (default: `5`) |

> See [Memory System](memory-system.md) for full details on storage backends, search engines, deduplication, and privacy stripping.

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
| Groq | `llama-3.3-70b-versatile` |
| Cerebras | `llama-3.3-70b` |
| DeepSeek | `deepseek-chat` |
| OpenRouter | `deepseek/deepseek-chat` |

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

## Gateway Mode (mcp-llm-bridge)

For server deployments, you can delegate all LLM calls to a running [mcp-llm-bridge](https://github.com/JNZader/mcp-llm-bridge) instance instead of managing provider credentials directly in GHAGGA.

**Why use gateway mode?**
- Centralized credential management — one vault for all projects
- Advanced routing — epsilon-greedy latency-based provider selection, circuit breakers, group balancing
- Built-in OTel tracing and RBAC per API key
- Free model fallback (GitHub Models, OpenCode free tier) handled automatically

**Configuration:**

```json
{
  "provider": "gateway",
  "gatewayUrl": "http://localhost:3001",
  "gatewayToken": "your-bridge-api-key"
}
```

Or via environment variables:

```bash
GHAGGA_PROVIDER=gateway
GHAGGA_GATEWAY_URL=http://localhost:3001
GHAGGA_GATEWAY_TOKEN=your-bridge-api-key
```

**Docker Compose (ghagga + mcp-llm-bridge together):**

```yaml
services:
  bridge:
    image: ghcr.io/jnzader/mcp-llm-bridge:latest
    ports:
      - "3001:3001"
    environment:
      VAULT_KEY: ${VAULT_KEY}

  ghagga:
    image: ghcr.io/jnzader/ghagga:latest
    environment:
      GHAGGA_PROVIDER: gateway
      GHAGGA_GATEWAY_URL: http://bridge:3001
      GHAGGA_GATEWAY_TOKEN: ${BRIDGE_API_KEY}
    depends_on:
      - bridge
```

> **Note**: In gateway mode, GHAGGA's own provider chain and credential vault are bypassed entirely. All routing decisions (fallback, model selection, rate limiting) are handled by the bridge.

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
