/**
 * Shared pipeline state threaded through the review pipeline phases.
 *
 * A single mutable `PipelineState` object is created by the orchestrator
 * and passed to each phase (`prepare → gather-context → execute → enrich
 * → finalize`). Phases mutate it in-place — `state.result` is the SAME
 * `ReviewResult` object the phases mutate directly, preserving the
 * read-your-writes semantics of the original monolithic pipeline
 * (e.g. exploitability mutates findings in-place; the step-7.4 gate
 * reads `result.findings.length` populated by the step-7 merge).
 */

import type { ChecklistConfig } from '../checklist/index.js';
import type { CodeIntelMetadata, CodeIntelResult } from '../code-intel/types.js';
import type { EnhanceMetadata } from '../enhance/types.js';
import type { BlastRadiusMetadata } from '../graph/schema.js';
import type {
  ProgressEvent,
  ReviewFinding,
  ReviewInput,
  ReviewMode,
  ReviewResult,
  StaticAnalysisResult,
} from '../types.js';
import type { DiffFile } from '../utils/diff.js';

/** A pipeline step that failed but was gracefully degraded. */
export interface FailedStep {
  step: string;
  error: string;
}

export interface PipelineState {
  // ── Immutable config (set once at construction) ──────────────
  readonly input: ReviewInput;
  readonly startTime: number;
  readonly emit: (event: ProgressEvent) => void;
  readonly aiEnabled: boolean;

  // ── Set once in prepare, readonly afterwards ─────────────────
  /** All files parsed from the raw diff (pre-filtering). */
  readonly allFiles: DiffFile[];
  /**
   * ⚠️ LOAD-BEARING: captured PRE-blast-radius (right after ignore-pattern
   * filtering, BEFORE the blast-radius filter narrows `filteredFiles`).
   * Consumed by call-chain, static analysis, code-intel and
   * negative-examples — they must see the PRE-filter list.
   * Do NOT recompute from `filteredFiles`.
   * Note: `result.metadata.fileList` is built from `allFiles` instead —
   * a different list. Preserve both as-is.
   */
  readonly fileList: string[];

  // ── Mutable cross-phase state ─────────────────────────────────
  // prepare (blast-radius re-assigns both)
  filteredFiles: DiffFile[];
  filteredDiff: string;
  blastRadiusMetadata?: BlastRadiusMetadata;
  callChainContext: string;
  stacks: string[];
  stackHints: string;
  truncatedDiff: string;
  diffBudget: number;
  contextBudget: number;

  // gather-context
  staticResult: StaticAnalysisResult;
  rawMemoryContext: string | null;
  codeIntelResults: CodeIntelResult[];
  codeIntelMetadata?: CodeIntelMetadata;
  staticContext: string;
  memoryContext: string | null;
  codeIntelContext: string;
  checklistContext: string;
  resolvedChecklist: ChecklistConfig | null;
  negativeExamplesPrompt: string;
  selfImproveRulesPrompt: string;

  // execute (provider flags also consumed by enrich step 7.6)
  activeProvider: string;
  isCliBridge: boolean;
  isGateway: boolean;
  isOllama: boolean;

  // enhance: COMPUTE in execute (step 5.5) → APPLY in enrich (step 7 merge)
  enhancedStaticFindings?: ReviewFinding[];
  enhanceMetadata?: EnhanceMetadata;

  // trust override (execute step 5.6) → effective input mode
  trustOverrideMode?: ReviewMode;
  resolvedInputMode: ReviewMode;

  // execute creates it; enrich/finalize mutate it
  result: ReviewResult;

  failedSteps: FailedStep[];
}
