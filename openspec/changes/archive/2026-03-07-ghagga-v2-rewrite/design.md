# Design: GHAGGA v2 - Complete Rewrite

## Technical Approach

A TypeScript monorepo (pnpm workspaces + Turborepo) with a "Core + Adapters" architecture. The review engine (`packages/core`) is pure logic with zero I/O dependencies. Each distribution mode (`apps/*`) is a thin adapter. PostgreSQL via Drizzle ORM for persistence. Vercel AI SDK for multi-provider LLM calls. Inngest for durable async execution.

## Architecture Decisions

### Decision: Vercel AI SDK over LangChain/LangGraph/agentlib

**Choice**: Vercel AI SDK (`ai` package)
**Alternatives considered**: LangGraph.js (heavy, complex graph abstraction for a predictable flow), agentlib (1 week old, no multi-agent, OpenAI only), raw provider SDKs (too low-level)
**Rationale**: GHAGGA's review flow is predictable (Layer 0 → 1 → 2 → 3), not a dynamic graph. Vercel AI SDK gives us multi-provider support (Anthropic, OpenAI, Google) with streaming, structured output, and tool calling in a single lightweight package. No framework overhead for graph management we don't need.

### Decision: Hono over Express/Fastify/Next.js

**Choice**: Hono
**Alternatives considered**: Express (legacy, slow), Fastify (heavier than needed), Next.js (forces frontend coupling)
**Rationale**: Hono is the fastest TypeScript framework, runs on Node.js/Bun/Deno/Workers, has built-in middleware (CORS, auth, logging), and keeps the backend truly separate from the frontend. ~14KB bundle.

### Decision: Drizzle ORM over Prisma/Kysely/raw SQL

**Choice**: Drizzle ORM
**Alternatives considered**: Prisma (heavy CLI, opaque query engine), Kysely (less ecosystem), raw SQL (maintenance burden)
**Rationale**: Drizzle generates zero-overhead SQL, has excellent TypeScript inference, and migrations are plain TypeScript files. No binary dependencies (unlike Prisma). Supports PostgreSQL tsvector for memory search.

### Decision: shadcn/ui + Tailwind over Mantine

**Choice**: shadcn/ui + Tailwind CSS
**Alternatives considered**: Mantine 7 (current v1 choice — good but adds 200KB+ to bundle), Radix Primitives only (too low-level)
**Rationale**: shadcn/ui copies component code into the project giving full control and zero runtime dependency. Smaller bundle for GitHub Pages. Community standard for modern React apps.

### Decision: PostgreSQL memory over Engram

**Choice**: Custom PostgreSQL memory layer with tsvector FTS
**Alternatives considered**: Engram (no multi-tenancy, no auth, SQLite single-writer, 2 weeks old)
**Rationale**: We already need PostgreSQL for repo configs and review history. Adding memory tables with tsvector search keeps it in one database. Multi-tenancy via project scoping is trivial in SQL. We adopt Engram's design patterns (session model, topic_key upserts, deduplication, privacy stripping) without its limitations.

### Decision: Inngest over BullMQ/custom queue

**Choice**: Inngest (cloud) with BullMQ migration path
**Alternatives considered**: BullMQ + Redis (requires managing Redis infrastructure), in-process (webhook timeouts)
**Rationale**: Inngest is zero-infra: no Redis server, no worker processes. 50k events/month free. Step-based checkpointing means LLM retries don't re-run static analysis. If quota is hit, the server falls back to sync static-analysis-only mode. Migration to BullMQ is documented as a known escalation path.

### Decision: Binary execution for static analysis over microservices

**Choice**: Execute Semgrep/Trivy/CPD as child processes from the core package
**Alternatives considered**: Separate Python microservice for Semgrep (v1 approach — extra deploy, extra Docker image, extra API surface)
**Rationale**: Calling binaries directly eliminates network latency, SSRF concerns, and the need to deploy/manage separate services. All three tools output JSON. Graceful degradation if a binary is missing.

### Decision: pnpm workspaces + Turborepo over Nx/Lerna

**Choice**: pnpm workspaces + Turborepo
**Alternatives considered**: Nx (overkill for 6 packages), Lerna (deprecated patterns), yarn workspaces (slower)
**Rationale**: pnpm is the fastest package manager with strict dependency isolation. Turborepo adds incremental builds and task caching with minimal config. Standard choice for TypeScript monorepos.

## Data Flow

### Review Pipeline (SaaS Mode)

```
GitHub PR Event
    │
    ▼
┌─────────────────┐
│  apps/server     │  Hono webhook endpoint
│  (verify sig)    │  Responds HTTP 200 immediately
└────────┬────────┘
         │ Inngest event: "ghagga/review.requested"
         ▼
┌─────────────────────────────────────────────────────┐
│  Inngest Durable Function                           │
│                                                     │
│  Step 1: Fetch PR diff from GitHub API              │
│          ▼                                          │
│  Step 2: Layer 0 - Static Analysis (parallel)       │
│          ┌────────────┬──────────┬───────────┐      │
│          │ Semgrep    │ Trivy    │ CPD       │      │
│          └─────┬──────┴────┬─────┴─────┬─────┘      │
│                └───────────┼───────────┘             │
│          ▼                 ▼                          │
│  Step 3: Layer 1 - Memory search (past observations)│
│          ▼                                          │
│  Step 4: Layer 2 - AI Agent(s) per review mode      │
│          (receives: diff + static findings + memory) │
│          ▼                                          │
│  Step 5: Layer 3 - Save observations to memory      │
│          ▼                                          │
│  Step 6: Post PR comment to GitHub                  │
└─────────────────────────────────────────────────────┘
```

### Review Pipeline (CLI Mode)

```
User: npx ghagga review
    │
    ▼
┌─────────────────┐
│  apps/cli        │  Parse args, compute diff from git
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  packages/core   │  Same pipeline (no Inngest, direct execution)
│  (sync mode)     │  Memory: skipped (no database)
└────────┬────────┘
         │
         ▼
   stdout (markdown/json/sarif)
```

### Review Pipeline (GitHub Action Mode)

```
PR Event → .github/workflows/ghagga.yml
    │
    ▼
┌─────────────────┐
│  apps/action     │  Read event, compute diff
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  packages/core   │  Same pipeline (no Inngest, no memory)
│  (sync mode)     │  Static tools from container
└────────┬────────┘
         │
         ▼
   GitHub PR comment (via GITHUB_TOKEN)
```

## File Changes

| File                                      | Action | Description                                  |
| ----------------------------------------- | ------ | -------------------------------------------- |
| `package.json`                            | Create | Root workspace config (pnpm + Turborepo)     |
| `pnpm-workspace.yaml`                     | Create | Workspace package definitions                |
| `turbo.json`                              | Create | Turborepo pipeline config                    |
| `tsconfig.base.json`                      | Create | Shared TypeScript config                     |
| `.gitignore`                              | Create | Standard Node.js + build ignores             |
| `packages/core/package.json`              | Create | Core engine package                          |
| `packages/core/src/index.ts`              | Create | Public API exports                           |
| `packages/core/src/pipeline.ts`           | Create | Review pipeline orchestrator                 |
| `packages/core/src/agents/simple.ts`      | Create | Simple review agent                          |
| `packages/core/src/agents/workflow.ts`    | Create | Workflow multi-agent orchestrator            |
| `packages/core/src/agents/consensus.ts`   | Create | Consensus voting engine                      |
| `packages/core/src/agents/prompts.ts`     | Create | All agent prompts (rescued from v1)          |
| `packages/core/src/tools/semgrep.ts`      | Create | Semgrep binary runner                        |
| `packages/core/src/tools/trivy.ts`        | Create | Trivy binary runner                          |
| `packages/core/src/tools/cpd.ts`          | Create | PMD/CPD binary runner                        |
| `packages/core/src/tools/runner.ts`       | Create | Parallel tool execution orchestrator         |
| `packages/core/src/memory/search.ts`      | Create | Memory search (tsvector queries)             |
| `packages/core/src/memory/persist.ts`     | Create | Observation persistence                      |
| `packages/core/src/memory/context.ts`     | Create | Memory-to-prompt formatter                   |
| `packages/core/src/memory/privacy.ts`     | Create | Privacy stripping (rescued from v1)          |
| `packages/core/src/providers/index.ts`    | Create | Vercel AI SDK provider setup                 |
| `packages/core/src/providers/fallback.ts` | Create | Provider fallback chain                      |
| `packages/core/src/utils/diff.ts`         | Create | Diff parsing and truncation                  |
| `packages/core/src/utils/stack-detect.ts` | Create | Tech stack detection (rescued from v1)       |
| `packages/core/src/utils/token-budget.ts` | Create | Token budget management                      |
| `packages/core/src/types.ts`              | Create | Shared type definitions                      |
| `packages/db/package.json`                | Create | Database package                             |
| `packages/db/src/schema.ts`               | Create | Drizzle table schemas                        |
| `packages/db/src/queries.ts`              | Create | Typed database queries                       |
| `packages/db/src/migrate.ts`              | Create | Migration runner                             |
| `packages/db/src/crypto.ts`               | Create | AES-256-GCM key encryption                   |
| `packages/db/drizzle.config.ts`           | Create | Drizzle CLI config                           |
| `apps/server/package.json`                | Create | Server package                               |
| `apps/server/src/index.ts`                | Create | Hono app entry point                         |
| `apps/server/src/routes/webhook.ts`       | Create | GitHub webhook handler                       |
| `apps/server/src/routes/api.ts`           | Create | Dashboard REST API routes                    |
| `apps/server/src/middleware/auth.ts`      | Create | GitHub OAuth token verification              |
| `apps/server/src/inngest/client.ts`       | Create | Inngest client setup                         |
| `apps/server/src/inngest/review.ts`       | Create | Review durable function                      |
| `apps/server/src/github/client.ts`        | Create | GitHub API client (diff, comments)           |
| `apps/dashboard/package.json`             | Create | Dashboard package                            |
| `apps/dashboard/src/main.tsx`             | Create | React entry point                            |
| `apps/dashboard/src/App.tsx`              | Create | Router + layout                              |
| `apps/dashboard/src/pages/*`              | Create | Dashboard, Reviews, Settings, Memory pages   |
| `apps/dashboard/src/components/*`         | Create | shadcn/ui components + custom components     |
| `apps/dashboard/src/lib/api.ts`           | Create | API client (TanStack Query)                  |
| `apps/dashboard/src/lib/auth.ts`          | Create | Auth context + GitHub OAuth                  |
| `apps/cli/package.json`                   | Create | CLI package                                  |
| `apps/cli/src/index.ts`                   | Create | CLI entry point (commander.js)               |
| `apps/cli/src/commands/review.ts`         | Create | Review command                               |
| `apps/action/action.yml`                  | Create | GitHub Action definition                     |
| `apps/action/src/index.ts`                | Create | Action entry point                           |
| `Dockerfile`                              | Create | Multi-stage build with Semgrep + Trivy + CPD |
| `docker-compose.yml`                      | Create | Local dev setup (server + postgres)          |

## Interfaces / Contracts

### Core Review Pipeline Input/Output

```typescript
// packages/core/src/types.ts

interface ReviewInput {
  diff: string;
  mode: 'simple' | 'workflow' | 'consensus';
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  apiKey: string;
  settings: {
    enableSemgrep: boolean;
    enableTrivy: boolean;
    enableCpd: boolean;
    enableMemory: boolean;
    customRules: string[];
    ignorePatterns: string[];
    reviewLevel: 'soft' | 'normal' | 'strict';
  };
  context?: {
    repoFullName: string;
    prNumber: number;
    commitMessages: string[];
    fileList: string[];
  };
  // Database connection for memory (optional — CLI/Action may not have it)
  db?: DrizzleClient;
}

interface ReviewResult {
  status: 'PASSED' | 'FAILED' | 'NEEDS_HUMAN_REVIEW' | 'SKIPPED';
  summary: string;
  findings: ReviewFinding[];
  staticAnalysis: StaticAnalysisResult;
  memoryContext: string | null;
  metadata: {
    mode: string;
    provider: string;
    model: string;
    tokensUsed: number;
    executionTimeMs: number;
    toolsRun: string[];
    toolsSkipped: string[];
  };
}

interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  source: 'ai' | 'semgrep' | 'trivy' | 'cpd';
}

interface StaticAnalysisResult {
  semgrep: ToolResult;
  trivy: ToolResult;
  cpd: ToolResult;
}

interface ToolResult {
  status: 'success' | 'skipped' | 'error';
  findings: ReviewFinding[];
  error?: string;
  executionTimeMs: number;
}
```

### Database Schema (Drizzle)

```typescript
// packages/db/src/schema.ts

import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export const installations = pgTable('installations', {
  id: serial('id').primaryKey(),
  githubInstallationId: integer('github_installation_id').unique().notNull(),
  accountLogin: varchar('account_login', { length: 255 }).notNull(),
  accountType: varchar('account_type', { length: 20 }).notNull(), // 'User' | 'Organization'
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const repositories = pgTable('repositories', {
  id: serial('id').primaryKey(),
  githubRepoId: integer('github_repo_id').unique().notNull(),
  installationId: integer('installation_id').references(() => installations.id),
  fullName: varchar('full_name', { length: 255 }).notNull(), // "owner/repo"
  isActive: boolean('is_active').default(true),
  settings: jsonb('settings').$type<RepoSettings>().default(DEFAULT_SETTINGS),
  encryptedApiKey: text('encrypted_api_key'),
  llmProvider: varchar('llm_provider', { length: 50 }).default('anthropic'),
  llmModel: varchar('llm_model', { length: 100 }),
  reviewMode: varchar('review_mode', { length: 20 }).default('simple'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  repositoryId: integer('repository_id').references(() => repositories.id),
  prNumber: integer('pr_number').notNull(),
  status: varchar('status', { length: 30 }).notNull(), // PASSED | FAILED | NEEDS_HUMAN_REVIEW | SKIPPED
  mode: varchar('mode', { length: 20 }).notNull(),
  summary: text('summary'),
  findings: jsonb('findings').$type<ReviewFinding[]>(),
  tokensUsed: integer('tokens_used').default(0),
  executionTimeMs: integer('execution_time_ms'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const memorySessions = pgTable(
  'memory_sessions',
  {
    id: serial('id').primaryKey(),
    project: varchar('project', { length: 255 }).notNull(), // "owner/repo"
    prNumber: integer('pr_number'),
    summary: text('summary'),
    startedAt: timestamp('started_at').defaultNow(),
    endedAt: timestamp('ended_at'),
  },
  (t) => [index('idx_memory_sessions_project').on(t.project)],
);

export const memoryObservations = pgTable(
  'memory_observations',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id').references(() => memorySessions.id),
    project: varchar('project', { length: 255 }).notNull(),
    type: varchar('type', { length: 30 }).notNull(), // decision | pattern | bugfix | learning | architecture | config | discovery
    title: varchar('title', { length: 500 }).notNull(),
    content: text('content').notNull(),
    topicKey: varchar('topic_key', { length: 255 }),
    filePaths: jsonb('file_paths').$type<string[]>().default([]),
    contentHash: varchar('content_hash', { length: 64 }),
    revisionCount: integer('revision_count').default(1),
    // tsvector column for full-text search — created via raw SQL migration
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => [
    index('idx_observations_project').on(t.project),
    index('idx_observations_topic_key').on(t.topicKey),
    index('idx_observations_type').on(t.type),
  ],
);
```

### Inngest Review Function

```typescript
// apps/server/src/inngest/review.ts

export const reviewFunction = inngest.createFunction(
  {
    id: 'ghagga-review',
    retries: 3,
  },
  { event: 'ghagga/review.requested' },
  async ({ event, step }) => {
    const { owner, repo, prNumber, installationId } = event.data;

    // Step 1: Fetch config and diff
    const { config, diff } = await step.run('fetch-context', async () => {
      // ...fetch from GitHub API and database
    });

    // Step 2: Static Analysis (Layer 0)
    const staticResults = await step.run('static-analysis', async () => {
      return runStaticAnalysis(diff, config.settings);
    });

    // Step 3: Memory Search (Layer 1)
    const memoryContext = await step.run('memory-search', async () => {
      if (!config.settings.enableMemory) return null;
      return searchMemory(db, `${owner}/${repo}`, diff);
    });

    // Step 4: AI Review (Layer 2)
    const reviewResult = await step.run('ai-review', async () => {
      return executeReview({
        diff,
        mode: config.reviewMode,
        provider: config.llmProvider,
        model: config.llmModel,
        apiKey: decrypt(config.encryptedApiKey),
        staticFindings: staticResults,
        memoryContext,
        settings: config.settings,
      });
    });

    // Step 5: Save Memory (Layer 3)
    await step.run('save-memory', async () => {
      if (!config.settings.enableMemory) return;
      return saveObservations(db, `${owner}/${repo}`, prNumber, reviewResult);
    });

    // Step 6: Post PR Comment
    await step.run('post-comment', async () => {
      return postGitHubComment(installationId, owner, repo, prNumber, reviewResult);
    });
  },
);
```

## Testing Strategy

| Layer       | What to Test                                                                                                   | Approach                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unit        | Agent prompt construction, diff parsing, token budgeting, stack detection, privacy stripping, consensus voting | Vitest with mocked AI responses          |
| Unit        | Database queries, schema validation, encryption/decryption                                                     | Vitest with test database                |
| Unit        | Static analysis output parsing (Semgrep JSON, Trivy JSON, CPD XML)                                             | Vitest with fixture files                |
| Integration | Full review pipeline (mock LLM, real static analysis)                                                          | Vitest with binary stubs                 |
| Integration | Hono routes (webhook validation, API endpoints)                                                                | Vitest + supertest-like Hono test client |
| Integration | Inngest functions (step execution, retry behavior)                                                             | Inngest test mode                        |
| E2E         | Dashboard login, settings, review browsing                                                                     | Playwright against dev server            |
| E2E         | Full webhook → review → comment flow                                                                           | Test GitHub App against a test repo      |

## Migration / Rollout

No data migration required. GHAGGA v2 starts with a fresh database.

The v1 code remains on `main-bkp` branch indefinitely. If v2 is not ready for production, users can continue using v1 without disruption.

Rollout phases:
1. **Alpha**: Server mode only, tested by maintainer against personal repos
2. **Beta**: CLI + Action modes added, shared with Gentleman Programming community
3. **GA**: Dashboard on GitHub Pages, 1-click deploy buttons, full documentation

## Open Questions

- [ ] Should the GitHub Action use a pre-built Docker image (faster, ~1GB image) or install tools at runtime (slower, smaller footprint)?
- [ ] For the consensus mode, should we allow configuring which providers get which stances, or keep the default assignment?
- [ ] Do we need rate limiting on the Dashboard API beyond what GitHub OAuth provides?
