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

// ─── Diagnostic Agent ───────────────────────────────────────────

export type { DiagnosticReviewInput } from './agents/diagnostic.js';
export { parseHypotheses, runDiagnosticReview } from './agents/diagnostic.js';

// ─── Constants ──────────────────────────────────────────────────

export { DEFAULT_MODELS, DEFAULT_SETTINGS } from './types.js';

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
export { calculateTokenBudget, getContextWindow } from './utils/token-budget.js';

// ─── Providers (for direct model access) ────────────────────────

export type { FallbackOptions, FallbackProvider, FallbackResult } from './providers/fallback.js';
export { generateWithFallback } from './providers/fallback.js';
export { createModel, createProvider } from './providers/index.js';

// ─── Memory (for custom memory integrations) ────────────────────

export { formatMemoryContext } from './memory/context.js';
export { EngramMemoryStorage } from './memory/engram.js';
export { stripPrivateData } from './memory/privacy.js';
export { SqliteMemoryStorage, type SqliteMemoryStorageOptions } from './memory/sqlite.js';

// ─── Formatting ─────────────────────────────────────────────────

export { formatReviewComment, SEVERITY_EMOJI, STATUS_EMOJI } from './format.js';

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
