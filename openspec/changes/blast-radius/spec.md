# Spec: Blast-Radius Analysis via Dependency Graph

**Status**: draft  
**Proposal**: [proposal.md](./proposal.md)  
**Date**: 2026-03-17  

## Requirements

### FR-1: Dependency Graph Schema

The system MUST define a JSON schema for the dependency graph stored in `.ghagga/graph.json`.

- Each node MUST represent a source file, keyed by its relative path from repo root
- Each node MUST contain:
  - `hash`: SHA-256 hash of the file content (for incremental indexing)
  - `language`: detected language (`typescript` | `javascript` | `python` | `go` | `java` | `rust`)
  - `imports`: array of relative file paths this file imports from
  - `exports`: array of exported symbol names (functions, classes, constants)
  - `calls`: array of `{ target: filePath, symbol: string }` for cross-file function calls
  - `isTest`: boolean — true if file matches test patterns (`*.test.*`, `*.spec.*`, `test_*`, `*_test.*`)
- The graph MUST include a `version` field (integer, starting at `1`) for schema evolution
- The graph MUST include a `rootDir` field indicating the base path for all relative paths
- The total graph size MUST NOT exceed 5MB uncompressed; files beyond this limit MUST be logged and skipped

### FR-2: Metadata File

The system MUST store indexing metadata in `.ghagga/metadata.json` alongside the graph.

- `lastIndexedCommit`: the full SHA of the commit that was last indexed
- `lastIndexedAt`: ISO 8601 timestamp of the last index operation
- `schemaVersion`: integer matching the graph's `version` field
- `fileCount`: total number of nodes in the graph
- `languages`: array of language strings present in the graph
- `indexDurationMs`: how long the last index took in milliseconds

### FR-3: Tree-Sitter Indexing Engine

The system MUST implement a Tree-sitter-based indexer that parses source files and produces the dependency graph.

- The indexer MUST support these languages via Tree-sitter grammars:
  - TypeScript (`.ts`, `.tsx`)
  - JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
  - Python (`.py`)
  - Go (`.go`)
  - Java (`.java`)
  - Rust (`.rs`)
- For each file, the indexer MUST extract:
  - Import statements → resolved to relative file paths
  - Exported symbols → function names, class names, constants
  - Cross-file function calls → `file.function()` patterns
  - Class inheritance → `extends` / `implements` relationships
- Import path resolution MUST handle:
  - Relative paths (`./foo`, `../bar`)
  - Index files (`./dir` → `./dir/index.ts`)
  - TypeScript path aliases (read from `tsconfig.json` if present)
  - Python relative imports (`from . import foo`, `from ..bar import baz`)
  - Go package imports (resolved within the same module)
- Files not matching any supported language extension MUST be silently skipped
- Files in `node_modules/`, `vendor/`, `.git/`, `__pycache__/`, `target/`, `build/` MUST be excluded
- Parse errors in individual files MUST be logged and the file skipped — not abort the entire index

### FR-4: Incremental Index Updates

The system MUST support incremental updates to avoid full re-indexing on every merge.

- On first install (no existing graph), the indexer MUST perform a full index of all source files
- On subsequent runs, the indexer MUST:
  1. Load the existing graph.json
  2. Compare each file's current SHA-256 hash with the stored `hash` in the graph
  3. Re-parse only files whose hash differs or that are new
  4. Remove nodes for files that no longer exist
  5. Rebuild edges for all re-parsed files
- The incremental update MUST preserve nodes for unchanged files
- The metadata `lastIndexedCommit` MUST be updated to the current HEAD SHA

### FR-5: Blast-Radius Computation

The system MUST compute the blast radius for a set of changed files using the dependency graph.

- Given an array of changed file paths (from the PR diff), the system MUST:
  1. Find all direct dependents (files that import any changed file) — depth 1
  2. Recursively find transitive dependents up to a configurable depth (default: 3)
  3. Add test files that directly import any file in the blast radius
  4. Return the union of changed files + dependents + related tests
- The blast-radius set MUST NOT include the changed files themselves in the "dependent" count (they are always included)
- Circular dependencies MUST be handled: traversal MUST track visited nodes and not revisit them
- If the blast-radius set exceeds `maxBlastRadiusFiles` (default: 50), the system MUST fall back to the full diff file set and emit a warning
- The computation MUST complete in <10ms for graphs with up to 5000 nodes (in-memory traversal)

### FR-6: Graph Loading (Multi-Mode)

The system MUST support loading the dependency graph from three sources depending on deployment mode.

**SaaS mode**:
- Fetch `.ghagga/graph.json` from the `ghagga/graph` branch via GitHub API:
  `GET /repos/{owner}/{repo}/contents/.ghagga/graph.json?ref=ghagga/graph`
- Accept header MUST include `application/vnd.github.raw` for raw content (no base64)
- If the branch does not exist (404), return `null` (fallback to full diff)
- If the file exceeds GitHub's 100MB limit, return `null` with a warning log
- Cache the graph response using the `ETag` header for subsequent requests within the same review
- Also fetch `.ghagga/metadata.json` to check staleness (warn if `lastIndexedAt` > 7 days ago)

**Runner (GH Action) mode**:
- The runner MUST have filesystem access to the graph after checking out the orphan branch
- Read `.ghagga/graph.json` and `.ghagga/metadata.json` from the filesystem
- After indexing, push updated files to the orphan branch

**CLI mode**:
- Store the graph in a local SQLite database at `~/.ghagga/graphs/{repo-slug}.db`
- The SQLite schema MUST mirror the JSON graph structure with tables for nodes and edges
- The CLI MUST NOT require the `ghagga/graph` branch — it is fully local
- The CLI MAY build the graph on first `ghagga review` if no local graph exists

### FR-7: Pipeline Integration

The pipeline (`pipeline.ts`) MUST integrate blast-radius filtering between diff parsing and stack detection.

- A new step "Step 2.5: Blast-radius filter" MUST be inserted after Step 2 (parse/filter diff)
- The step MUST:
  1. Attempt to load the dependency graph (mode-dependent)
  2. If graph is available, compute blast-radius for the changed files
  3. Filter `filteredFiles` to only files in the blast-radius set
  4. Emit a progress event: `"Blast radius: {N} files (from {M} in diff)"`
  5. If blast-radius exceeds `maxBlastRadiusFiles`, emit warning and use full diff
- If graph loading fails (404, timeout, parse error), the step MUST:
  1. Log the error
  2. Continue with the full `filteredFiles` set (current behavior)
  3. Emit progress event: `"Blast radius: skipped (no graph available)"`
- The pipeline MUST NOT block or fail due to graph unavailability
- The blast-radius step MUST add `metadata.blastRadius` to the `ReviewResult`:
  ```typescript
  blastRadius?: {
    enabled: boolean;
    graphAvailable: boolean;
    totalFiles: number;      // files in diff
    blastRadiusFiles: number; // files after blast-radius filter
    fallbackReason?: string;  // why full diff was used (if applicable)
  };
  ```

### FR-8: Runner Graph Indexing Workflow

The ghagga-runner MUST include a new GitHub Actions workflow for building and pushing the dependency graph.

- Workflow file: `ghagga-graph-index.yml`
- Trigger: `workflow_dispatch` (dispatched by the server on installation and on merge to main)
- Steps:
  1. Checkout the target repository at the specified commit
  2. Checkout the `ghagga/graph` orphan branch (create if it doesn't exist)
  3. Run the Tree-sitter indexer
  4. Write `.ghagga/graph.json` and `.ghagga/metadata.json`
  5. Commit and push to the orphan branch
- The workflow MUST accept inputs:
  - `repoFullName`: target repository
  - `headSha`: commit SHA to index
  - `callbackUrl`: server callback for completion notification
  - `callbackId`: correlation ID
  - `callbackSecret`: HMAC signing key
  - `incremental`: boolean (true for updates, false for full re-index)
- The workflow MUST use the repository's own `GITHUB_TOKEN` to push to the orphan branch
- If the orphan branch doesn't exist, the workflow MUST create it:
  ```bash
  git checkout --orphan ghagga/graph
  git rm -rf .
  ```

## Scenarios

### S1: First-time graph indexing on repo installation

**Given** a user installs GHAGGA on a TypeScript monorepo with 500 files  
**And** no `ghagga/graph` branch exists  
**When** the server dispatches the graph indexing workflow  
**Then** the runner performs a full Tree-sitter index of all .ts/.tsx/.js/.jsx files  
**And** produces a graph.json with ~500 nodes and import/export edges  
**And** creates the `ghagga/graph` orphan branch  
**And** pushes `.ghagga/graph.json` (~150KB) and `.ghagga/metadata.json`  
**And** calls the server callback with success status  

### S2: PR review with blast-radius (SaaS mode)

**Given** a repo with an up-to-date graph on the `ghagga/graph` branch  
**And** a PR that modifies `src/utils/format.ts`  
**And** the graph shows `format.ts` is imported by `src/api/handler.ts`, `src/api/router.ts`, and `src/utils/format.test.ts`  
**When** the review pipeline runs  
**Then** the pipeline fetches graph.json from GitHub API in <200ms  
**And** computes blast radius: `format.ts` + `handler.ts` + `router.ts` + `format.test.ts`  
**And** filters the diff to only these 4 files (instead of the full 15-file PR diff)  
**And** sends 4 files to the LLM instead of 15  
**And** `metadata.blastRadius.blastRadiusFiles` is 4  

### S3: PR review without graph (fallback)

**Given** a repo without a `ghagga/graph` branch  
**When** the review pipeline runs  
**Then** the pipeline attempts to fetch graph.json  
**And** GitHub API returns 404  
**And** the pipeline logs "no graph available" and continues  
**And** all filtered files are sent to the LLM (current behavior)  
**And** `metadata.blastRadius.enabled` is true, `graphAvailable` is false  

### S4: Incremental graph update on merge to main

**Given** a repo with an existing graph (last indexed at commit `abc123`)  
**And** a merge to main that modifies 3 files  
**When** the runner graph indexing workflow runs with `incremental: true`  
**Then** the runner loads the existing graph.json  
**And** compares file hashes — only 3 files have changed  
**And** re-parses only those 3 files with Tree-sitter  
**And** updates the graph edges for those 3 files  
**And** pushes the updated graph.json  
**And** updates metadata.lastIndexedCommit to the new merge commit SHA  

### S5: Blast radius exceeds max cap

**Given** a repo where `src/core/types.ts` is imported by 80 files  
**And** a PR modifies `types.ts`  
**When** blast-radius computation runs  
**Then** the blast-radius set has 80+ files (exceeds `maxBlastRadiusFiles: 50`)  
**And** the pipeline falls back to the full diff with a warning  
**And** `metadata.blastRadius.fallbackReason` is `"blast radius exceeds 50 files"`  

### S6: CLI mode with local graph

**Given** a user running `ghagga review` locally  
**And** no local SQLite graph exists for this repo  
**When** the CLI runs  
**Then** the CLI builds a local graph via Tree-sitter (scanning the working directory)  
**And** stores it in `~/.ghagga/graphs/{repo-slug}.db`  
**And** uses the local graph for blast-radius computation  
**And** subsequent reviews use the cached graph (incremental updates)  

### S7: Multi-language repo (TypeScript + Python)

**Given** a repo with both TypeScript and Python source files  
**And** the graph contains nodes for both languages  
**And** a PR modifies `scripts/deploy.py` which is imported by `scripts/main.py`  
**When** blast-radius computation runs  
**Then** the blast radius includes `deploy.py`, `main.py`, and any `test_deploy.py`  
**And** TypeScript files are not in the blast radius (no cross-language edges)  

### S8: Graph staleness warning

**Given** a repo with a graph that was last indexed 14 days ago  
**When** the pipeline loads the graph  
**Then** the pipeline emits a warning: `"Dependency graph is 14 days stale (last indexed: {date})"`  
**And** still uses the graph for blast-radius (stale graph is better than no graph)  
**And** `metadata.blastRadius.graphStale` is true  

## Edge Cases

- **Empty diff**: If the diff has 0 files after filtering, blast-radius is skipped (already handled by pipeline returning SKIPPED)
- **Changed file not in graph**: If a PR modifies a file not tracked in the graph (e.g., a new file or unsupported language), it is included in the blast radius as-is with no dependents
- **Circular imports**: `a.ts → b.ts → c.ts → a.ts` — traversal MUST track visited set and terminate. All three files are in the blast radius.
- **Graph parse error**: If graph.json is malformed, treat as "no graph" — fallback to full diff
- **Graph version mismatch**: If graph.json `version` field doesn't match the expected version, treat as "no graph" with a warning
- **Orphan branch with extra files**: If someone manually adds files to the `ghagga/graph` branch, they are ignored — only `.ghagga/graph.json` and `.ghagga/metadata.json` are read
- **Concurrent graph updates**: If two merges to main trigger simultaneous graph updates, Git's push semantics handle this — the second push will fail, and the runner retries with the updated graph
- **Deleted files in PR**: If a PR deletes a file, its dependents are still in the blast radius (they may have broken imports now)
- **Renamed files**: Treated as delete + add. The old path's dependents and the new path itself are both in the blast radius
- **Binary files in diff**: Already filtered by the existing diff parser; not present in blast-radius input
- **monorepo with multiple tsconfig.json**: The indexer resolves paths relative to the nearest tsconfig.json. If none is found, paths are resolved relative to repo root

## Non-Functional Requirements

- **Performance**: Graph fetch via GitHub API MUST complete in <200ms for graphs up to 2MB
- **Performance**: Blast-radius computation MUST complete in <10ms for graphs with up to 5000 nodes
- **Performance**: Full Tree-sitter index of a 500-file repo MUST complete in <30 seconds
- **Performance**: Incremental index of 10 changed files MUST complete in <3 seconds
- **Storage**: graph.json MUST be <5MB uncompressed for repos with up to 5000 source files
- **Reliability**: Graph unavailability MUST NOT degrade review quality — fallback preserves current behavior
- **Security**: The `ghagga/graph` branch MUST be protected from accidental pushes (only runner workflow pushes)
- **Backward compatibility**: All existing tests MUST pass without modification; graph is opt-in
- **Testability**: Graph indexer, blast-radius computation, and graph loader MUST be independently testable with mock data
- **No new runtime dependencies for SaaS**: Tree-sitter is only required in the runner and CLI. The SaaS server only reads JSON.
