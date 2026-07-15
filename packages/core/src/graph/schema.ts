/**
 * Dependency Graph Schema & Types
 *
 * Defines the core data structures for the blast-radius feature:
 * - DependencyGraph: the file-level import/export/call graph
 * - GraphMetadata: indexing metadata (commit, timestamp, stats)
 * - BlastRadiusMetadata: per-review blast-radius summary
 * - Validation functions for runtime type checking
 * - Constants for limits, patterns, and language support
 */

// ─── Supported Languages ────────────────────────────────────────

/**
 * Languages that have a regex-based extractor (see `extractors/index.ts`).
 * `Record<RegexSupportedLanguage, Extractor>` stays exhaustive: adding a new
 * regex-capable language forces a compile error until an extractor exists.
 */
export type RegexSupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'rust';

/**
 * Languages only reachable via a SCIP indexer — no regex extractor exists
 * (or ever will, e.g. Kotlin/C#/PHP). `--fallback-regex` cannot index files
 * in these languages.
 */
export type ScipOnlyLanguage = 'kotlin' | 'csharp' | 'php';

export type SupportedLanguage = RegexSupportedLanguage | ScipOnlyLanguage;

/** Runtime enumeration of `RegexSupportedLanguage`, for tests/tooling. */
export const REGEX_SUPPORTED_LANGUAGES: readonly RegexSupportedLanguage[] = [
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'rust',
];

/** Runtime enumeration of `ScipOnlyLanguage`, for tests/tooling. */
export const SCIP_ONLY_LANGUAGES: readonly ScipOnlyLanguage[] = ['kotlin', 'csharp', 'php'];

// ─── Graph Schema ───────────────────────────────────────────────

export interface DependencyGraph {
  /** Schema version for forward compatibility */
  version: number;

  /** Base path for all relative file paths */
  rootDir: string;

  /** File nodes keyed by relative path */
  nodes: Record<string, GraphNode>;
}

export interface GraphNode {
  /** SHA-256 hash of file content (for incremental indexing) */
  hash: string;

  /** Detected language */
  language: SupportedLanguage;

  /** Relative paths of files this file imports from */
  imports: string[];

  /** Exported symbol names (for cross-reference) */
  exports: string[];

  /** Cross-file function/method calls */
  calls: Array<{ target: string; symbol: string }>;

  /** True if file matches test patterns */
  isTest: boolean;
}

// ─── Metadata ───────────────────────────────────────────────────

export interface GraphMetadata {
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

  /**
   * Languages detected but NOT indexed (informational only — never a
   * staleness/warning trigger). Additive/optional for backward compatibility
   * with older `metadata.json` producers.
   */
  skippedLanguages?: string[];

  /**
   * Graph schema version this metadata was written for (mirrors
   * `DependencyGraph.version`). Additive/optional; used to detect a
   * metadata/graph mismatch (e.g. stale metadata next to a rebuilt graph).
   */
  graphVersion?: number;
}

export interface BlastRadiusMetadata {
  /** Whether blast-radius was enabled for this review */
  enabled: boolean;

  /** Whether a dependency graph was available */
  graphAvailable: boolean;

  /** Total files in the diff */
  totalFiles: number;

  /** Files after blast-radius filtering */
  blastRadiusFiles: number;

  /** Reason for falling back to full diff (when applicable) */
  fallbackReason?: string;

  /** Whether the graph was stale (>7 days old) */
  graphStale?: boolean;
}

// ─── Graph Loader Interface ─────────────────────────────────────

export interface GraphLoader {
  /** Load the dependency graph. Returns null if unavailable. */
  load(): Promise<DependencyGraph | null>;

  /** Load graph metadata. Returns null if unavailable. */
  loadMetadata(): Promise<GraphMetadata | null>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Current graph schema version */
export const GRAPH_VERSION = 1;

/** Maximum graph.json size in bytes (20 MB) */
export const MAX_GRAPH_SIZE_BYTES = 20 * 1024 * 1024;

/** Maximum files in a blast-radius result before falling back to full diff */
export const MAX_BLAST_RADIUS_FILES = 50;

/** Default BFS traversal depth for reverse dependency lookup */
export const DEFAULT_TRAVERSAL_DEPTH = 3;

/** Number of days after which a graph is considered stale */
export const GRAPH_STALE_DAYS = 7;

/** Regex patterns that identify test files across supported languages */
export const TEST_FILE_PATTERNS: RegExp[] = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^test_.*\.py$/,
  /_test\.go$/,
  /Test\.java$/,
  /_test\.rs$/,
  /Test\.kt$/,
  /Tests\.cs$/,
  /Test\.php$/,
];

/** Directories excluded from graph indexing */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  '__pycache__',
  'target',
  'build',
  'dist',
  '.next',
  '.turbo',
]);

/** Map from file extension to supported language */
export const LANGUAGE_EXTENSIONS: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.php': 'php',
};

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Check if a file path matches any known test file pattern.
 * Tests against the basename (last segment) of the path.
 */
export function isTestFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Validate a parsed JSON value as a DependencyGraph.
 * Returns the typed graph if valid, null otherwise.
 *
 * Checks:
 * - Is an object with version, rootDir, nodes
 * - version matches GRAPH_VERSION
 * - rootDir is a string
 * - nodes is a Record<string, GraphNode> with required fields
 */
export function validateGraph(json: unknown): DependencyGraph | null {
  if (!json || typeof json !== 'object') return null;

  const obj = json as Record<string, unknown>;

  // Check required top-level fields
  if (typeof obj.version !== 'number') return null;
  if (obj.version !== GRAPH_VERSION) return null;
  if (typeof obj.rootDir !== 'string') return null;
  if (!obj.nodes || typeof obj.nodes !== 'object') return null;

  // Validate nodes structure (spot-check — not exhaustive for perf)
  const nodes = obj.nodes as Record<string, unknown>;
  for (const [key, value] of Object.entries(nodes)) {
    if (typeof key !== 'string') return null;
    if (!value || typeof value !== 'object') return null;

    const node = value as Record<string, unknown>;
    if (typeof node.hash !== 'string') return null;
    if (typeof node.language !== 'string') return null;
    if (!Array.isArray(node.imports)) return null;
    if (!Array.isArray(node.exports)) return null;
    if (!Array.isArray(node.calls)) return null;
    if (typeof node.isTest !== 'boolean') return null;
  }

  return json as DependencyGraph;
}

/**
 * Validate a parsed JSON value as GraphMetadata.
 * Returns the typed metadata if valid, null otherwise.
 */
export function validateMetadata(json: unknown): GraphMetadata | null {
  if (!json || typeof json !== 'object') return null;

  const obj = json as Record<string, unknown>;

  if (typeof obj.lastIndexedCommit !== 'string') return null;
  if (typeof obj.lastIndexedAt !== 'string') return null;
  if (typeof obj.schemaVersion !== 'number') return null;
  if (typeof obj.fileCount !== 'number') return null;
  if (!Array.isArray(obj.languages)) return null;
  if (typeof obj.indexDurationMs !== 'number') return null;

  return json as GraphMetadata;
}

/**
 * Check if a graph's metadata indicates it is stale.
 * A graph is stale if it was last indexed more than GRAPH_STALE_DAYS ago.
 */
export function isGraphStale(metadata: GraphMetadata): boolean {
  const lastIndexed = new Date(metadata.lastIndexedAt);
  const now = new Date();
  const diffMs = now.getTime() - lastIndexed.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > GRAPH_STALE_DAYS;
}
