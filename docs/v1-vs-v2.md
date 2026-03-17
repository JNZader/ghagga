# v1 vs v2

GHAGGA v2 is a **complete rewrite** from scratch. The v1 codebase (~11,000 lines) is preserved on the `main-bkp` branch.

## What Was Wrong with v1

| Problem | Details |
|---------|---------|
| **Duplicate implementations** | TWO review flows: webhook inline handler AND a ReviewService class that was never called |
| **Dead code** | Hebbian Learning stored data but never consumed it. Threads, chunking, and embedding cache modules existed but were orphaned |
| **Heavy dependencies** | Required Supabase CLI, Docker, Deno runtime, and a separate Python microservice for Semgrep |
| **Hybrid search fallback** | Fell back to client-side filtering instead of using the SQL RPC function |
| **Complex deployment** | Multiple manual steps, multiple runtimes, multiple services |

## What Was Rescued from v1

| Component | Details |
|-----------|---------|
| **Agent prompts** | All system prompts (simple, 5 workflow specialists, synthesis, consensus stances) — battle-tested and well-designed |
| **Multi-provider abstraction** | Concept of supporting multiple LLM providers with fallback |
| **Crypto module** | AES-256-GCM encryption pattern for API keys |
| **Semgrep rules** | 20 custom security rules across 7+ languages |
| **Stack detection** | File extension → tech stack mapping for review hints |
| **Privacy stripping** | Pattern-based secret redaction before memory persistence |

## Comparison

| Aspect | v1 | v2 |
|--------|----|----|
| Lines of code | ~11,000 | ~6,000 (implementation) + ~3,000 (tests) |
| Runtime | Deno + Node.js + Python | Node.js only |
| Database | Supabase (hosted PostgreSQL) | Any PostgreSQL (self-hosted or cloud) |
| Deploy steps | 10+ manual steps | 3 env vars + `docker compose up` |
| Test suite | 0 tests | Comprehensive test suite |
| Distribution modes | 1 (webhook only) | 3 (SaaS, Action, CLI) |
| Static analysis | Semgrep only (via microservice) | 16 tools via plugin registry (direct binary execution) |
| Memory | Partial (stored but never consumed) | Full pipeline (search → inject → review → extract → persist) |
| Dead code | ~40% of codebase | 0% |
| Git hooks | None | Pre-commit + commit-msg hooks via `ghagga hooks install` |

## Architecture Changes

### v1 Architecture
- Deno + Supabase edge functions
- Separate Python microservice for Semgrep
- Supabase for database and auth
- Single distribution mode (webhook)

### v2 Architecture
- TypeScript monorepo (pnpm + Turborepo)
- Core + Adapters pattern
- PostgreSQL with Drizzle ORM (any provider)
- 3 distribution modes (SaaS, Action, CLI)
- All static analysis as child processes
- BullMQ + Redis for async job processing

## Migration

No data migration is required. GHAGGA v2 starts with a fresh database. The v1 code remains on `main-bkp` branch indefinitely.
