# Contributing to GHAGGA

Thanks for your interest in contributing! This guide covers everything you need to get the project running locally and submit high-quality PRs.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 22+ | Required for all packages |
| **pnpm** | 9+ | Exact version managed via `packageManager` in root `package.json` |
| **Docker** | Any recent | For local PostgreSQL (or use a remote Postgres instance) |
| **Git** | 2.x+ | Conventional commit messages expected |

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/JNZader/ghagga.git
cd ghagga

# 2. Install dependencies
pnpm install

# 3. Start PostgreSQL (local Docker)
docker compose up postgres -d
# Wait for the health check to pass (~5 seconds)

# 4. Copy and configure environment variables
cp .env.example .env
# Edit .env — see .env.example for required vs optional vars

# 5. Push the database schema
pnpm --filter ghagga-db db:push

# 6. Build all packages (order matters: types → db → core → apps)
pnpm build

# 7. Run the test suite
pnpm test
```

If all ~2,859 tests pass, you're ready to develop.

## Project Structure

This is a **pnpm workspace + Turborepo** monorepo. Build order is managed automatically by Turborepo's `dependsOn: ["^build"]` configuration.

### Packages (shared libraries)

| Package | Name | Description |
|---------|------|-------------|
| `packages/types` | `@ghagga/types` | Shared TypeScript API types (dashboard ↔ server contract) |
| `packages/db` | `ghagga-db` | Database layer — Drizzle ORM schema, queries, AES-256-GCM crypto, migrations |
| `packages/core` | `ghagga-core` | Review engine — pipeline, AI agents, static analysis tools, memory, providers |

### Apps (distribution modes)

| App | Name | Description |
|-----|------|-------------|
| `apps/server` | `@ghagga/server` | Hono HTTP server — GitHub webhooks, REST API, Inngest durable functions |
| `apps/dashboard` | `@ghagga/dashboard` | React 19 SPA — review history, settings, memory browser (deployed to GitHub Pages) |
| `apps/cli` | `ghagga` | CLI tool — `ghagga review`, `ghagga memory`, `ghagga hooks`, `ghagga health` (published to npm) |
| `apps/action` | `@ghagga/action` | GitHub Action — runs reviews in CI with `@vercel/ncc` bundle |

### Build Order

Turborepo handles this automatically, but the dependency graph is:

```
@ghagga/types ─┐
               ├──→ ghagga-core ──→ @ghagga/server
ghagga-db ─────┘         │         @ghagga/action
                         └───────→ ghagga (CLI)

@ghagga/types ──→ @ghagga/dashboard
```

## Development Workflow

### Running the Server

```bash
# Start the API server with hot reload (tsx watch)
pnpm --filter @ghagga/server dev
```

### Running the Dashboard

```bash
# Start Vite dev server (React SPA)
pnpm --filter @ghagga/dashboard dev
```

### Running Specific Tests

```bash
# All tests across all packages
pnpm test

# Tests for a specific package
pnpm test --filter=@ghagga/server
pnpm test --filter=ghagga-core
pnpm test --filter=ghagga          # CLI

# Watch mode (single package)
pnpm --filter @ghagga/server test:watch

# Coverage
pnpm test:coverage
```

### Linting & Formatting

This project uses **Biome** (not ESLint/Prettier). Biome handles both linting and formatting in a single tool.

```bash
# Check for issues (read-only)
pnpm lint

# Auto-fix issues (writes files)
pnpm lint:fix
```

Biome configuration is in `biome.json` at the repo root. Key settings:
- 2-space indentation, 100-char line width
- Single quotes, trailing commas
- Import organization via `assist.actions.source.organizeImports`

### Type Checking

```bash
# Typecheck all packages
pnpm typecheck
```

### Database Operations

```bash
# Push schema changes to local PostgreSQL
pnpm --filter ghagga-db db:push

# Generate migration files
pnpm --filter ghagga-db db:generate

# Run migrations
pnpm --filter ghagga-db db:migrate

# Open Drizzle Studio (visual DB browser)
pnpm --filter ghagga-db db:studio
```

### Clean Build

```bash
# Remove all dist/ folders and node_modules
pnpm clean
pnpm install
pnpm build
```

## Testing

- **Framework**: [Vitest](https://vitest.dev/) 4 across all packages
- **Mutation testing**: [Stryker](https://stryker-mutator.io/) for `@ghagga/core` and `@ghagga/server`
- **Dashboard testing**: Testing Library + vitest-axe for accessibility
- **Total**: ~2,859 tests

```bash
# Mutation testing (core only — takes ~10-30 min)
pnpm --filter ghagga-core test:mutate
```

### Test Environment Variables

Tests that need `ENCRYPTION_KEY` use a dummy value. CI sets:

```
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `chore` | Build, CI, dependencies, tooling |
| `docs` | Documentation only |
| `perf` | Performance improvement |
| `style` | Code style (formatting, no logic change) |

### Scopes (optional)

Use the package name without prefix: `core`, `db`, `server`, `dashboard`, `cli`, `action`, `types`.

```
feat(core): add Ollama provider support
fix(server): handle empty diff in webhook handler
test(cli): add coverage for memory search command
docs: update CONTRIBUTING.md with DB setup steps
```

## Pull Request Process

1. **Branch from `main`** — use descriptive branch names:
   - `feat/add-ollama-support`
   - `fix/webhook-empty-diff`
   - `test/cli-memory-coverage`

2. **Make your changes** — follow the code style (Biome will enforce it)

3. **Run the full check locally** before pushing:
   ```bash
   pnpm lint:fix
   pnpm typecheck
   pnpm build
   pnpm test
   ```

4. **Push and open a PR** against `main`

5. **CI must pass** — the pipeline runs these jobs:
    - **Security Audit** — `pnpm audit --prod`
    - **Typecheck & Build** — `pnpm exec turbo typecheck && turbo build`
    - **Lint** — `pnpm lint` (Biome)
    - **Tests + Coverage** — `pnpm exec turbo test:coverage`
    - **Mutation Tests** — Stryker on `packages/core` (main branch only, non-blocking)

6. **PR review** — a maintainer will review your changes

### Merge policy

- `main` is protected
- Pull requests merge with **squash only**
- **Delete branch on merge** is enabled
- Required CI checks must be green before merge

### Repo automation

- **CI**: `.github/workflows/ci.yml` runs on pushes and PRs to `main`; doc-only changes skip heavy jobs cleanly
- **Pages**: `.github/workflows/deploy-pages.yml` publishes the landing page, dashboard, and docs from `main`
- **GHCR**: `.github/workflows/docker.yml` builds and pushes the server image to `ghcr.io`
- **Render**: `render.yaml` is the canonical Blueprint for the hosted server environment
- **Dependabot**: `.github/dependabot.yml` opens weekly npm and GitHub Actions update PRs

## Code Style

### Biome (not ESLint/Prettier)

Biome is the **only** linter and formatter. Do not add ESLint, Prettier, or other formatting tools.

| Setting | Value |
|---------|-------|
| Indent | 2 spaces |
| Line width | 100 characters |
| Quotes | Single quotes |
| Trailing commas | Always |
| Semicolons | Always (default) |

### TypeScript

- **Strict mode** enabled across all packages
- Shared base config in `tsconfig.base.json`
- Prefer `type` imports when importing only types
- No `any` without justification (Biome warns on `noExplicitAny`)

### File Organization

- One module per file, named after the primary export
- Tests live alongside source in `__tests__/` or `*.test.ts` files
- Barrel exports via `index.ts` at package roots

## Local PostgreSQL

The `docker-compose.yml` starts PostgreSQL 16 with these defaults:

| Setting | Value |
|---------|-------|
| Host | `localhost` |
| Port | `5432` |
| Database | `ghagga` |
| User | `ghagga` |
| Password | `ghagga_dev` |

Connection string for `.env`:

```
DATABASE_URL=postgresql://ghagga:ghagga_dev@localhost:5432/ghagga
```

### Common Docker Commands

```bash
# Start PostgreSQL only
docker compose up postgres -d

# Stop everything
docker compose down

# Reset database (delete volume)
docker compose down -v
docker compose up postgres -d
pnpm --filter ghagga-db db:push
```

## Questions?

Open an issue on [GitHub](https://github.com/JNZader/ghagga/issues) or check the [documentation](https://ghagga.javierzader.com/docs/).
