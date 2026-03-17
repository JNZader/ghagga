/**
 * Graph module barrel export.
 *
 * Re-exports all public types, interfaces, constants, and functions
 * from the graph subsystem.
 */

// ─── Schema & Types ─────────────────────────────────────────────

export type {
  BlastRadiusMetadata,
  DependencyGraph,
  GraphLoader,
  GraphMetadata,
  GraphNode,
  SupportedLanguage,
} from './schema.js';

export {
  DEFAULT_TRAVERSAL_DEPTH,
  EXCLUDED_DIRS,
  GRAPH_STALE_DAYS,
  GRAPH_VERSION,
  isGraphStale,
  isTestFile,
  LANGUAGE_EXTENSIONS,
  MAX_BLAST_RADIUS_FILES,
  MAX_GRAPH_SIZE_BYTES,
  TEST_FILE_PATTERNS,
  validateGraph,
  validateMetadata,
} from './schema.js';

// ─── Blast-Radius Computation ───────────────────────────────────

export type { BlastRadiusOptions, BlastRadiusResult } from './blast-radius.js';
export { buildReverseIndex, computeBlastRadius } from './blast-radius.js';

// ─── Graph Loaders ──────────────────────────────────────────────

export { GitHubApiGraphLoader, NullGraphLoader, PreloadedGraphLoader } from './loader.js';
