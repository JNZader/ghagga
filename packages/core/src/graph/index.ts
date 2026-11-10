/**
 * Graph module barrel export.
 *
 * Re-exports all public types, interfaces, constants, and functions
 * from the graph subsystem.
 */

// ─── Schema & Types ─────────────────────────────────────────────

export type {
  BlastRadiusDiagram,
  BlastRadiusDiagramEdge,
  BlastRadiusDiagramMeta,
  BlastRadiusDiagramNode,
  BlastRadiusDiagramNodeRole,
  BlastRadiusMetadata,
  DependencyGraph,
  GraphLoader,
  GraphMetadata,
  GraphNode,
  RegexSupportedLanguage,
  ScipOnlyLanguage,
  SupportedLanguage,
} from './schema.js';

export {
  BLAST_RADIUS_DIAGRAM_MAX_JSON_CHARS,
  DEFAULT_TRAVERSAL_DEPTH,
  EXCLUDED_DIRS,
  GRAPH_STALE_DAYS,
  GRAPH_VERSION,
  isGraphStale,
  isTestFile,
  LANGUAGE_EXTENSIONS,
  MAX_BLAST_RADIUS_FILES,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_LABEL_CHARS,
  MAX_DIAGRAM_NODES,
  MAX_GRAPH_SIZE_BYTES,
  REGEX_SUPPORTED_LANGUAGES,
  SCIP_ONLY_LANGUAGES,
  TEST_FILE_PATTERNS,
  validateGraph,
  validateMetadata,
} from './schema.js';

// ─── Blast-Radius Diagram Renderer ──────────────────────────────

export type { MermaidEdgeInput, MermaidMetaInput, MermaidNodeInput } from './diagram.js';
export {
  assertDiagramJsonBudget,
  clusterOfPath,
  renderMermaidDiagram,
  sanitizeMermaidLabel,
} from './diagram.js';

// ─── Blast-Radius Computation ───────────────────────────────────

export type { BlastRadiusOptions, BlastRadiusResult } from './blast-radius.js';
export { buildReverseIndex, computeBlastRadius } from './blast-radius.js';

// ─── File Neighborhood Query ────────────────────────────────────

export type {
  CollectFileNeighborhoodsOptions,
  FileNeighborhood,
} from './neighbors.js';
export {
  collectFileNeighborhoods,
  MAX_EXPORTED_SYMBOLS_PER_FILE,
  MAX_NEIGHBORHOOD_FILES,
  MAX_NEIGHBORS_PER_FILE,
} from './neighbors.js';

// ─── Neighborhood Context Formatter ─────────────────────────────

export type {
  FormatGraphNeighborhoodOptions,
  GraphNeighborhoodFormatResult,
} from './neighborhood-format.js';
export {
  DEFAULT_GRAPH_CONTEXT_MAX_TOKENS,
  formatGraphNeighborhood,
  formatGraphNeighborhoodContext,
} from './neighborhood-format.js';

// ─── Graph Loaders ──────────────────────────────────────────────

export {
  FilesystemGraphLoader,
  type FilesystemGraphLoaderOptions,
  GitHubApiGraphLoader,
  NullGraphLoader,
  PreloadedGraphLoader,
} from './loader.js';

// ─── Extractors ─────────────────────────────────────────────────

export type { ExportInfo, Extractor, ImportInfo } from './extractors/index.js';
export { getExtractor } from './extractors/index.js';

// ─── Graph Builder ──────────────────────────────────────────────

export { buildGraph, buildGraphIncremental, detectLanguage, resolveImportPath } from './builder.js';

// ─── Call-Chain Blast-Radius ─────────────────────────────────────

export type {
  CallChainBlastRadius,
  CallChainEdge,
  CallChainGraph,
  CallChainNode,
} from './call-chain.js';
export { buildCallChainFromDiff } from './call-chain.js';

// ─── Reverse Dependency Graph ─────────────────────────────────────

export type { ReverseDependencyMap, ReverseDepsResult } from './reverse-deps.js';
export { buildReverseDependencyMap, findDependents } from './reverse-deps.js';

// ─── SCIP Graph Mapper ──────────────────────────────────────────

export type { Index } from '@scip-code/scip';
export type { BuildGraphFromScipOptions } from './scip/builder.js';
export { buildGraphFromScip, parseScipIndex } from './scip/builder.js';

// ─── SCIP Multi-Index Merge ──────────────────────────────────────

export type { MergeScipIndexesInput, MergeScipIndexesResult } from './scip/merge.js';
export { mergeScipIndexes } from './scip/merge.js';
