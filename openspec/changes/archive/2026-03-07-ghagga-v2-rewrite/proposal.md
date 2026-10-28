# Proposal: GHAGGA v2 - Complete Rewrite

## Intent

GHAGGA v1 has good ideas but is over-engineered and hard to deploy. It requires Supabase CLI, Docker, Deno runtime, a separate Python microservice, and multiple manual configuration steps. Features like Hebbian Learning, Threads, and Hybrid Search are partially implemented (data stored but never consumed).

This rewrite simplifies the architecture to a TypeScript monorepo with clear separation of concerns, while preserving the multi-agent review system that is GHAGGA's core value. The goal is: **clone, set 3 env vars, deploy**.

## Scope

### In Scope

1. **Monorepo structure** (pnpm workspaces + Turborepo)
   - `packages/core` — Review engine: agents, static analysis tools, memory
   - `packages/db` — Drizzle ORM schemas + migrations
   - `apps/server` — Hono API (webhooks, REST endpoints)
   - `apps/dashboard` — Vite + React + shadcn/ui (GitHub Pages)
   - `apps/cli` — CLI wrapper for local usage
   - `apps/action` — GitHub Action wrapper

2. **Multi-agent review system** (3 modes preserved)
   - Simple: Single LLM review with structured output
   - Workflow: 5 specialist agents (scope, standards, errors, security, performance) + synthesis
   - Consensus: Multi-model voting with for/against/neutral stances

3. **Static analysis trident** (Layer 0, zero tokens)
   - Semgrep: Security patterns + custom rules (15+ languages)
   - Trivy: CVE scanning in dependencies (all ecosystems)
   - PMD/CPD: Copy-paste / duplicate code detection (15+ languages)

4. **Memory system** (PostgreSQL-based, inspired by Engram)
   - Session model per review
   - Structured observations (decision, pattern, bugfix, learning)
   - Full-text search via tsvector
   - Project-level isolation (multi-tenant)
   - Topic-key upserts for evolving knowledge
   - Deduplication (content hash + rolling window)

5. **Multi-provider AI** via Vercel AI SDK
   - Anthropic (Claude), OpenAI (GPT-4), Google (Gemini)
   - BYOK model: users provide their own API keys
   - Per-repo provider/model configuration
   - Fallback chain (Anthropic > OpenAI > Google)

6. **Async processing** via Inngest
   - Webhook responds instantly, agents run in background
   - Durable execution with step checkpointing
   - Automatic retries with exponential backoff
   - Graceful degradation when quota exceeded

7. **Dashboard** (Vite + React + shadcn/ui + TanStack Query)
   - GitHub OAuth login
   - Review history with stats and trends
   - Per-repo settings (provider, model, mode, tools, rules)
   - Per-repo encrypted API key management
   - Memory browser (sessions + observations)
   - Deployed on GitHub Pages (zero cost)

8. **4 distribution modes**
   - SaaS: Central backend on Oracle Cloud / Koyeb (for private repos)
   - GitHub Action: Runs in GitHub's infra (free for public repos)
   - CLI: Local usage via `npx ghagga review`
   - 1-Click Deploy: Railway/Koyeb deploy button for community self-hosting

9. **Security**
   - AES-256-GCM encryption for stored API keys
   - Webhook signature verification (HMAC-SHA256, constant-time)
   - BYOK: GHAGGA never pays for users' LLM usage
   - Per-repo RLS (Row Level Security) in database

### Out of Scope

- Hebbian Learning (store-only, never consumed in v1 — removed)
- Thread/conversation system (never implemented in v1 — removed)
- Embedding/vector search (FTS via tsvector is sufficient for v2)
- Azure OpenAI, Ollama, Groq providers (defer to v2.1+)
- Semgrep custom rules editor in dashboard (defer)
- Billing/payment system (free tier only for now)

## Approach

### Architecture: Core + Adapters

The review engine lives in `packages/core` and knows NOTHING about HTTP, webhooks, or CLI. It receives a diff + config, runs the static analysis trident, orchestrates agents via Vercel AI SDK, consults memory, and returns a structured result.

Each distribution mode (`apps/*`) is a thin adapter that:
1. Receives input in its own way (webhook, CLI args, Action event)
2. Calls `packages/core`
3. Outputs the result in its own way (PR comment, terminal, Action summary)

### Agent Orchestration: Custom, not LangGraph

The review flow is predictable (not a dynamic graph). We don't need a framework:

```
Input (diff + config)
  → Layer 0: Semgrep + Trivy + CPD (parallel, zero tokens)
  → Layer 1: Memory search (past observations for this repo)
  → Layer 2: Agent(s) based on mode:
      Simple:    1 LLM call
      Workflow:  5 parallel specialists → 1 synthesis
      Consensus: N models with stances → weighted vote → synthesis
  → Layer 3: Save observations to memory
  → Output (structured review result)
```

### Database: PostgreSQL + Drizzle ORM

Tables designed for multi-tenancy from day one:
- `installations` — GitHub App installations
- `repositories` — Repo configs, settings, encrypted keys
- `reviews` — Review results with metadata
- `memory_sessions` — One per review
- `memory_observations` — Structured findings with tsvector search

### Prompts: Rescued from v1

The agent prompts from v1 are well-designed and battle-tested. We rescue:
- Simple review system prompt
- 5 workflow specialist prompts (scope, standards, errors, security, performance)
- Workflow synthesis prompt
- Consensus stance prompts (for, against, neutral)
- Static analysis context injection template
- Memory context injection template
- Stack-detection hints per language

## Affected Areas

| Area               | Impact  | Description                                              |
| ------------------ | ------- | -------------------------------------------------------- |
| `packages/core/`   | New     | Review engine, agents, static analysis, memory           |
| `packages/db/`     | New     | Drizzle schemas, migrations, queries                     |
| `apps/server/`     | New     | Hono API replacing Supabase Edge Functions               |
| `apps/dashboard/`  | New     | React + shadcn replacing Mantine dashboard               |
| `apps/cli/`        | New     | CLI distribution mode                                    |
| `apps/action/`     | New     | GitHub Action distribution mode                          |
| `supabase/`        | Removed | Entire Supabase backend replaced                         |
| `semgrep-service/` | Removed | Python microservice replaced by binary execution in core |
| `dashboard/`       | Removed | Mantine dashboard replaced                               |

## Risks

| Risk                                            | Likelihood | Mitigation                                                                                                              |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Inngest 50k event limit for community usage     | Medium     | Design graceful degradation (static-only mode). Prepare BullMQ migration path. Batch agent steps to reduce event count. |
| Oracle Cloud free tier account setup friction   | Medium     | Support Koyeb as alternative. Provide Docker Compose for any VPS.                                                       |
| Semgrep/Trivy/CPD binary installation in Action | Low        | Use official Docker images. Pre-built container with all tools.                                                         |
| Vercel AI SDK breaking changes                  | Low        | Pin versions. SDK is stable and well-maintained.                                                                        |
| PMD/CPD requires JVM                            | Medium     | Use Docker in CI. For CLI mode, make CPD optional (skip if Java not installed).                                         |
| GitHub API rate limits during large PR reviews  | Low        | Token budgeting already designed in v1. Respect rate limits with backoff.                                               |

## Rollback Plan

The v1 code remains intact on the `main-bkp` branch. If v2 fails:
1. `git checkout main-bkp`
2. Push to main: `git push origin main-bkp:main --force`
3. All existing v1 infrastructure (Supabase, semgrep-service) is untouched

No data migration is needed — v2 starts with a fresh database.

## Dependencies

- pnpm 9+ and Node.js 20+
- PostgreSQL 15+ (Neon free tier or any Postgres)
- Inngest account (free tier: 50k events/month)
- GitHub App credentials (user creates their own)
- At least one LLM API key (user provides via BYOK)

## Success Criteria

- [ ] `pnpm install && pnpm build` works from clean clone
- [ ] Server starts with 3 env vars (DATABASE_URL, GITHUB_APP credentials, INNGEST key)
- [ ] GitHub webhook receives PR event and triggers review
- [ ] Simple mode produces structured review comment on PR
- [ ] Workflow mode runs 5 agents in parallel and synthesizes
- [ ] Consensus mode runs multi-model voting and posts result
- [ ] Static analysis (Semgrep + Trivy + CPD) runs before LLM and injects context
- [ ] Memory saves observations and retrieves them for subsequent reviews
- [ ] Dashboard deploys to GitHub Pages and shows review history
- [ ] CLI mode reviews local changes without a server
- [ ] GitHub Action mode works in public repos
- [ ] 1-click deploy button works on Railway/Koyeb
- [ ] Deploy-to-production takes < 10 minutes for a new user
