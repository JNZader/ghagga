/**
 * WorkflowEngine - Orchestrates multi-agent code review workflows
 *
 * Supports parallel execution of specialized review agents and
 * sequential execution with accumulated context.
 */

import {
  type WorkflowStepDefinition,
  type StepResult,
  CODE_REVIEW_WORKFLOW,
  getParallelSteps,
  getSynthesisStep,
} from './steps.ts';
import type {
  ChatMessage,
  LLMRequestOptions,
  LLMResponse,
  ProviderConfig,
} from '../types/providers.ts';

/**
 * Configuration for the WorkflowEngine
 */
export interface WorkflowEngineConfig {
  /** Provider configuration for LLM calls */
  provider: ProviderConfig;
  /** Maximum time for each step in milliseconds */
  stepTimeout?: number;
  /** Maximum retries per step */
  maxRetries?: number;
  /** Whether to continue on step failure */
  continueOnFailure?: boolean;
}

/**
 * Result of running a complete workflow
 */
export interface WorkflowExecutionResult {
  /** All findings from parallel steps */
  findings: StepResult[];
  /** Final synthesis result */
  synthesis: StepResult;
  /** Total execution time in milliseconds */
  totalDuration_ms: number;
  /** Overall status */
  status: 'passed' | 'failed' | 'error';
  /** Error message if status is error */
  error?: string;
}

/**
 * Context passed to step execution
 */
export interface StepExecutionContext {
  /** The code/diff content to review */
  content: string;
  /** Repository rules and guidelines */
  rules: string;
  /** Accumulated findings from previous steps (for sequential mode) */
  previousFindings: string;
  /** Step-specific configuration */
  stepConfig?: Record<string, unknown>;
}

/**
 * LLM caller function type - allows dependency injection
 */
export type LLMCaller = (options: LLMRequestOptions) => Promise<LLMResponse>;

/**
 * WorkflowEngine orchestrates multi-agent code review workflows.
 *
 * It supports two execution modes:
 * - Parallel: Steps 1-5 run concurrently, followed by synthesis
 * - Sequential: Each step runs one after another with accumulated context
 */
export class WorkflowEngine {
  private readonly config: WorkflowEngineConfig;
  private readonly steps: WorkflowStepDefinition[];
  private readonly llmCaller: LLMCaller;

  constructor(config: WorkflowEngineConfig, llmCaller: LLMCaller) {
    this.config = {
      stepTimeout: 60000, // 60 seconds default
      maxRetries: 2,
      continueOnFailure: true,
      ...config,
    };
    this.steps = CODE_REVIEW_WORKFLOW;
    this.llmCaller = llmCaller;
  }

  /**
   * Run workflow steps in parallel (5 agents) followed by synthesis.
   *
   * Steps 1-5 (scope, standards, errors, security, performance) execute
   * concurrently. The synthesis step then combines all findings.
   *
   * @param content - The code/diff content to review
   * @param rules - Repository rules and guidelines
   * @returns Workflow execution result with all findings and synthesis
   */
  async runParallel(content: string, rules: string): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const parallelSteps = getParallelSteps();

    try {
      // Run steps 1-5 in parallel
      const parallelResults = await Promise.all(
        parallelSteps.map((step) =>
          this.executeStep(step, {
            content,
            rules,
            previousFindings: '',
          })
        )
      );

      // Collect all findings for synthesis
      const allFindings = this.formatFindingsForSynthesis(parallelResults);

      // Run synthesis step with all findings
      const synthesisStep = getSynthesisStep();
      const synthesis = await this.executeStep(synthesisStep, {
        content,
        rules,
        previousFindings: allFindings,
      });

      const totalDuration_ms = Date.now() - startTime;

      return {
        findings: parallelResults,
        synthesis,
        totalDuration_ms,
        status: this.determineOverallStatus(synthesis),
      };
    } catch (error) {
      const totalDuration_ms = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        findings: [],
        synthesis: {
          stepId: 'synthesis',
          stepName: 'Final Synthesis',
          findings: '',
          status: 'failed',
          duration_ms: 0,
          error: errorMessage,
        },
        totalDuration_ms,
        status: 'error',
        error: errorMessage,
      };
    }
  }

  /**
   * Run workflow steps sequentially with accumulated context.
   *
   * Each step receives findings from all previous steps, allowing
   * later steps to build upon earlier analysis.
   *
   * @param content - The code/diff content to review
   * @param rules - Repository rules and guidelines
   * @returns Workflow execution result with all findings and synthesis
   */
  async runSequential(content: string, rules: string): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const results: StepResult[] = [];
    let accumulatedFindings = '';

    try {
      // Run each step sequentially, passing accumulated findings
      for (const step of this.steps) {
        const result = await this.executeStep(step, {
          content,
          rules,
          previousFindings: accumulatedFindings,
        });

        results.push(result);

        // Accumulate findings for next step
        if (result.status === 'success') {
          accumulatedFindings += this.formatStepFindings(result);
        }

        // Stop on failure if not configured to continue
        if (result.status === 'failed' && !this.config.continueOnFailure) {
          break;
        }
      }

      const totalDuration_ms = Date.now() - startTime;

      // The last result should be synthesis
      const synthesis = results[results.length - 1];
      const findings = results.slice(0, -1);

      return {
        findings,
        synthesis,
        totalDuration_ms,
        status: this.determineOverallStatus(synthesis),
      };
    } catch (error) {
      const totalDuration_ms = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        findings: results,
        synthesis: {
          stepId: 'synthesis',
          stepName: 'Final Synthesis',
          findings: '',
          status: 'failed',
          duration_ms: 0,
          error: errorMessage,
        },
        totalDuration_ms,
        status: 'error',
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a single workflow step.
   *
   * Builds the prompt from step definition and context, calls the LLM,
   * and formats the response into a StepResult.
   *
   * @param step - The step definition to execute
   * @param context - Execution context with content, rules, and previous findings
   * @returns Step execution result
   */
  async executeStep(
    step: WorkflowStepDefinition,
    context: StepExecutionContext
  ): Promise<StepResult> {
    const startTime = Date.now();

    try {
      const messages = this.buildStepMessages(step, context);

      const response = await this.callWithRetry(
        { messages, maxTokens: this.config.provider.maxTokens },
        this.config.maxRetries ?? 2
      );

      const duration_ms = Date.now() - startTime;

      return {
        stepId: step.id,
        stepName: step.name,
        findings: response.content,
        status: 'success',
        duration_ms,
      };
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        stepId: step.id,
        stepName: step.name,
        findings: '',
        status: 'failed',
        duration_ms,
        error: errorMessage,
      };
    }
  }

  /**
   * Build chat messages for a step execution
   */
  private buildStepMessages(
    step: WorkflowStepDefinition,
    context: StepExecutionContext
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: step.agentPrompt,
      },
    ];

    // Add rules as context if provided
    if (context.rules) {
      messages.push({
        role: 'user',
        content: `## Repository Rules and Guidelines\n\n${context.rules}`,
      });
    }

    // Add previous findings for synthesis or sequential mode
    if (context.previousFindings) {
      messages.push({
        role: 'user',
        content: `## Previous Analysis Findings\n\n${context.previousFindings}`,
      });
    }

    // Add the main content to review
    messages.push({
      role: 'user',
      content: `## Code to Review\n\n${context.content}\n\nPlease perform your analysis.`,
    });

    return messages;
  }

  /**
   * Call LLM with retry logic
   */
  private async callWithRetry(
    options: LLMRequestOptions,
    retriesLeft: number
  ): Promise<LLMResponse> {
    try {
      return await this.llmCaller(options);
    } catch (error) {
      if (retriesLeft > 0) {
        // Exponential backoff
        const delay = Math.pow(2, this.config.maxRetries! - retriesLeft) * 1000;
        await this.sleep(delay);
        return this.callWithRetry(options, retriesLeft - 1);
      }
      throw error;
    }
  }

  /**
   * Format findings from parallel steps for synthesis
   */
  private formatFindingsForSynthesis(results: StepResult[]): string {
    return results
      .filter((r) => r.status === 'success')
      .map((r) => this.formatStepFindings(r))
      .join('\n\n---\n\n');
  }

  /**
   * Format a single step's findings
   */
  private formatStepFindings(result: StepResult): string {
    return `### ${result.stepName} (${result.stepId})\n\n${result.findings}`;
  }

  /**
   * Determine overall workflow status from synthesis result
   */
  private determineOverallStatus(
    synthesis: StepResult
  ): 'passed' | 'failed' | 'error' {
    if (synthesis.status === 'failed') {
      return 'error';
    }

    // Check if synthesis indicates pass or fail
    const findingsLower = synthesis.findings.toLowerCase();
    if (findingsLower.includes('status: passed')) {
      return 'passed';
    }
    if (findingsLower.includes('status: failed')) {
      return 'failed';
    }

    // Default to passed if no explicit status found
    return 'passed';
  }

  /**
   * Sleep utility for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the list of workflow steps
   */
  getSteps(): WorkflowStepDefinition[] {
    return [...this.steps];
  }

  /**
   * Get the current configuration
   */
  getConfig(): WorkflowEngineConfig {
    return { ...this.config };
  }
}
