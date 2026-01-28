/**
 * Workflow Engine Module
 *
 * Provides multi-agent code review workflow orchestration with support for:
 * - Parallel execution of 5 specialized review agents
 * - Sequential execution with accumulated context
 * - Final synthesis combining all findings
 *
 * @module workflow
 */

// Step definitions and types
export {
  type WorkflowStepDefinition,
  type StepResult,
  CODE_REVIEW_WORKFLOW,
  getStepById,
  getParallelSteps,
  getSynthesisStep,
} from './steps.ts';

// Workflow engine and types
export {
  type WorkflowEngineConfig,
  type WorkflowExecutionResult,
  type StepExecutionContext,
  type LLMCaller,
  WorkflowEngine,
} from './engine.ts';
