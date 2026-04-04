/**
 * Extensible tool system — barrel export.
 *
 * Re-exports all public types, the registry singleton,
 * the orchestrator entry point, and plugin initialization.
 */

// ─── Types ──────────────────────────────────────────────────────

export type {
  ExecOptions,
  ExecutionContext,
  RawToolOutput,
  TimeBudget,
  ToolCategory,
  ToolDefinition,
  ToolName,
  ToolTier,
} from './types.js';

// ─── Registry ───────────────────────────────────────────────────

export { ToolRegistry, toolRegistry } from './registry.js';

// ─── Resolver ───────────────────────────────────────────────────

export type { ActivatedTool, ToolActivationInput } from './resolve.js';
export { resolveActivatedTools } from './resolve.js';

// ─── Budget ─────────────────────────────────────────────────────

export { allocateTimeBudget, getEffectiveBudget } from './budget.js';

// ─── Orchestrator ───────────────────────────────────────────────

export { runTools } from './orchestrator.js';

// ─── Execution Contexts ─────────────────────────────────────────

export { createNodeExecutionContext } from './execution.js';

// ─── Plugins ────────────────────────────────────────────────────

export { initializeDefaultTools, resetInitialization } from './plugins/index.js';

// ─── Runner ─────────────────────────────────────────────────────

/** @deprecated Always returns true. Kept for backward compatibility. */
export { formatStaticAnalysisContext, isToolRegistryEnabled } from './runner.js';
