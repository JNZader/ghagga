# Proposal: Blast-Radius Analysis via Dependency Graph

**Status**: draft  
**Author**: javier  
**Date**: 2026-03-17  

## Intent

Add dependency-graph-aware blast-radius analysis to GHAGGA so the review pipeline only sends changed files **and their transitive dependents** to the LLM, instead of the full diff. This dramatically reduces token consumption and focuses the AI reviewer on code that is actually affected by the change.

## Motivation

GHAGGA currently sends every file in a PR's diff to the LLM review pipeline. For large PRs or monorepos, this means:

| Problem | Impact | Example |
|---------|--------|---------|
| Token waste on unrelated files | Higher cost, slower reviews | Renaming a utility used by 3 files sends 40-file PR to LLM |
| Noise in findings | False positives about files unrelated to the change | Linter findings on untouched files pollute the review |
| Context window saturation | Diff truncation loses important files | 200-file monorepo PR truncated at token budget, dropping the actual blast-radius files |
| No test coverage signal | LLM doesn't know which tests exercise the changed code | Changed function has 5 test files; reviewer doesn't see any of them |

### Impact Numbers (estimated from typical repo analysis)

| Metric | Without blast-radius | With blast-radius |
|--------|---------------------|-------------------|
| Files sent to LLM (avg) | 34 | 5 |
| Files sent to LLM (monorepo) | 245 | 5 |
| Tokens per review (avg) | ~18K | ~2.6K |
| Review relevance | ~40% of findings actionable | ~85% actionable |
| **Reduction factor** | — | **6.8x avg, 49x monorepo** |

## Scope

### In Scope

1. **Graph schema and storage** — JSON-based dependency graph stored in `ghagga/graph` orphan branch
2. **Tree-sitter indexing** — Parse source files to extract imports, exports, function calls, class hierarchy
3. **Graph builder** — Full index on first install, incremental updates on merge to main
4. **Blast-radius computation** — Given changed files, compute transitive dependents + related tests
5. **Pipeline integration** — Filter diff files to blast-radius subset before LLM review
6. **Three deployment modes** — SaaS (read from GitHub API), Runner (build + push), CLI (local SQLite)
7. **Language support** — TypeScript, JavaScript, Python, Go, Java, Rust (via Tree-sitter grammars)
8. **Graceful fallback** — If no graph exists, current behavior (all files) is preserved

### Out of Scope

- Dynamic analysis (runtime call tracing)
- Cross-repository dependency tracking
- Dependency graph visualization UI in dashboard
- Package-level dependencies (npm/pip/go.mod) — only source-level imports
- Graph pruning/garbage collection for deleted files (handled by full re-index)
- Real-time graph updates during PR (graph reflects main branch state)

## Approach

### 1. Graph Storage: `ghagga/graph` Orphan Branch

Store the dependency graph in an orphan branch within each reviewed repository:

```
ghagga/graph (orphan branch)
├── .ghagga/graph.json       # Dependency graph (~50-200KB for 500 files)
└── .ghagga/metadata.json    # Last indexed commit SHA, schema version
```

**Why an orphan branch?**
- SaaS mode has no filesystem access — only GitHub API. A branch is readable via `GET /repos/{owner}/{repo}/contents/.ghagga/graph.json?ref=ghagga/graph` in one API call (~100ms).
- The runner (GH Action) already has repo checkout + write token, so pushing to the branch is trivial.
- No external storage needed (S3, PostgreSQL, etc.) — the graph lives with the code.
- Git history tracks graph evolution; old versions are garbage-collected by Git.

### 2. Three Modes of Operation

| Mode | Reads graph from | Builds graph | Pushes graph |
|------|-----------------|-------------|-------------|
| **SaaS** | GitHub API (`?ref=ghagga/graph`) | No — reads only | No |
| **Runner (GH Action)** | Filesystem (checkout orphan branch) | Yes (Tree-sitter) | Yes (to orphan branch) |
| **CLI** | Local SQLite (`~/.ghagga/graphs/{repo}.db`) | Yes (Tree-sitter, local) | No |

### 3. Graph Contents

Each node in the graph represents a source file. Edges represent dependencies:

- **imports/exports** — `import { foo } from './bar'` creates edge `bar.ts → file.ts`
- **function calls** — `bar.compute()` in `file.ts` creates edge `bar.ts → file.ts`
- **class hierarchy** — `class Dog extends Animal` creates edge `animal.ts → dog.ts`
- **test association** — Files matching `*.test.*`, `*.spec.*`, `test_*` patterns are tagged as tests

### 4. Update Strategy

- **First install**: Full Tree-sitter index of all source files on default branch. Runner pushes initial graph.
- **Incremental on merge to main**: Only re-parse files whose SHA-256 hash changed since last index. Rebuild affected edges only.

### 5. Blast-Radius Computation

Given a set of changed file paths from the PR diff:

1. Load graph (from branch, API, or SQLite)
2. For each changed file, traverse reverse edges (who depends on me?) up to depth 3
3. Collect all files that transitively depend on any changed file
4. Add test files that directly import any file in the blast radius
5. Return the blast-radius file set → pipeline filters diff to these files only

### 6. Pipeline Integration Point

The blast-radius filter inserts between Step 2 (parse diff) and Step 3 (detect stacks) in `pipeline.ts`:

```
Step 2: Parse and filter diff    → allFiles, filteredFiles
Step 2.5: Blast-radius filter    → blastRadiusFiles (subset of filteredFiles)
Step 3: Detect stacks            → uses blastRadiusFiles instead of filteredFiles
```

If the graph is unavailable (no orphan branch, API error, CLI without local graph), the pipeline falls through to the full `filteredFiles` set — exactly the current behavior.

## Affected Modules

| Package | Files | Change Type |
|---------|-------|-------------|
| `packages/core` | `src/graph/schema.ts` (NEW) | Graph type definitions, JSON schema |
| `packages/core` | `src/graph/indexer.ts` (NEW) | Tree-sitter indexing (file → edges) |
| `packages/core` | `src/graph/blast-radius.ts` (NEW) | Reverse traversal, test association |
| `packages/core` | `src/graph/loader.ts` (NEW) | Load graph from JSON, GitHub API, or SQLite |
| `packages/core` | `src/graph/index.ts` (NEW) | Public API barrel export |
| `packages/core` | `src/pipeline.ts` | Insert blast-radius step between parse and stacks |
| `packages/core` | `src/types.ts` | Add `GraphConfig` to `ReviewInput` and `ReviewSettings` |
| `apps/server` | `src/github/client.ts` | Add `fetchGraphFromBranch()` helper |
| `apps/server` | `src/queues/review.ts` | Fetch graph before pipeline, pass to ReviewInput |
| ghagga-runner | `ghagga-graph-index.yml` (NEW) | GH Action workflow for graph indexing |
| ghagga-runner | `scripts/index-graph.ts` (NEW) | Tree-sitter indexing script |
| ghagga-runner | `scripts/push-graph.sh` (NEW) | Push graph to orphan branch |

## Distribution Mode Impact

| Mode | Impact |
|------|--------|
| **SaaS** | Full support — server fetches graph from GitHub API, passes to pipeline |
| **CLI** | Full support — CLI builds local SQLite graph, reads from filesystem |
| **GitHub Action** | Full support — runner builds graph, pushes to branch; SaaS reads it |
| **1-click deploy** | Full support — no infra change needed (graph lives in the repo) |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Tree-sitter parsing errors for edge cases | Medium | Low | Fallback to current behavior; log parsing errors for debugging |
| Large graph.json for monorepos (>2MB) | Medium | Medium | Compress with gzip; GitHub API supports `Accept: application/vnd.github.raw`; cap at 5MB |
| Graph becomes stale if runner doesn't run | Low | Low | Metadata includes `indexedAt` timestamp; pipeline warns if graph is >7 days old |
| Orphan branch clutters repo | Low | Low | Single branch with 2 files; invisible in default GitHub UI |
| Over-pruning: blast radius misses relevant files | Medium | Medium | Conservative traversal depth (3); include direct test files; user can disable via `enableBlastRadius: false` |
| Under-pruning: blast radius too broad for core utilities | Low | Low | Cap at 50 files; if blast radius exceeds 50, fall back to full diff |
| Tree-sitter WASM binaries add ~15MB to runner | Low | Low | Only needed in runner/CLI; SaaS never runs Tree-sitter |
| GitHub API rate limit for graph fetch | Low | Low | Single API call per review; graph is small (<200KB); ETag caching |

## Rollback Plan

Fully reversible:
- Default `enableBlastRadius: false` initially; opt-in via settings
- If graph branch doesn't exist, pipeline uses full diff (current behavior)
- No database migration required (new fields are optional in JSONB settings)
- Runner workflow can be disabled by removing `ghagga-graph-index.yml`
- Orphan branch can be deleted with `git push origin --delete ghagga/graph`

## Acceptance Criteria

1. Runner builds a valid graph.json for a TypeScript/JavaScript repo and pushes to `ghagga/graph` orphan branch
2. SaaS mode fetches graph.json via GitHub API in <200ms
3. Blast-radius computation for a 3-file change returns <20 files on a 500-file repo
4. Pipeline correctly filters diff to blast-radius files when graph is available
5. Pipeline falls back to full diff when no graph branch exists (backward compat)
6. CLI mode builds and queries a local SQLite graph
7. Incremental index only re-parses files that changed since last index
8. Graph schema supports TypeScript, JavaScript, Python, Go, Java, and Rust
9. All existing tests pass without modification
10. New blast-radius module has >90% test coverage
