# Tasks: Blast-Radius Analysis via Dependency Graph

**Status**: ready  
**Design**: [design.md](./design.md)  
**Date**: 2026-03-17  

## Phase 1: Graph Types & Schema (foundation — no dependencies)

### 1.1 Create graph schema and types
**File**: `packages/core/src/graph/schema.ts` (NEW)  
**Change**:
- Define `DependencyGraph` interface (version, rootDir, nodes)
- Define `GraphNode` interface (hash, language, imports, exports, calls, isTest)
- Define `GraphMetadata` interface (lastIndexedCommit, lastIndexedAt, schemaVersion, fileCount, languages, indexDurationMs)
- Define `BlastRadiusMetadata` interface (enabled, graphAvailable, totalFiles, blastRadiusFiles, fallbackReason?, graphStale?)
- Define `SupportedLanguage` type union: `'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'rust'`
- Define constants:
  ```typescript
  export const GRAPH_VERSION = 1;
  export const MAX_GRAPH_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
  export const MAX_BLAST_RADIUS_FILES = 50;
  export const DEFAULT_TRAVERSAL_DEPTH = 3;
  export const GRAPH_STALE_DAYS = 7;
  export const TEST_FILE_PATTERNS = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /^test_.*\.py$/,
    /_test\.go$/,
    /Test\.java$/,
    /_test\.rs$/,
  ];
  export const EXCLUDED_DIRS = new Set([
    'node_modules', 'vendor', '.git', '__pycache__',
    'target', 'build', 'dist', '.next', '.turbo',
  ]);
  export const LANGUAGE_EXTENSIONS: Record<string, SupportedLanguage> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.java': 'java',
    '.rs': 'rust',
  };
  ```
- Implement `isTestFile(path: string): boolean` — check against `TEST_FILE_PATTERNS`
- Implement `validateGraph(json: unknown): DependencyGraph | null` — runtime type checking with version check
- Implement `validateMetadata(json: unknown): GraphMetadata | null`
- Implement `isGraphStale(metadata: GraphMetadata): boolean` — check if `lastIndexedAt` > 7 days ago

**Commit**: `feat(graph): add dependency graph schema and types`  
**Estimate**: 30 min

### 1.2 Create graph schema tests
**File**: `packages/core/src/graph/schema.test.ts` (NEW)  
**Change**:
- Test `isTestFile()` for each supported language's test patterns
- Test `isTestFile()` returns false for non-test files
- Test `validateGraph()` with valid graph JSON → returns DependencyGraph
- Test `validateGraph()` with invalid JSON → returns null
- Test `validateGraph()` with wrong version → returns null
- Test `validateGraph()` with missing fields → returns null
- Test `validateMetadata()` with valid metadata → returns GraphMetadata
- Test `isGraphStale()` with recent metadata → returns false
- Test `isGraphStale()` with old metadata → returns true
- Test `LANGUAGE_EXTENSIONS` covers all 6 languages
- Test `EXCLUDED_DIRS` includes node_modules, vendor, .git

**Commit**: `test(graph): add schema validation tests`  
**Estimate**: 20 min

### 1.3 Add graph config to ReviewSettings and ReviewInput types
**File**: `packages/core/src/types.ts`  
**Change**:
- Add to `ReviewSettings`:
  ```typescript
  /** Enable blast-radius analysis using dependency graph. Default: false. */
  enableBlastRadius?: boolean;
  /** Max files in blast-radius before falling back to full diff. Default: 50. */
  maxBlastRadiusFiles?: number;
  /** Max traversal depth for dependency graph. Default: 3. */
  traversalDepth?: number;
  ```
- Add to `ReviewInput`:
  ```typescript
  /**
   * Graph loader for blast-radius analysis.
   * Injected by the caller (SaaS: GitHubApiGraphLoader, CLI: SQLiteGraphLoader).
   * When undefined, blast-radius is skipped (current behavior).
   */
  graphLoader?: import('./graph/schema.js').GraphLoader;
  ```
- Add to `ReviewMetadata`:
  ```typescript
  /** Blast-radius analysis results (present when enableBlastRadius is true). */
  blastRadius?: import('./graph/schema.js').BlastRadiusMetadata;
  ```
- Do NOT add to `DEFAULT_SETTINGS` (undefined = disabled)
- Add `GraphLoader` interface to `schema.ts`:
  ```typescript
  export interface GraphLoader {
    load(): Promise<DependencyGraph | null>;
    loadMetadata(): Promise<GraphMetadata | null>;
  }
  ```

**Commit**: `feat(types): add blast-radius config to ReviewSettings and ReviewInput`  
**Estimate**: 15 min

### 1.4 Create barrel export
**File**: `packages/core/src/graph/index.ts` (NEW)  
**Change**:
- Re-export all public types and functions from schema.ts
- This will grow as subsequent layers are added

**Commit**: (included in 1.1 commit)  
**Estimate**: 3 min

## Phase 2: Blast-Radius Computation (depends on Phase 1)

### 2.1 Implement blast-radius computation
**File**: `packages/core/src/graph/blast-radius.ts` (NEW)  
**Change**:
- Implement `buildReverseIndex(graph: DependencyGraph): Map<string, Set<string>>`:
  - For each node, for each import, add reverse edge: `import → node.path`
  - Also add reverse edges for `calls[].target → node.path`
- Implement `computeBlastRadius(graph, changedFiles, options?): BlastRadiusResult`:
  ```typescript
  interface BlastRadiusOptions {
    maxDepth?: number;      // default: DEFAULT_TRAVERSAL_DEPTH (3)
    maxFiles?: number;      // default: MAX_BLAST_RADIUS_FILES (50)
    includeTests?: boolean; // default: true
  }

  interface BlastRadiusResult {
    /** All files in the blast radius (changed + dependents + tests) */
    files: Set<string>;
    /** Only the changed files from the input */
    changedFiles: string[];
    /** Files that depend on changed files (not including the changed files themselves) */
    dependents: string[];
    /** Test files added to the blast radius */
    testFiles: string[];
    /** Max depth actually reached */
    depth: number;
    /** Whether the blast radius exceeded the cap */
    exceededCap: boolean;
  }
  ```
  - Build reverse index
  - BFS from changed files with depth limit
  - Track visited set for cycle handling
  - After BFS, find test files: for each file in (changed + dependents), find tests that import it
  - If total files > maxFiles, set `exceededCap: true`
  - Return structured result

**Commit**: `feat(graph): implement blast-radius BFS computation`  
**Estimate**: 30 min

### 2.2 Create blast-radius computation tests
**File**: `packages/core/src/graph/blast-radius.test.ts` (NEW)  
**Change**:
- Create test fixture: small graph (10 nodes) with known dependency chain
  ```
  a.ts → b.ts → c.ts → d.ts
                    ↘ e.ts
  f.test.ts → c.ts
  g.test.ts → a.ts
  h.ts (isolated — no dependencies)
  ```
- Test: changed=[c.ts] → blast radius = [c.ts, a.ts, b.ts, f.test.ts] (reverse deps of c + test)
- Test: changed=[d.ts] → blast radius = [d.ts, c.ts, a.ts, b.ts, f.test.ts] (transitive)
- Test: changed=[h.ts] → blast radius = [h.ts] (isolated node)
- Test: changed=[a.ts] → blast radius = [a.ts, g.test.ts] (a has no reverse deps, but has a test)
- Test: circular dependency (a → b → c → a): changed=[a] includes all three + tests
- Test: depth limit = 1: changed=[d.ts] with maxDepth=1 → only [d.ts, c.ts, f.test.ts]
- Test: cap exceeded: graph with 60-node chain, maxFiles=50 → exceededCap=true
- Test: changed file not in graph: included as-is, no dependents
- Test: empty changedFiles → empty result
- Test: `buildReverseIndex` produces correct reverse edges
- Test: performance — 5000-node graph completes in <10ms

**Commit**: `test(graph): add blast-radius computation tests`  
**Estimate**: 30 min

## Phase 3: Graph Loading (depends on Phase 1)

### 3.1 Implement GitHub API graph loader
**File**: `packages/core/src/graph/loader.ts` (NEW)  
**Change**:
- Implement `GitHubApiGraphLoader`:
  ```typescript
  export class GitHubApiGraphLoader implements GraphLoader {
    constructor(
      private owner: string,
      private repo: string,
      private token: string,
    ) {}

    async load(): Promise<DependencyGraph | null> {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/.ghagga/graph.json?ref=ghagga/graph`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });
      
      if (response.status === 404) return null;
      if (!response.ok) return null;
      
      const json = await response.json();
      return validateGraph(json);
    }

    async loadMetadata(): Promise<GraphMetadata | null> {
      // Similar, but fetch metadata.json
    }
  }
  ```
- Implement `FilesystemGraphLoader`:
  ```typescript
  export class FilesystemGraphLoader implements GraphLoader {
    constructor(private graphDir: string) {}
    
    async load(): Promise<DependencyGraph | null> {
      const graphPath = path.join(this.graphDir, '.ghagga', 'graph.json');
      if (!existsSync(graphPath)) return null;
      const json = JSON.parse(readFileSync(graphPath, 'utf-8'));
      return validateGraph(json);
    }
    
    async loadMetadata(): Promise<GraphMetadata | null> { /* similar */ }
  }
  ```
- Implement `NullGraphLoader` (always returns null — used when blast-radius is disabled)
- Implement `PreloadedGraphLoader` (accepts a pre-fetched DependencyGraph — used when SaaS fetches early)

**Commit**: `feat(graph): implement graph loaders (GitHub API, filesystem, null)`  
**Estimate**: 25 min

### 3.2 Create graph loader tests
**File**: `packages/core/src/graph/loader.test.ts` (NEW)  
**Change**:
- Test `GitHubApiGraphLoader.load()`: mock fetch → 200 with valid graph → returns DependencyGraph
- Test `GitHubApiGraphLoader.load()`: mock fetch → 404 → returns null
- Test `GitHubApiGraphLoader.load()`: mock fetch → timeout → returns null
- Test `GitHubApiGraphLoader.load()`: mock fetch → invalid JSON → returns null
- Test `GitHubApiGraphLoader.loadMetadata()`: mock fetch → 200 → returns GraphMetadata
- Test `FilesystemGraphLoader.load()`: mock fs with valid file → returns DependencyGraph
- Test `FilesystemGraphLoader.load()`: file doesn't exist → returns null
- Test `NullGraphLoader.load()`: always returns null
- Test `PreloadedGraphLoader.load()`: returns the preloaded graph

**Commit**: `test(graph): add graph loader tests`  
**Estimate**: 25 min

## Phase 4: Pipeline Integration (depends on Phases 2, 3)

### 4.1 Integrate blast-radius into the review pipeline
**File**: `packages/core/src/pipeline.ts`  
**Change**:
- Add imports:
  ```typescript
  import { computeBlastRadius } from './graph/blast-radius.js';
  import type { BlastRadiusMetadata, GraphLoader } from './graph/schema.js';
  ```
- Insert Step 2.5 between Step 2 (parse/filter) and Step 3 (detect stacks):
  ```typescript
  // ── Step 2.5: Blast-radius filter (optional) ───────────────
  let blastRadiusMetadata: BlastRadiusMetadata | undefined;
  
  if (input.settings.enableBlastRadius && input.graphLoader) {
    try {
      const graph = await input.graphLoader.load();
      if (graph) {
        const metadata = await input.graphLoader.loadMetadata();
        const stale = metadata ? isGraphStale(metadata) : false;
        
        if (stale) {
          emit({
            step: 'blast-radius',
            message: `Dependency graph is stale (last indexed: ${metadata?.lastIndexedAt})`,
          });
        }
        
        const result = computeBlastRadius(graph, fileList, {
          maxDepth: input.settings.traversalDepth,
          maxFiles: input.settings.maxBlastRadiusFiles,
        });
        
        if (result.exceededCap) {
          emit({
            step: 'blast-radius',
            message: `Blast radius exceeds ${input.settings.maxBlastRadiusFiles ?? 50} files — using full diff`,
          });
          blastRadiusMetadata = {
            enabled: true,
            graphAvailable: true,
            totalFiles: filteredFiles.length,
            blastRadiusFiles: filteredFiles.length,
            fallbackReason: `blast radius exceeds ${input.settings.maxBlastRadiusFiles ?? 50} files`,
            graphStale: stale,
          };
        } else {
          // Filter to blast-radius files
          filteredFiles = filteredFiles.filter(f => result.files.has(f.path));
          emit({
            step: 'blast-radius',
            message: `Blast radius: ${result.files.size} files (from ${fileList.length} in diff)`,
            detail: [
              `  changed: ${result.changedFiles.length}`,
              `  dependents: ${result.dependents.length}`,
              `  tests: ${result.testFiles.length}`,
            ].join('\n'),
          });
          blastRadiusMetadata = {
            enabled: true,
            graphAvailable: true,
            totalFiles: fileList.length,
            blastRadiusFiles: result.files.size,
            graphStale: stale,
          };
        }
      } else {
        emit({ step: 'blast-radius', message: 'Blast radius: skipped (no graph available)' });
        blastRadiusMetadata = {
          enabled: true,
          graphAvailable: false,
          totalFiles: filteredFiles.length,
          blastRadiusFiles: filteredFiles.length,
          fallbackReason: 'no graph available',
        };
      }
    } catch (error) {
      console.warn('[ghagga] Blast-radius failed (degrading gracefully):', error);
      emit({ step: 'blast-radius', message: 'Blast radius: skipped (error loading graph)' });
      blastRadiusMetadata = {
        enabled: true,
        graphAvailable: false,
        totalFiles: filteredFiles.length,
        blastRadiusFiles: filteredFiles.length,
        fallbackReason: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  ```
- After result construction, add blast-radius metadata:
  ```typescript
  result.metadata.blastRadius = blastRadiusMetadata;
  ```
- Update `fileList` variable after blast-radius filter to use filtered paths:
  ```typescript
  // After blast-radius filter, update fileList for subsequent steps
  const fileList = filteredFiles.map(f => f.path);
  ```
  Note: `fileList` is already used as `const` — need to change to `let` or use a new variable `blastRadiusFileList`

**Commit**: `feat(pipeline): integrate blast-radius filter step`  
**Estimate**: 30 min

### 4.2 Update pipeline tests for blast-radius
**File**: `packages/core/src/pipeline.test.ts`  
**Change**:
- Add test: `'skips blast-radius when enableBlastRadius is false (default)'`
  - Verify full diff is sent to LLM
- Add test: `'skips blast-radius when no graphLoader provided'`
- Add test: `'applies blast-radius filter when graph is available'`
  - Mock graphLoader to return a test graph
  - Verify filteredFiles is reduced
  - Verify metadata.blastRadius is populated
- Add test: `'falls back to full diff when graph returns null (no branch)'`
  - Mock graphLoader.load() → null
  - Verify metadata.blastRadius.graphAvailable is false
- Add test: `'falls back to full diff when blast radius exceeds cap'`
  - Mock graph with many dependents
  - Verify metadata.blastRadius.fallbackReason includes "exceeds"
- Add test: `'handles graph loader errors gracefully'`
  - Mock graphLoader.load() → throw
  - Verify pipeline completes with full diff
- Add test: `'emits progress events for blast-radius step'`
  - Verify onProgress receives blast-radius step events

**Commit**: `test(pipeline): add blast-radius integration tests`  
**Estimate**: 30 min

## Phase 5: SaaS Integration (depends on Phase 4)

### 5.1 Add graph fetch to GitHub client
**File**: `apps/server/src/github/client.ts`  
**Change**:
- Add `fetchGraphFromBranch()`:
  ```typescript
  /**
   * Fetch the dependency graph from the ghagga/graph orphan branch.
   * Returns null if the branch or file doesn't exist.
   */
  export async function fetchGraphFromBranch(
    owner: string,
    repo: string,
    token: string,
  ): Promise<DependencyGraph | null> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ghagga/graph.json?ref=ghagga/graph`;
    
    try {
      const response = await githubCircuitBreaker.execute(async () => {
        return fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.raw',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(5_000),
        });
      });
      
      if (response.status === 404) return null;
      if (!response.ok) {
        console.warn(`[ghagga] Failed to fetch graph: ${response.status}`);
        return null;
      }
      
      const json = await response.json();
      return validateGraph(json);
    } catch {
      return null;
    }
  }
  ```
- Add `fetchGraphMetadata()` with same pattern for metadata.json

**Commit**: `feat(server): add GitHub API graph fetch functions`  
**Estimate**: 15 min

### 5.2 Wire graph loading into the review queue
**File**: `apps/server/src/queues/review.ts`  
**Change**:
- Import graph types and PreloadedGraphLoader
- Before `reviewPipeline(input)` call (after token fetch, around line 157-161):
  ```typescript
  // Fetch dependency graph for blast-radius analysis (if enabled)
  let graphLoader: GraphLoader | undefined;
  if (settings.enableBlastRadius) {
    const graph = await fetchGraphFromBranch(owner, repo, token);
    if (graph) {
      graphLoader = new PreloadedGraphLoader(graph);
    }
  }
  ```
- Pass `graphLoader` to `ReviewInput`:
  ```typescript
  const input: ReviewInput = {
    // ... existing fields
    graphLoader,
  };
  ```

**Commit**: `feat(server): wire graph loading into review queue`  
**Estimate**: 15 min

### 5.3 Add server graph fetch tests
**File**: `apps/server/src/github/client.test.ts`  
**Change**:
- Add test: `'fetchGraphFromBranch returns graph on 200'`
- Add test: `'fetchGraphFromBranch returns null on 404'`
- Add test: `'fetchGraphFromBranch returns null on timeout'`
- Add test: `'fetchGraphFromBranch returns null on invalid JSON'`
- Add test: `'fetchGraphMetadata returns metadata on 200'`

**Commit**: `test(server): add graph fetch tests`  
**Estimate**: 15 min

## Phase 6: Tree-sitter Indexer (Runner/CLI — depends on Phase 1)

### 6.1 Create TypeScript/JavaScript extractor
**File**: `packages/core/src/graph/extractors/typescript.ts` (NEW)  
**Change**:
- Install Tree-sitter dependencies: `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`
  (these are optional/peer dependencies — only needed in runner/CLI)
- Implement `TypeScriptExtractor`:
  - Parse with Tree-sitter TypeScript grammar
  - Extract `import` statements (ES modules + CommonJS require)
  - Extract `export` declarations (named exports, default export)
  - Extract cross-file function calls (basic: `identifier.identifier()` pattern)
  - Extract class hierarchy (`extends`, `implements`)
- Handle TSX/JSX via TypeScript grammar with JSX support
- Import path resolution:
  - Relative paths (`./foo`, `../bar`)
  - Index resolution (`./dir` → `./dir/index.ts`)
  - Read `tsconfig.json` paths if available (optional)

**Commit**: `feat(graph): implement TypeScript/JavaScript Tree-sitter extractor`  
**Estimate**: 45 min

### 6.2 Create Python extractor
**File**: `packages/core/src/graph/extractors/python.ts` (NEW)  
**Change**:
- Install: `tree-sitter-python`
- Implement `PythonExtractor`:
  - Extract `import foo`, `from foo import bar`
  - Handle relative imports (`from . import`, `from ..bar import`)
  - Extract class definitions for inheritance (`class Foo(Bar)`)
  - Extract function definitions as exports

**Commit**: `feat(graph): implement Python Tree-sitter extractor`  
**Estimate**: 30 min

### 6.3 Create Go extractor
**File**: `packages/core/src/graph/extractors/go.ts` (NEW)  
**Change**:
- Install: `tree-sitter-go`
- Implement `GoExtractor`:
  - Extract `import "pkg/path"` statements
  - Resolve Go imports within the same module (read `go.mod` for module path)
  - Extract exported functions/types (capitalized identifiers)

**Commit**: `feat(graph): implement Go Tree-sitter extractor`  
**Estimate**: 30 min

### 6.4 Create Java extractor
**File**: `packages/core/src/graph/extractors/java.ts` (NEW)  
**Change**:
- Install: `tree-sitter-java`
- Implement `JavaExtractor`:
  - Extract `import` statements (package.Class)
  - Map package imports to file paths (convention: `com.foo.Bar` → `com/foo/Bar.java`)
  - Extract `extends` and `implements`

**Commit**: `feat(graph): implement Java Tree-sitter extractor`  
**Estimate**: 30 min

### 6.5 Create Rust extractor
**File**: `packages/core/src/graph/extractors/rust.ts` (NEW)  
**Change**:
- Install: `tree-sitter-rust`
- Implement `RustExtractor`:
  - Extract `use` statements (`use crate::module::item`)
  - Extract `mod` declarations
  - Map crate paths to file paths

**Commit**: `feat(graph): implement Rust Tree-sitter extractor`  
**Estimate**: 30 min

### 6.6 Create extractor registry and tests
**File**: `packages/core/src/graph/extractors/index.ts` (NEW)  
**File**: `packages/core/src/graph/extractors/typescript.test.ts` (NEW)  
**File**: `packages/core/src/graph/extractors/python.test.ts` (NEW)  
**Change**:
- Extractor registry: `getExtractor(language: SupportedLanguage): LanguageExtractor`
- TypeScript tests:
  - Test ES module imports extracted correctly
  - Test CommonJS require extracted
  - Test named exports extracted
  - Test default export extracted
  - Test class extends extracted
  - Test dynamic imports skipped
  - Test relative path resolution
- Python tests:
  - Test `import` statement
  - Test `from ... import` statement
  - Test relative imports
  - Test class inheritance

**Commit**: `feat(graph): add extractor registry and language tests`  
**Estimate**: 40 min

## Phase 7: Graph Builder (depends on Phases 1, 6)

### 7.1 Implement graph builder
**File**: `packages/core/src/graph/indexer.ts` (NEW)  
**Change**:
- Implement `buildGraph(rootDir, options?): Promise<DependencyGraph>`:
  - Walk directory tree (skip EXCLUDED_DIRS)
  - For each file matching LANGUAGE_EXTENSIONS:
    - Compute SHA-256 hash of content
    - Detect language from extension
    - Parse with appropriate extractor
    - Build GraphNode
  - Resolve all import paths to relative file paths
  - Assemble DependencyGraph with version, rootDir, nodes
- Implement `updateGraphIncremental(existingGraph, rootDir): Promise<DependencyGraph>`:
  - Walk directory, compare hashes
  - Re-parse only changed/new files
  - Remove deleted files
  - Return updated graph
- Implement `buildGraphMetadata(graph, headSha, startTime): GraphMetadata`

**Commit**: `feat(graph): implement graph builder with incremental support`  
**Estimate**: 40 min

### 7.2 Create graph builder tests
**File**: `packages/core/src/graph/indexer.test.ts` (NEW)  
**Change**:
- Test with a fixture directory containing 5-10 TypeScript files with known imports
- Test: full index produces correct graph with all nodes and edges
- Test: incremental index only re-parses changed files (mock hash comparison)
- Test: deleted files are removed from graph
- Test: unsupported file extensions are skipped
- Test: excluded directories are skipped
- Test: parse errors in individual files don't abort the build
- Test: metadata is correctly populated

**Commit**: `test(graph): add graph builder tests`  
**Estimate**: 30 min

## Phase 8: Runner Workflow (ghagga-runner repo — depends on Phase 7)

### 8.1 Create runner graph indexing workflow
**File**: `ghagga-runner/.github/workflows/ghagga-graph-index.yml` (NEW in ghagga-runner repo)  
**Change**:
- Workflow dispatch trigger with inputs:
  - `repoFullName`, `headSha`, `callbackUrl`, `callbackId`, `callbackSecret`, `incremental`
- Steps:
  1. Checkout target repo at headSha
  2. Fetch or create orphan branch:
     ```bash
     git fetch origin ghagga/graph:ghagga/graph 2>/dev/null || true
     ```
  3. Setup Node.js 22
  4. Install Tree-sitter + grammars
  5. Run `index-graph.ts` script
  6. Commit and push to ghagga/graph:
     ```bash
     git checkout ghagga/graph 2>/dev/null || git checkout --orphan ghagga/graph && git rm -rf . 2>/dev/null || true
     mkdir -p .ghagga
     cp /tmp/graph.json .ghagga/graph.json
     cp /tmp/metadata.json .ghagga/metadata.json
     git add .ghagga/
     git commit -m "chore: update dependency graph [skip ci]"
     git push origin ghagga/graph
     ```
  7. POST callback to server

**Commit**: `feat(runner): add graph indexing workflow`  
**Estimate**: 30 min

### 8.2 Create runner indexing script
**File**: `ghagga-runner/scripts/index-graph.ts` (NEW in ghagga-runner repo)  
**Change**:
- CLI entry point that:
  - Reads `--repo-dir`, `--output-dir`, `--incremental`, `--head-sha` arguments
  - Loads existing graph if `--incremental` and graph exists
  - Calls `buildGraph()` or `updateGraphIncremental()`
  - Writes graph.json + metadata.json to output dir
  - Logs timing and file counts

**Commit**: `feat(runner): add graph indexing script`  
**Estimate**: 20 min

### 8.3 Wire graph indexing dispatch from server
**File**: `apps/server/src/github/runner.ts`  
**Change**:
- Add `DispatchGraphIndexParams` interface
- Add `dispatchGraphIndexWorkflow(params)` function:
  - Generate callbackId
  - Set secrets on runner repo
  - Dispatch `ghagga-graph-index.yml` workflow
- This is called on:
  - App installation (initial full index)
  - Merge to main (incremental update)

**File**: `apps/server/src/routes/webhook.ts`  
**Change**:
- On `push` event to default branch: enqueue graph indexing dispatch
- On `installation` event (new install): enqueue initial graph indexing

**Commit**: `feat(server): dispatch graph indexing on install and merge`  
**Estimate**: 25 min

## Phase 9: Update Barrel Export & Core Index

### 9.1 Update package exports
**File**: `packages/core/src/graph/index.ts`  
**Change**:
- Export all public types and functions from all graph modules:
  ```typescript
  export type { DependencyGraph, GraphNode, GraphMetadata, GraphLoader, BlastRadiusMetadata, SupportedLanguage } from './schema.js';
  export { GRAPH_VERSION, validateGraph, isTestFile, isGraphStale } from './schema.js';
  export type { BlastRadiusResult, BlastRadiusOptions } from './blast-radius.js';
  export { computeBlastRadius, buildReverseIndex } from './blast-radius.js';
  export { GitHubApiGraphLoader, FilesystemGraphLoader, NullGraphLoader, PreloadedGraphLoader } from './loader.js';
  export { buildGraph, updateGraphIncremental } from './indexer.js';
  ```

**File**: `packages/core/src/index.ts`  
**Change**:
- Add `export * from './graph/index.js';`

**Commit**: `feat(graph): update barrel exports`  
**Estimate**: 5 min

## Phase 10: Verification (depends on all above)

### 10.1 Run full test suite
**Command**: `pnpm test`  
**Verify**:
- All existing tests pass (no regressions)
- All new graph tests pass
- No TypeScript errors (`pnpm typecheck`)
- Biome lint passes (`pnpm lint`)
**Estimate**: 5 min

### 10.2 Integration test: graph indexing → blast-radius → review
**File**: `packages/core/src/__integration__/blast-radius.integration.test.ts` (NEW)  
**Change**:
- Create a temp directory with 10 TypeScript files with known import chains
- Build graph from the directory
- Simulate a PR that changes 2 files
- Run blast-radius computation
- Verify correct subset of files is returned
- Verify end-to-end with a mock reviewPipeline call

**Commit**: `test(graph): add blast-radius integration test`  
**Estimate**: 30 min

### 10.3 Manual verification: build graph for GHAGGA's own codebase
**Command**: Run the indexer on the GHAGGA monorepo itself  
**Verify**:
- graph.json is generated (check size, node count)
- Blast radius for a change to `pipeline.ts` includes known dependents
- Blast radius for a change to `types.ts` exceeds cap (core utility)
- Performance: indexing <30s, blast-radius <10ms
**Estimate**: 15 min

## Summary

| Phase | Tasks | Files | Est. Time |
|-------|-------|-------|-----------|
| 1. Types & Schema | 4 | 4 | 68 min |
| 2. Blast-Radius Computation | 2 | 2 | 60 min |
| 3. Graph Loading | 2 | 2 | 50 min |
| 4. Pipeline Integration | 2 | 2 | 60 min |
| 5. SaaS Integration | 3 | 3 | 45 min |
| 6. Tree-sitter Extractors | 6 | 8 | 205 min |
| 7. Graph Builder | 2 | 2 | 70 min |
| 8. Runner Workflow | 3 | 4 | 75 min |
| 9. Barrel Export | 1 | 2 | 5 min |
| 10. Verification | 3 | 1 | 50 min |
| **Total** | **28** | **30** | **~11.5 hours** |

## Execution Order

```
Phase 1 (types/schema) ──┬──→ Phase 2 (blast-radius) ──→ Phase 4 (pipeline) ──→ Phase 5 (SaaS) ──→ Phase 10 (verify)
                         ├──→ Phase 3 (loaders) ────────→ Phase 4 (pipeline)
                         └──→ Phase 6 (extractors) ──→ Phase 7 (builder) ──→ Phase 8 (runner)
                                                                           ──→ Phase 9 (exports)
```

- Phase 1 is the foundation — everything depends on it
- Phases 2, 3, 6 can run in parallel after Phase 1
- Phase 4 depends on Phases 2 and 3
- Phase 5 depends on Phase 4
- Phase 7 depends on Phases 1 and 6
- Phase 8 depends on Phase 7
- Phase 9 can run anytime after Phase 7
- Phase 10 depends on everything

## Verification Checklist

- [ ] `pnpm typecheck` passes (no TypeScript errors)
- [ ] `pnpm test` passes (all test suites green)
- [ ] `pnpm lint` passes (Biome lint clean)
- [ ] `validateGraph()` correctly validates and rejects graphs
- [ ] `computeBlastRadius()` handles circular dependencies
- [ ] `computeBlastRadius()` respects depth limit and file cap
- [ ] `GitHubApiGraphLoader` handles 404 gracefully
- [ ] Pipeline falls back to full diff when graph unavailable
- [ ] Pipeline falls back to full diff when blast radius exceeds cap
- [ ] Pipeline emits correct progress events for blast-radius step
- [ ] `ReviewResult.metadata.blastRadius` is populated correctly
- [ ] TypeScript extractor handles ES modules and CommonJS
- [ ] Python extractor handles relative imports
- [ ] Incremental index only re-parses changed files
- [ ] Runner workflow creates orphan branch if it doesn't exist
- [ ] Graph.json size <200KB for GHAGGA's own codebase
- [ ] Blast-radius computation <10ms for 5000-node graph
- [ ] All existing tests pass without modification (backward compat)
