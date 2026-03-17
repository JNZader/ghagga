# Tech Stack

## Overview

| Layer | Technology | Why |
|-------|-----------|-----|
| **Monorepo** | pnpm workspaces + Turborepo | Fast installs, parallel builds, caching |
| **Language** | TypeScript 5.9 (strict mode) | Type safety across all packages |
| **Backend** | Hono 4 | Fastest TS framework, 14KB, runs anywhere |
| **Database** | PostgreSQL 16 + Drizzle ORM, sql.js (CLI/Action), [Engram](https://github.com/Gentleman-Programming/engram) (optional CLI) | Zero-overhead SQL, tsvector FTS, plain TS migrations; WASM SQLite with FTS5 for CLI/Action; Engram HTTP API for cross-tool memory sharing |
| **AI** | Vercel AI SDK 6 | Multi-provider (6 providers), streaming, structured output, fallback chains |
| **Async** | BullMQ 5 + Redis 7 | Self-hosted job queues, automatic retries, no external SaaS dependency |
| **Frontend** | React 19 + Vite + Tailwind 4 | Lazy-loaded routes, vendor splitting, dark theme |
| **Data Fetching** | TanStack Query 5 | Caching, background refetching, optimistic updates |
| **Charts** | Recharts 3 | Composable React chart components |
| **CLI** | Commander 14 + @clack/prompts 1.1 | Standard CLI framework with styled TUI prompts |
| **Testing** | Vitest 4 | Fast, ESM-native, compatible with Jest API |
| **Static Analysis** | 16-tool plugin registry | Security, vulnerabilities, duplication, code quality — zero tokens |
| **Encryption** | Node.js `crypto` (AES-256-GCM) | No external dependencies for cryptographic operations |

## Why These Choices

### Vercel AI SDK over LangChain/LangGraph

GHAGGA's review flow is **predictable** (Layer 0 → 1 → 2 → 3), not a dynamic graph. AI SDK gives multi-provider support with less overhead. agentlib was evaluated but is too immature (1 week old, OpenAI only, no multi-agent).

### Hono over Express/Fastify

14KB, fastest benchmarks, runs on Node/Bun/Deno/Workers. Express is legacy, Fastify is heavier than needed.

### Drizzle over Prisma

Zero-overhead SQL, no binary dependencies, supports raw tsvector operations for full-text search.

### PostgreSQL Memory over Engram

Engram has great design patterns but no multi-tenancy, no auth, and is SQLite single-writer. We adopted its patterns (sessions, topic_key upserts, deduplication, privacy stripping) in PostgreSQL.

### BullMQ over Inngest

GHAGGA migrated from Inngest (SaaS) to BullMQ + Redis (self-hosted). BullMQ eliminates the external SaaS dependency, runs entirely on infrastructure we control (Hetzner VPS), and uses Redis as a simple, battle-tested job queue backend. No vendor lock-in, no event quotas, no external webhooks to register. The worker process runs alongside the API server in the same docker-compose stack. Automatic retries and job prioritization are built into BullMQ natively.

## Test Suite

Comprehensive test suite across 8 packages. All passing. 4 audit rounds completed (62 improvements).

| Package | What's Covered |
|---------|----------------|
| `@ghagga/core` | Pipeline, diff parsing, stack detection, token budget, prompts, agents (simple, workflow, consensus), fallback provider, privacy, memory (search, persist, context), tools (semgrep, trivy, cpd), parsers, security audit, review calibration, Engram memory adapter, circuit breaker |
| `@ghagga/db` | Queries (CRUD, effective settings, provider chain), AES-256-GCM crypto (roundtrip, tamper, edge cases), index verification |
| `@ghagga/server` | API routes (6 domain modules), webhook handlers, auth middleware + token cache, provider validation, BullMQ review queue, GitHub client, runner dispatch, callback verification, graceful shutdown, health checks, correlation IDs, error IDs, HTTP timeouts, env validation, Zod negative tests |
| `ghagga` (CLI) | Config resolution, review command — input validation, output formatting, exit codes, git hooks (install, uninstall, status) |
| `@ghagga/action` | Input parsing, output setting, comment formatting, error handling, tool installation, cache management |
| `@ghagga/dashboard` | Component rendering, ErrorBoundary, a11y (7 axe tests), focus trap, virtual scrolling |
| `@ghagga/types` | Shared API type exports and contract validation |
| E2E | Webhook->pipeline->comment, CLI review flow, Action review flow |
