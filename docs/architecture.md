# Architecture

## Core + Adapters Pattern

GHAGGA uses a **Core + Adapters** architecture. The review engine (`@ghagga/core`) is pure logic with zero I/O dependencies — it knows nothing about HTTP, webhooks, or CLI. Each distribution mode is a thin adapter.

```mermaid
graph TB
  subgraph Distribution["Distribution Layer"]
    Server["Server<br/>Hono"]
    Action["Action<br/>GitHub Action"]
    CLI["CLI"]
  end

  subgraph Runner["Delegated Runner"]
    RunnerRepo["ghagga-runner<br/>GitHub Actions"]
    RunnerTools["16 Static Analysis Tools<br/>7GB RAM"]
  end

  subgraph Core["@ghagga/core"]
    direction TB
    SA["Static Analysis<br/>16-tool plugin registry"]
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

## Adapter Responsibilities

Each adapter does the minimum work necessary to bridge between its I/O world and the core engine:

| Adapter | Input | Output | Memory | Static Analysis |
|---------|-------|--------|--------|----------------|
| **Server** | GitHub webhook | PR comment via GitHub API | Yes (PostgreSQL) | Delegated to runner |
| **Action** | PR event in GitHub Actions | PR comment via Octokit | Yes (SQLite) | Direct on runner |
| **CLI** | Local `git diff` | Terminal output (markdown/json/sarif) | Yes (SQLite or Engram) | If installed locally |

> Memory uses PostgreSQL + tsvector FTS in Server mode, SQLite (via `sql.js` WASM) with FTS5 in Action mode, and SQLite or [Engram](https://github.com/Gentleman-Programming/engram) in CLI mode (`--memory-backend engram`). All three backends implement the same `MemoryStorage` interface. Content is deduplicated via SHA-256 hashing with a 15-minute dedup window, and all data passes through `stripPrivateData()` (13 regex patterns) before storage. See [Memory System](memory-system.md) for full details.

## Monorepo Structure

```
ghagga/
├── packages/
│   ├── core/           # @ghagga/core — Review engine (zero I/O)
│   │   └── src/
│   │       ├── pipeline.ts     # Main orchestrator
│   │       ├── types.ts        # All TypeScript interfaces
│   │       ├── agents/         # Simple, Workflow, Consensus
│   │       ├── tools/          # 16-tool plugin registry
│   │       ├── memory/         # Search, persist, privacy, engram.ts
│   │       ├── providers/      # Vercel AI SDK multi-provider
│   │       └── utils/          # Diff parsing, stack detect, tokens
│   ├── db/             # @ghagga/db — Database layer
│   │   └── src/
│   │       ├── schema.ts       # Drizzle table definitions
│   │       ├── crypto.ts       # AES-256-GCM encrypt/decrypt
│   │       └── queries.ts      # Typed database queries
│   └── types/          # @ghagga/types — Shared TypeScript interfaces
├── apps/
│   ├── server/         # Hono API (webhook + REST + BullMQ + runner)
│   │   └── Dockerfile  # Multi-stage with 16 static analysis tools
│   ├── dashboard/      # React SPA (GitHub Pages)
│   ├── cli/            # CLI tool (Commander.js)
│   └── action/         # GitHub Action (node20 + Docker)
│
├── templates/                 # Runner dispatch templates
│   ├── ghagga-analysis.yml       # GitHub Actions workflow for analysis
│   └── ghagga-runner-README.md   # Template repo README
└── docker-compose.yml  # PostgreSQL + Redis + server + worker
```

## Runner Architecture

Static analysis can be delegated to a **user-owned GitHub Actions runner** on public repos. This is useful for deployments where the server container has limited RAM, or when you want to offload analysis to GitHub's free compute (7GB RAM, unlimited free minutes for public repos).

```mermaid
sequenceDiagram
    participant S as GHAGGA Server
    participant R as ghagga-runner
    participant GH as GitHub API

    S->>GH: Check {owner}/ghagga-runner exists
    S->>GH: Set GHAGGA_TOKEN secret
    S->>GH: workflow_dispatch (10 inputs)
    R->>R: Install + run static analysis (16 tools)
    R->>S: POST /runner/callback (HMAC-signed)
    S->>S: Verify HMAC, merge findings
```

If no runner repo is discovered, the server falls back to LLM-only review (no static analysis). See [Runner Architecture](runner-architecture.md) for full details.

## Design Decisions

### Vercel AI SDK over LangChain/LangGraph

GHAGGA's review flow is **predictable** (Layer 0 → 1 → 2 → 3), not a dynamic graph. Vercel AI SDK gives multi-provider support (6 providers: GitHub Models, Anthropic, OpenAI, Google, Ollama, Qwen) with streaming, structured output, and tool calling — without the overhead of graph management.

### Hono over Express/Fastify

Hono is the fastest TypeScript framework at ~14KB. It runs on Node.js, Bun, Deno, and Cloudflare Workers. Express is legacy, Fastify is heavier than needed for this use case.

### Drizzle ORM over Prisma

Zero-overhead SQL with excellent TypeScript inference. No binary dependencies (unlike Prisma). Supports raw tsvector operations for the memory system's full-text search.

### PostgreSQL Memory over Engram

[Engram](https://github.com/Gentleman-Programming/engram) has great design patterns (session model, topic-key upserts, deduplication, privacy stripping) but no multi-tenancy, no auth, and is SQLite single-writer. We adopted its patterns directly in PostgreSQL.

### BullMQ over Inngest

GHAGGA migrated from Inngest (SaaS) to BullMQ + Redis (self-hosted). BullMQ eliminates the external SaaS dependency, runs entirely on infrastructure we control (Hetzner VPS), and uses Redis as a battle-tested job queue backend. No vendor lock-in, no event quotas, no external webhooks to register. The worker process runs alongside the API server in the same docker-compose stack.

### Provider Chain Filtering in SaaS Mode

In SaaS mode, the server uses GitHub App **installation tokens** (`ghs_*`) to authenticate with GitHub. These tokens do **not** have the `models:read` scope required by GitHub Models. As a result, the server silently filters out `github` provider entries from the provider chain when no explicit PAT is configured for that entry.

If a user adds "GitHub Models" to their provider chain in the Dashboard without providing a PAT with `models:read`, the entry is skipped at review time and the next provider in the chain is used instead. A warning is logged on the server side. This does **not** affect CLI or GitHub Action modes, where a user-controlled GitHub token is used directly.

### Binary Execution for Static Analysis

All static analysis tools are called as child processes — no separate microservices, no network latency, no SSRF concerns. Tool outputs (JSON, XML, or text) are parsed locally into a common `ReviewFinding` format.
