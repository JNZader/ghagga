/**
 * @ghagga/core — Public API
 *
 * The core review engine for GHAGGA v2.
 * This module re-exports the pipeline entry point and all public types.
 */

// ─── Pipeline ───────────────────────────────────────────────────

export { reviewPipeline } from './pipeline.js';

// ─── Types ──────────────────────────────────────────────────────

export type {
  ConsensusStance,
  ConsensusVote,
  FindingSeverity,
  FindingSource,
  // Diagnostic types
  Hypothesis,
  HypothesisConfidence,
  ListObservationsOptions,
  LLMProvider,
  MemoryObservation,
  MemoryObservationDetail,
  MemoryObservationRow,
  MemoryStats,
  MemoryStorage,
  // Memory types
  ObservationType,
  // Progress callback types
  ProgressCallback,
  ProgressEvent,
  ProviderChainEntry,
  ReviewContext,
  ReviewFinding,
  // Input types
  ReviewInput,
  ReviewLevel,
  ReviewMetadata,
  ReviewMode,
  // Output types
  ReviewResult,
  ReviewSettings,
  ReviewStatus,
  SaaSProvider,
  // Static analysis types
  StaticAnalysisResult,
  ToolResult,
  ToolStatus,
  // Agent types
  WorkflowSpecialist,
} from './types.js';

// ─── Audit Agent ────────────────────────────────────────────────

export { runAuditReport } from './agents/audit.js';
export type { AuditInput, AuditResult, AuditStatus } from './types.js';

// ─── Diagnostic Agent ───────────────────────────────────────────

export type { DiagnosticReviewInput } from './agents/diagnostic.js';
export { parseHypotheses, runDiagnosticReview } from './agents/diagnostic.js';

// ─── Fan-Out Lenses Agent ──────────────────────────────────────

export type {
  FanOutReviewInput,
  LensValidationResult,
  ReviewLens,
} from './agents/fan-out-lenses.js';
export {
  DEFAULT_LENSES,
  getAllLenses,
  getLens,
  LENS_ACCESSIBILITY,
  LENS_ERROR_HANDLING,
  LENS_PERFORMANCE,
  LENS_SECURITY,
  LENS_TYPING,
  loadLensesFromDir,
  mergeFindings,
  registerLens,
  resetLensRegistry,
  runFanOutReview,
  validateLens,
} from './agents/fan-out-lenses.js';

// ─── Constants ──────────────────────────────────────────────────

export type {
  Contradiction,
  DecayConfig,
  MemoryBranch,
  MemorySnapshot,
  MergeResult,
  VersioningConfig,
} from './types.js';
export {
  DEFAULT_DECAY_CONFIG,
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  DEFAULT_VERSIONING_CONFIG,
} from './types.js';

// ─── Utilities (for advanced usage) ─────────────────────────────

export type {
  ContextLevel,
  ProgressiveContextInput,
  ProgressiveContextOutput,
} from './utils/context-levels.js';
export {
  buildProgressiveContext,
  chooseContextLevel,
  collectAllFindings,
  collectToolNames,
  estimateTokens,
  formatMemoryContextL0,
  formatMemoryContextL1,
  formatStaticContextL0,
  formatStaticContextL1,
} from './utils/context-levels.js';
export type { DiffFile, FilterDiffResult } from './utils/diff.js';
export { filterDiffFiles, filterIgnoredFiles, parseDiffFiles, truncateDiff } from './utils/diff.js';
export type { PathProtectionResult } from './utils/path-protection.js';
export {
  applyPathProtection,
  REDACT_PATTERNS,
  REDACTED_CONTENT,
  ZERO_ACCESS_PATTERNS,
} from './utils/path-protection.js';
export { detectStacks } from './utils/stack-detect.js';
export {
  calculateRateSchedule,
  calculateTokenBudget,
  getContextWindow,
} from './utils/token-budget.js';

// ─── Providers (for direct model access) ────────────────────────

export type { CLIBridgeOptions, CLIToolName } from './providers/cli-bridge.js';
export {
  CLIConfigurationError,
  generateViaCLI,
  getAvailableCLIs,
  OPENCODE_ENV_BY_PREFIX,
  sanitizeErrorMessage,
} from './providers/cli-bridge.js';
export type { FallbackOptions, FallbackProvider, FallbackResult } from './providers/fallback.js';
export { generateWithFallback } from './providers/fallback.js';
export type { GatewayOptions, GatewayResponse } from './providers/gateway.js';
export { generateViaGateway } from './providers/gateway.js';
export type { GenerateResult, GenerateTextFn } from './providers/generate-fn.js';
export {
  createAISDKGenerateFn,
  createCLIBridgeGenerateFn,
  createGatewayGenerateFn,
} from './providers/generate-fn.js';
export { createModel, createProvider } from './providers/index.js';

// ─── Negative Examples ──────────────────────────────────────────

export {
  fingerprintContext,
  fingerprintFinding,
  formatNegativeExamplesPrompt,
} from './negative.js';

// ─── Memory (for custom memory integrations) ────────────────────

export { formatMemoryContext } from './memory/context.js';
export { detectContradictions } from './memory/contradiction.js';
export { computeStrength, decayPhase } from './memory/decay.js';
export { EngramMemoryStorage } from './memory/engram.js';
export { stripPrivateData } from './memory/privacy.js';
export { SqliteMemoryStorage, type SqliteMemoryStorageOptions } from './memory/sqlite.js';
export {
  BranchExistsError,
  BranchNotFoundError,
  MemoryVersioning,
  ProtectedBranchError,
  SnapshotExistsError,
  SnapshotNotFoundError,
} from './memory/versioning.js';

// ─── Formatting ─────────────────────────────────────────────────

export type { FileStats, FormatReviewCommentOptions } from './format.js';
export {
  buildStatsBar,
  categorizeFiles,
  FILE_CATEGORIES,
  formatFileCategorySummary,
  formatReviewComment,
  REVIEW_COMMENT_MARKER,
  SEVERITY_EMOJI,
  STATUS_EMOJI,
} from './format.js';

// ─── Extensible Tool System ─────────────────────────────────────

export type {
  ActivatedTool,
  ExecOptions,
  ExecutionContext,
  RawToolOutput,
  TimeBudget,
  ToolActivationInput,
  ToolCategory,
  ToolDefinition,
  ToolName,
  ToolTier,
} from './tools/index.js';

export {
  allocateTimeBudget,
  createNodeExecutionContext,
  formatStaticAnalysisContext,
  getEffectiveBudget,
  initializeDefaultTools,
  isToolRegistryEnabled,
  resetInitialization,
  resolveActivatedTools,
  runTools,
  ToolRegistry,
  toolRegistry,
} from './tools/index.js';

// ─── SARIF Output ───────────────────────────────────────────────

export type {
  SarifDocument,
  SarifLevel,
  SarifLocation,
  SarifResult,
  SarifRule,
} from './sarif/index.js';
export { buildSarif } from './sarif/index.js';

// ─── Checklist ─────────────────────────────────────────────────

export type {
  ChecklistCheck,
  ChecklistConfig,
  ChecklistDimension,
  ChecklistScoreResult,
  DimensionScore,
  ScorableFinding,
  ScoredFinding,
} from './checklist/index.js';
export {
  buildChecklistContext,
  countActiveChecks,
  DEFAULT_CHECKLIST,
  DEFAULT_DIMENSIONS,
  resolveChecklistConfig,
  SEVERITY_MULTIPLIER,
  scoreFindings,
} from './checklist/index.js';

// ─── AI Enhance ─────────────────────────────────────────────────

export type {
  EnhancedReviewFinding,
  EnhanceInput,
  EnhanceMetadata,
  EnhanceResult,
  FilteredFinding,
  FindingGroup,
} from './enhance/index.js';
export { enhanceFindings, mergeEnhanceResult } from './enhance/index.js';

// ─── Recursive Review ──────────────────────────────────────────

export type {
  RecursiveReviewConfig,
  RecursiveReviewInput,
  RecursiveReviewReport,
  RegressionFinding,
  ReReviewInput,
  ReReviewResult,
  SuggestionPatch,
} from './recursive/index.js';
export {
  applyVirtualPatches,
  buildPatchContext,
  DEFAULT_RECURSIVE_CONFIG,
  extractPatches,
  recursiveReview,
  runReReview,
} from './recursive/index.js';

// ─── Dependency Graph & Blast-Radius ────────────────────────────

export type {
  BlastRadiusMetadata,
  BlastRadiusOptions,
  BlastRadiusResult,
  DependencyGraph,
  ExportInfo,
  Extractor,
  GraphLoader,
  GraphMetadata,
  GraphNode,
  ImportInfo,
  SupportedLanguage,
} from './graph/index.js';

export {
  buildGraph,
  buildGraphIncremental,
  buildReverseIndex,
  computeBlastRadius,
  DEFAULT_TRAVERSAL_DEPTH,
  detectLanguage,
  EXCLUDED_DIRS,
  GitHubApiGraphLoader,
  GRAPH_STALE_DAYS,
  GRAPH_VERSION,
  getExtractor,
  isGraphStale,
  isTestFile,
  LANGUAGE_EXTENSIONS,
  MAX_BLAST_RADIUS_FILES,
  MAX_GRAPH_SIZE_BYTES,
  NullGraphLoader,
  PreloadedGraphLoader,
  resolveImportPath,
  TEST_FILE_PATTERNS,
  validateGraph,
  validateMetadata,
} from './graph/index.js';

// ─── Health ─────────────────────────────────────────────────────

export type {
  HealthHistoryEntry,
  HealthRecommendation,
  HealthScore,
  HealthTrend,
} from './health/index.js';
export {
  computeHealthScore,
  computeTrend,
  formatTopIssues,
  generateRecommendations,
  getScoreColor,
  loadHistory,
  SEVERITY_WEIGHTS,
  saveHistory,
} from './health/index.js';

// ─── Exploitability (CVE Reachability Analysis) ────────────────

export type { ExploitabilityDetail, ExploitabilityLabel } from './exploitability/index.js';

export {
  analyzeExploitability,
  checkReachability,
  extractVulnPackages,
  findEntryPoints,
  tracePackageImports,
} from './exploitability/index.js';

// ─── Code Intelligence (MCP) ──────────────────────────────────

export type {
  CodeIntelMetadata,
  CodeIntelProvider,
  CodeIntelResult,
  SymbolReference,
} from './code-intel/index.js';

export { buildCodeIntelContext, McpCodeIntelClient } from './code-intel/index.js';

// ─── Embeddings (Intelligence v2) ─────────────────────────────

export type { EmbeddingProvider, EmbeddingProviderFactory } from './embed.js';
export { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from './embed.js';
export type { AuthorTrustScore, AuthorTrustTier, NegativeExample } from './types.js';

// ─── Author Trust Scoring (Intelligence v2) ───────────────────

export type { TrustScoringOptions } from './trust/index.js';
export { computeAuthorTrustScore, getReviewModeForTier } from './trust/index.js';

// ─── Semantic Ranking (Intelligence v2 — Feature #12) ──────────

export { rankFindings } from './ranking/index.js';

// ─── Doc Validation ────────────────────────────────────────────

export type { DocReference, DocValidationResult } from './doc-validation/index.js';
export { extractChangedSymbols, isDocFile, scanDocsForSymbols } from './doc-validation/index.js';

// ─── Scope (Tree-sitter Symbol Scoping) ────────────────────────

export type {
  AffectedSymbol,
  DiffHunk,
  EntityChange,
  EntityChangeKind,
  EntityDiffOptions,
  RenameMatch,
  ScopedFile,
  ScopeLanguage,
  SymbolInfo,
  SymbolKind,
} from './scope/index.js';

export {
  buildScopedContext,
  classifyEntityChanges,
  detectRenames,
  ENTITY_CHANGE_KIND,
  extractEntityDiffLines,
  extractSymbolsFromTree,
  filterLogicChanges,
  initParser,
  loadLanguage,
  mapDiffToSymbols,
  parseHunks,
  parseSource,
  resetParser,
  resolveGrammarPath,
} from './scope/index.js';
