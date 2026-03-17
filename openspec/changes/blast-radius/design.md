# Design: Blast-Radius Analysis via Dependency Graph

**Status**: draft  
**Spec**: [spec.md](./spec.md)  
**Date**: 2026-03-17  

## Architecture Decisions

### AD1: Orphan Branch Storage (No External Infrastructure)

**Decision**: Store the dependency graph in a `ghagga/graph` orphan branch within each reviewed repo, rather than PostgreSQL, S3, or the GHAGGA server.

**Rationale**: SaaS mode has no filesystem access — only the GitHub API. An orphan branch provides:
- Single API call to read (`GET /repos/{owner}/{repo}/contents/.ghagga/graph.json?ref=ghagga/graph`)
- No new infrastructure (database tables, S3 buckets)
- Graph lives with the code — no cross-service dependency
- Git history provides versioning for free
- The runner already has repo checkout + write token from the existing static analysis workflow

**Alternatives Considered**:
1. **PostgreSQL blob column**: Adds DB schema migration, increases SaaS database size, couples graph to our infra
2. **S3/R2 bucket**: External dependency, requires presigned URLs, IAM credentials per customer
3. **Rebuild graph per-review**: Too slow for SaaS (no filesystem, no Tree-sitter available); CLI feasible but wastes time
4. **npm package metadata**: Only covers package-level deps, not file-level imports

### AD2: JSON Graph Format (Not Binary)

**Decision**: Use plain JSON for graph.json, not a binary format like Protocol Buffers or FlatBuffers.

**Rationale**:
- Human-readable for debugging
- GitHub API returns it as-is (no base64 decode needed with `Accept: application/vnd.github.raw`)
- ~150KB for a 500-file repo — well within API limits
- JSON.parse is fast enough: <5ms for 2MB on modern V8

**Size Estimates**:
| Repo size | Nodes | Estimated graph.json |
|-----------|-------|---------------------|
| Small (50 files) | 50 | ~15KB |
| Medium (500 files) | 500 | ~150KB |
| Large (2000 files) | 2000 | ~600KB |
| Monorepo (5000 files) | 5000 | ~1.5MB |

### AD3: Tree-sitter for Multi-Language Parsing

**Decision**: Use Tree-sitter WASM bindings for source code parsing, not regex or language-specific parsers.

**Rationale**:
- Single parsing framework for all 6 languages
- Accurate AST-based extraction (not regex pattern matching)
- WASM binaries work in both Node.js (runner/CLI) and browser (future dashboard feature)
- Tree-sitter grammars are maintained by the community; we only write the query extractors
- Total WASM binary size: ~15MB for 6 languages (only in runner/CLI, not SaaS)

**Implementation**:
- `tree-sitter` npm package + per-language grammar packages
- One extractor function per language that runs Tree-sitter queries for imports, exports, calls
- Extractors return a uniform `FileAnalysis` shape that the graph builder consumes

### AD4: Depth-Limited Reverse Traversal

**Decision**: Limit blast-radius traversal to depth 3 (configurable), with a hard cap of 50 files.

**Rationale**:
- Depth 1 (direct dependents) catches ~80% of relevant files
- Depth 2-3 catches chain effects (`A imports B imports C` — if C changes, A may be affected)
- Beyond depth 3, the graph approaches "everything depends on everything" in most codebases
- The 50-file cap prevents a core utility change from turning blast-radius into the full repo

**Traversal Algorithm**:
```
BFS from changed files:
  queue = changedFiles
  visited = Set()
  depth = 0
  while queue not empty and depth < maxDepth:
    nextQueue = []
    for each file in queue:
      for each dependent in reverseDependents(file):
        if dependent not in visited:
          visited.add(dependent)
          nextQueue.push(dependent)
    queue = nextQueue
    depth++
  
  // Add direct tests for any file in the blast radius
  for each file in visited + changedFiles:
    for each test in testFilesImporting(file):
      visited.add(test)
  
  return visited + changedFiles
```

### AD5: CLI Uses SQLite Instead of Branch

**Decision**: CLI stores the graph in local SQLite (`~/.ghagga/graphs/{repo-slug}.db`), not the orphan branch.

**Rationale**:
- CLI has filesystem access — no need for the GitHub API roundtrip
- SQLite is already a dependency (used for memory storage)
- Local graph can be queried with SQL for debugging
- The CLI can build the graph locally without pushing to the repo (no write permissions needed)
- Users who only use CLI never pollute their repo with the orphan branch

## Graph Schema

### graph.json

```typescript
interface DependencyGraph {
  /** Schema version for forward compatibility */
  version: 1;
  
  /** Base path for all relative file paths */
  rootDir: string;
  
  /** File nodes keyed by relative path */
  nodes: Record<string, GraphNode>;
}

interface GraphNode {
  /** SHA-256 hash of file content (for incremental indexing) */
  hash: string;
  
  /** Detected language */
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'rust';
  
  /** Relative paths of files this file imports from */
  imports: string[];
  
  /** Exported symbol names (for cross-reference) */
  exports: string[];
  
  /** Cross-file function/method calls */
  calls: Array<{ target: string; symbol: string }>;
  
  /** True if file matches test patterns */
  isTest: boolean;
}
```

### metadata.json

```typescript
interface GraphMetadata {
  /** Full SHA of the commit that was last indexed */
  lastIndexedCommit: string;
  
  /** ISO 8601 timestamp */
  lastIndexedAt: string;
  
  /** Must match graph.version */
  schemaVersion: number;
  
  /** Total nodes in the graph */
  fileCount: number;
  
  /** Languages present */
  languages: string[];
  
  /** Indexing duration in milliseconds */
  indexDurationMs: number;
}
```

### SQLite Schema (CLI mode)

```sql
CREATE TABLE graph_nodes (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  exports TEXT NOT NULL,  -- JSON array
  is_test INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE graph_edges (
  source TEXT NOT NULL,     -- importing file
  target TEXT NOT NULL,     -- imported file
  edge_type TEXT NOT NULL,  -- 'import' | 'call' | 'extends'
  symbol TEXT,              -- function/class name for calls
  PRIMARY KEY (source, target, edge_type),
  FOREIGN KEY (source) REFERENCES graph_nodes(path),
  FOREIGN KEY (target) REFERENCES graph_nodes(path)
);

CREATE TABLE graph_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_edges_target ON graph_edges(target);  -- for reverse lookups
```

## Data Flow

### Flow 1: Graph Indexing (Runner)

```
Merge to main
  → Server dispatches ghagga-graph-index.yml workflow
  → Runner checks out repo at HEAD
  → Runner checks out ghagga/graph branch (or creates it)
  → Runner loads existing graph.json (if incremental)
  → For each source file:
      - Compute SHA-256 hash
      - If hash differs from graph or file is new:
          - Parse with Tree-sitter
          - Extract imports, exports, calls, class hierarchy
          - Write GraphNode
  → Remove nodes for deleted files
  → Write graph.json + metadata.json
  → git commit + push to ghagga/graph
  → Callback to server with success
```

### Flow 2: Blast-Radius in SaaS Review

```
PR webhook → Review queue → processReview()
  → Step 1: Fetch diff, commit messages, file list (existing)
  → Step 2: Parse + filter diff (existing)
  → Step 2.5 (NEW): Blast-radius filter
      → fetchGraphFromBranch(owner, repo, token)
          → GET /repos/{owner}/{repo}/contents/.ghagga/graph.json?ref=ghagga/graph
          → Parse JSON → DependencyGraph
      → computeBlastRadius(graph, changedFiles)
          → BFS reverse traversal (depth 3)
          → Add test files
          → Cap at 50 files
      → Filter filteredFiles to blast-radius set
  → Step 3: Detect stacks (on blast-radius files)
  → Step 4-8: Continue as before
```

### Flow 3: Blast-Radius in CLI Review

```
ghagga review (local)
  → Step 1: Generate diff from git (existing)
  → Step 2: Parse + filter diff (existing)
  → Step 2.5 (NEW): Blast-radius filter
      → loadGraphFromSQLite(repoSlug)
          → If no local DB: buildLocalGraph() → save to SQLite
          → If DB exists: load graph from SQLite
      → computeBlastRadius(graph, changedFiles)
      → Filter filteredFiles to blast-radius set
  → Continue as before
```

## Implementation Map

### Layer 1: Graph Types & Schema (no dependencies)

```
packages/core/src/graph/schema.ts (NEW)
├── DependencyGraph interface
├── GraphNode interface
├── GraphMetadata interface
├── GRAPH_VERSION constant (1)
├── MAX_GRAPH_SIZE_BYTES constant (5MB)
├── MAX_BLAST_RADIUS_FILES constant (50)
├── DEFAULT_TRAVERSAL_DEPTH constant (3)
├── TEST_FILE_PATTERNS constant
├── EXCLUDED_DIRS constant (node_modules, vendor, etc.)
├── isTestFile(path: string): boolean
└── validateGraph(json: unknown): DependencyGraph | null
```

### Layer 2: Blast-Radius Computation (depends on Layer 1)

```
packages/core/src/graph/blast-radius.ts (NEW)
├── computeBlastRadius(graph, changedFiles, options?): BlastRadiusResult
│   ├── Build reverse-adjacency map from graph.nodes[*].imports
│   ├── BFS from changedFiles with depth limit
│   ├── Add test files for all files in radius
│   ├── Check cap (MAX_BLAST_RADIUS_FILES)
│   └── Return { files, stats, fallback? }
├── buildReverseIndex(graph): Map<string, string[]>
└── BlastRadiusResult interface
    ├── files: string[]
    ├── changedFiles: string[]
    ├── dependents: string[]
    ├── testFiles: string[]
    ├── depth: number
    └── exceededCap: boolean
```

### Layer 3: Graph Loading (depends on Layer 1)

```
packages/core/src/graph/loader.ts (NEW)
├── GraphLoader interface
│   ├── load(): Promise<DependencyGraph | null>
│   └── loadMetadata(): Promise<GraphMetadata | null>
├── GitHubApiGraphLoader implements GraphLoader
│   ├── constructor(owner, repo, token)
│   ├── load() → fetch from ghagga/graph branch via API
│   └── loadMetadata() → fetch metadata.json
├── FilesystemGraphLoader implements GraphLoader
│   ├── constructor(graphDir: string)
│   ├── load() → read from filesystem
│   └── loadMetadata() → read from filesystem
└── NullGraphLoader implements GraphLoader (always returns null)
```

### Layer 4: Tree-sitter Indexer (depends on Layer 1) — Runner/CLI only

```
packages/core/src/graph/indexer.ts (NEW)
├── FileAnalysis interface
│   ├── imports: string[]
│   ├── exports: string[]
│   ├── calls: Array<{ target: string; symbol: string }>
│   └── isTest: boolean
├── analyzeFile(filePath, content, language): FileAnalysis
├── resolveImportPath(importSpec, fromFile, config?): string | null
├── buildGraph(rootDir, options?): Promise<DependencyGraph>
│   ├── Walk directory tree (skip excluded dirs)
│   ├── For each supported file:
│   │   ├── Compute SHA-256 hash
│   │   ├── Parse with Tree-sitter
│   │   └── Extract FileAnalysis
│   ├── Resolve import paths to relative file paths
│   └── Assemble DependencyGraph
└── updateGraphIncremental(existingGraph, rootDir): Promise<DependencyGraph>
    ├── Compare hashes
    ├── Re-parse changed files only
    └── Return updated graph
```

### Layer 5: Language Extractors (depends on Layer 4)

```
packages/core/src/graph/extractors/ (NEW directory)
├── typescript.ts   — TS/JS/TSX/JSX import/export/call extraction
├── python.ts       — Python import extraction (from/import, relative)
├── go.ts           — Go import extraction (package-level)
├── java.ts         — Java import extraction (package/class)
├── rust.ts         — Rust use/mod extraction
└── index.ts        — Extractor registry: language → extractFn
```

### Layer 6: Pipeline Integration (depends on Layers 2, 3)

```
packages/core/src/pipeline.ts (MODIFY)
├── Add import for graph modules
├── Add Step 2.5: blastRadiusFilter()
│   ├── Load graph (via GraphLoader)
│   ├── Compute blast radius
│   ├── Filter filteredFiles
│   ├── Emit progress event
│   └── Return filtered files + metadata
├── Add blastRadius field to ReviewResult.metadata
└── Pass GraphLoader from ReviewInput (injected by caller)

packages/core/src/types.ts (MODIFY)
├── Add GraphConfig to ReviewSettings:
│   ├── enableBlastRadius?: boolean (default false initially)
│   ├── maxBlastRadiusFiles?: number (default 50)
│   ├── traversalDepth?: number (default 3)
├── Add graphLoader?: GraphLoader to ReviewInput
├── Add blastRadius?: BlastRadiusMetadata to ReviewMetadata
```

### Layer 7: SaaS Integration (depends on Layers 3, 6)

```
apps/server/src/github/client.ts (MODIFY)
├── fetchGraphFromBranch(owner, repo, token): Promise<DependencyGraph | null>
│   ├── GET /repos/{owner}/{repo}/contents/.ghagga/graph.json?ref=ghagga/graph
│   ├── Accept: application/vnd.github.raw
│   ├── Handle 404 → return null
│   └── Parse + validate → DependencyGraph | null
└── fetchGraphMetadata(owner, repo, token): Promise<GraphMetadata | null>

apps/server/src/queues/review.ts (MODIFY)
├── Before calling reviewPipeline:
│   ├── Fetch graph from ghagga/graph branch
│   ├── Create GitHubApiGraphLoader
│   └── Pass to ReviewInput.graphLoader
```

### Layer 8: Runner Workflow (ghagga-runner repo)

```
ghagga-runner/.github/workflows/ghagga-graph-index.yml (NEW)
├── workflow_dispatch trigger
├── Inputs: repoFullName, headSha, callbackUrl, callbackId, callbackSecret, incremental
├── Steps:
│   ├── Checkout target repo at headSha
│   ├── Checkout ghagga/graph branch (or create orphan)
│   ├── Install Tree-sitter + grammars
│   ├── Run indexer script
│   ├── Commit + push graph.json + metadata.json
│   └── POST callback to server

ghagga-runner/scripts/index-graph.ts (NEW)
├── CLI entry point for the indexer
├── Reads existing graph if incremental
├── Calls buildGraph() or updateGraphIncremental()
├── Writes graph.json + metadata.json
└── Exits with 0 on success, 1 on error
```

### Layer 9: Graph Barrel Export

```
packages/core/src/graph/index.ts (NEW)
├── export { DependencyGraph, GraphNode, GraphMetadata } from './schema.js'
├── export { computeBlastRadius, BlastRadiusResult } from './blast-radius.js'
├── export { GraphLoader, GitHubApiGraphLoader, FilesystemGraphLoader } from './loader.js'
├── export { buildGraph, updateGraphIncremental } from './indexer.js'
└── export { analyzeFile } from './indexer.js'

packages/core/src/index.ts (MODIFY)
├── Add export * from './graph/index.js'
```

## Sequence Diagram: Full SaaS Review with Blast-Radius

```
PR Webhook → Review Queue
  │
  │── [1] getInstallationToken()
  │── [2] Promise.all([fetchPRDiff, getCommitMessages, getPRFileList])
  │── [3] fetchGraphFromBranch(owner, repo, token)
  │        │
  │        └── GET .ghagga/graph.json?ref=ghagga/graph
  │            ├── 200 OK → parse JSON → DependencyGraph
  │            └── 404 → return null (no graph)
  │
  │── [4] Create GitHubApiGraphLoader with preloaded graph
  │── [5] Build ReviewInput with graphLoader
  │
  └── [6] reviewPipeline(input)
          │
          │── Step 1: validateInput
          │── Step 2: parseDiffFiles → filterDiffFiles
          │── Step 2.5: blastRadiusFilter  ← NEW
          │        │
          │        ├── graph = await graphLoader.load()
          │        ├── if (!graph) → skip, use full filteredFiles
          │        ├── result = computeBlastRadius(graph, fileList)
          │        ├── if (result.exceededCap) → use full filteredFiles + warn
          │        └── filteredFiles = filteredFiles.filter(f => result.files.has(f.path))
          │
          │── Step 3: detectStacks (on blast-radius files)
          │── Step 4: truncateDiff (on blast-radius files — much smaller!)
          │── Step 5-8: Continue as before
          │
          └── Return ReviewResult with metadata.blastRadius
```

## Sequence Diagram: Runner Graph Indexing

```
Merge to main → Webhook → Server
  │
  │── dispatchGraphIndexWorkflow(owner, repo, headSha)
  │       │
  │       └── POST /repos/{owner}/ghagga-runner/actions/workflows/ghagga-graph-index.yml/dispatches
  │
  └── Runner starts ghagga-graph-index.yml
          │
          │── [1] Checkout {repo} at {headSha}
          │── [2] git fetch origin ghagga/graph:ghagga/graph 2>/dev/null || git checkout --orphan ghagga/graph
          │── [3] Load existing .ghagga/graph.json (if incremental + exists)
          │── [4] Walk directory → detect languages → skip excluded dirs
          │── [5] For each source file:
          │        ├── SHA-256 hash → compare with existing graph
          │        ├── If changed/new: Tree-sitter parse → extract imports/exports/calls
          │        └── If unchanged: keep existing node
          │── [6] Assemble DependencyGraph JSON
          │── [7] Write .ghagga/graph.json + .ghagga/metadata.json
          │── [8] git add .ghagga/ && git commit && git push origin ghagga/graph
          │── [9] POST callbackUrl with success status
          │
          └── Server receives callback → log "graph updated for {repo}"
```

## Tree-sitter Extractor Architecture

Each language extractor follows the same pattern:

```typescript
interface LanguageExtractor {
  /** Tree-sitter language grammar */
  language: Language;
  
  /** File extensions this extractor handles */
  extensions: string[];
  
  /** Extract imports, exports, and calls from a parsed tree */
  extract(tree: Tree, sourceCode: string, filePath: string): FileAnalysis;
}
```

### TypeScript/JavaScript Extractor Queries

```typescript
// Import extraction
const IMPORT_QUERY = `
  (import_statement
    source: (string (string_fragment) @source))
  (import_clause
    source: (string (string_fragment) @source))
  (call_expression
    function: (identifier) @fn (#eq? @fn "require")
    arguments: (arguments (string (string_fragment) @source)))
`;

// Export extraction
const EXPORT_QUERY = `
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (class_declaration name: (type_identifier) @name)
      (lexical_declaration (variable_declarator name: (identifier) @name))
    ])
  (export_statement
    (export_clause (export_specifier name: (identifier) @name)))
`;
```

### Python Extractor Queries

```typescript
const IMPORT_QUERY = `
  (import_statement
    name: (dotted_name) @module)
  (import_from_statement
    module_name: (dotted_name) @module)
  (import_from_statement
    module_name: (relative_import) @module)
`;
```

### Import Path Resolution

```typescript
function resolveImportPath(
  importSpec: string,
  fromFile: string,
  config?: { tsconfigPaths?: Record<string, string[]> }
): string | null {
  // 1. Skip external packages (no leading . or /)
  if (!importSpec.startsWith('.') && !importSpec.startsWith('/')) {
    // Check tsconfig paths for aliases like @/utils
    if (config?.tsconfigPaths) {
      for (const [alias, paths] of Object.entries(config.tsconfigPaths)) {
        const pattern = alias.replace('*', '');
        if (importSpec.startsWith(pattern)) {
          const resolved = paths[0]?.replace('*', importSpec.slice(pattern.length));
          if (resolved) return resolved;
        }
      }
    }
    return null; // external package — not in graph
  }
  
  // 2. Resolve relative path
  const dir = path.dirname(fromFile);
  const resolved = path.join(dir, importSpec);
  
  // 3. Try extensions: .ts, .tsx, .js, .jsx, /index.ts, /index.js
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
    const candidate = resolved + ext;
    if (fileExists(candidate)) return candidate;
  }
  
  return null;
}
```

## Error Handling Strategy

| Error | Location | Handling |
|-------|----------|----------|
| GitHub API 404 (no branch) | `GitHubApiGraphLoader.load()` | Return `null` → pipeline uses full diff |
| GitHub API timeout | `GitHubApiGraphLoader.load()` | Return `null` with warning → pipeline uses full diff |
| graph.json parse error | `validateGraph()` | Return `null` with error log → pipeline uses full diff |
| graph.json version mismatch | `validateGraph()` | Return `null` with warning → pipeline uses full diff |
| Tree-sitter parse error (single file) | `analyzeFile()` | Log error, skip file, continue indexing |
| Tree-sitter grammar not available | `analyzeFile()` | Skip file (unsupported language) |
| Graph push fails (runner) | Runner workflow | Retry once, then report failure in callback |
| SQLite graph corrupt (CLI) | `loadGraphFromSQLite()` | Delete and rebuild from scratch |
| Blast-radius exceeds cap | `computeBlastRadius()` | Return `exceededCap: true` → pipeline uses full diff |

## No Breaking Changes

This feature is purely additive:

- **New files**: All graph-related code is in `packages/core/src/graph/` (new directory)
- **Pipeline change**: One new step inserted between existing steps, guarded by `if (graphLoader)`
- **Type additions**: All new fields are optional (`enableBlastRadius?: boolean`, `graphLoader?: GraphLoader`)
- **Default behavior**: `enableBlastRadius` defaults to `false` initially; when `true` without a graph, falls back to current behavior
- **No database migration**: Settings are JSONB; new fields are optional
