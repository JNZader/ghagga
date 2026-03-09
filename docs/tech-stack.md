# Tech Stack

## Overview

| Layer | Technology | Why |
|-------|-----------|-----|
| **Monorepo** | pnpm workspaces + Turborepo | Fast installs, parallel builds, caching |
| **Language** | TypeScript 5.7 (strict mode) | Type safety across all packages |
| **Backend** | Hono 4 | Fastest TS framework, 14KB, runs anywhere |
| **Database** | PostgreSQL 16 + Drizzle ORM, sql.js (CLI/Action), [Engram](https://github.com/Gentleman-Programming/engram) (optional CLI) | Zero-overhead SQL, tsvector FTS, plain TS migrations; WASM SQLite with FTS5 for CLI/Action; Engram HTTP API for cross-tool memory sharing |
| **AI** | Vercel AI SDK 6 | Multi-provider (6 providers), streaming, structured output, fallback chains |
| **Async** | Inngest 3 | Zero-infra durable functions, step checkpointing, automatic retries |
| **Frontend** | React 19 + Vite + Tailwind 4 | Lazy-loaded routes, vendor splitting, dark theme |
| **Data Fetching** | TanStack Query 5 | Caching, background refetching, optimistic updates |
| **Charts** | Recharts 2 | Composable React chart components |
| **CLI** | Commander 13 + @clack/prompts 0.9 | Standard CLI framework with styled TUI prompts |
| **Testing** | Vitest 4 | Fast, ESM-native, compatible with Jest API |
| **Static Analysis** | 15-tool plugin registry | Security, vulnerabilities, duplication, code quality — zero tokens |
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

### Inngest over BullMQ

Zero infrastructure — no Redis. 50k events/month free. Step-based checkpointing means LLM retries don't re-run static analysis.

## Test Suite

~2,859 tests across 8 packages. All passing. 4 audit rounds completed (62 improvements).

| Package | Tests | What's Covered |
|---------|------:|----------------|
| `@ghagga/core` | 1,328 | Pipeline, diff parsing, stack detection, token budget, prompts, agents (simple, workflow, consensus), fallback provider, privacy, memory (search, persist, context), tools (semgrep, trivy, cpd), parsers, security audit, review calibration, Engram memory adapter, circuit breaker |
| `@ghagga/db` | 118 | Queries (CRUD, effective settings, provider chain), AES-256-GCM crypto (roundtrip, tamper, edge cases), index verification |
| `@ghagga/server` | 523 | API routes (6 domain modules), webhook handlers, auth middleware + token cache, provider validation, Inngest review function, GitHub client, runner dispatch, callback verification, graceful shutdown, health checks, correlation IDs, error IDs, HTTP timeouts, env validation, Zod negative tests |
| `ghagga` (CLI) | 272 | Config resolution, review command — input validation, output formatting, exit codes, git hooks (install, uninstall, status) |
| `@ghagga/action` | 195 | Input parsing, output setting, comment formatting, error handling, tool installation, cache management |
| `@ghagga/dashboard` | 342 | Component rendering, ErrorBoundary, a11y (7 axe tests), focus trap, virtual scrolling |
| `@ghagga/types` | 24 | Shared API type exports and contract validation |
| E2E | 14 | Webhook→pipeline→comment, CLI review flow, Action review flow |
