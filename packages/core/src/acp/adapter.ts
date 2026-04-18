/**
 * ACP Server Adapter for ghagga.
 *
 * Wraps ghagga's review pipeline in an ACP-compatible interface,
 * mapping ACP task lifecycle to ghagga review lifecycle:
 *
 *   ACP submitted  → ghagga validateInput
 *   ACP working    → ghagga reviewPipeline running
 *   ACP completed  → ghagga ReviewResult returned
 *   ACP failed     → ghagga pipeline error
 *   ACP canceled   → ghagga abort signal
 *
 * This adapter can be mounted as an HTTP handler, stdio transport,
 * or any other ACP-compatible transport layer.
 */

import { reviewPipeline } from '../pipeline.js';
import { buildSarif } from '../sarif/index.js';
import type {
  LLMProvider,
  ReviewInput,
  ReviewMode,
  ReviewResult,
  ReviewSettings,
} from '../types.js';
import { DEFAULT_SETTINGS } from '../types.js';
import type {
  ACPAgentCapabilities,
  ACPArtifact,
  ACPRequest,
  ACPResponse,
  ACPTask,
  ACPTaskError,
  ACPTaskInput,
  ACPTaskOutput,
  ACPTaskState,
} from './types.js';

// ─── Constants ─────────────────────────────────────────────────

const AGENT_NAME = 'ghagga';
const AGENT_VERSION = '2.8.1';
const SUPPORTED_MODES: ReviewMode[] = ['simple', 'workflow', 'consensus', 'diagnostic', 'fan-out'];

// ─── Task Store ────────────────────────────────────────────────

/**
 * In-memory task store for the ACP adapter.
 * Production deployments should replace this with a persistent store.
 */
export class ACPTaskStore {
  private tasks = new Map<string, ACPTask>();

  get(id: string): ACPTask | undefined {
    return this.tasks.get(id);
  }

  set(task: ACPTask): void {
    this.tasks.set(task.id, task);
  }

  list(): ACPTask[] {
    return [...this.tasks.values()];
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }
}

// ─── ACP Adapter ───────────────────────────────────────────────

export interface ACPAdapterOptions {
  /** Default LLM provider for reviews */
  provider: LLMProvider;

  /** Default model */
  model: string;

  /** API key for the LLM provider */
  apiKey: string;

  /** Default review settings (merged with per-task config) */
  defaultSettings?: Partial<ReviewSettings>;

  /** Optional task store (defaults to in-memory) */
  taskStore?: ACPTaskStore;

  /** Gateway URL for gateway provider */
  gatewayUrl?: string;
}

/**
 * ACP Server Adapter.
 *
 * Handles ACP JSON-RPC requests and maps them to ghagga operations.
 */
export class ACPAdapter {
  private store: ACPTaskStore;
  private options: ACPAdapterOptions;
  private abortControllers = new Map<string, AbortController>();

  constructor(options: ACPAdapterOptions) {
    this.options = options;
    this.store = options.taskStore ?? new ACPTaskStore();
  }

  // ── Capabilities ───────────────────────────────────────────

  getCapabilities(): ACPAgentCapabilities {
    return {
      name: AGENT_NAME,
      version: AGENT_VERSION,
      description: 'AI-powered multi-agent code reviewer',
      taskTypes: ['code-review'],
      reviewModes: [...SUPPORTED_MODES],
      supportsStreaming: true,
      supportsCancellation: true,
    };
  }

  // ── Task Management ────────────────────────────────────────

  /**
   * Submit a new review task.
   * Returns the task in 'submitted' state.
   */
  submitTask(input: ACPTaskInput): ACPTask {
    const now = new Date().toISOString();
    const id = generateTaskId();

    const task: ACPTask = {
      id,
      state: 'submitted',
      description: `Code review (${input.mode ?? 'simple'} mode)`,
      input,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(task);
    return task;
  }

  /**
   * Execute a submitted task (transitions through working → completed/failed).
   * This is async — the caller should not block on it.
   */
  async executeTask(taskId: string, onProgress?: (task: ACPTask) => void): Promise<ACPTask> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.state !== 'submitted') {
      throw new Error(`Task ${taskId} is in state '${task.state}', expected 'submitted'`);
    }

    // Transition to working
    this.updateTaskState(task, 'working');
    onProgress?.(task);

    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);

    try {
      // Build ReviewInput from ACP task input
      const reviewInput = this.buildReviewInput(task.input);

      // Run the review pipeline
      const result = await reviewPipeline(reviewInput);

      // Check if canceled during execution
      if (abortController.signal.aborted) {
        this.updateTaskState(task, 'canceled');
        return task;
      }

      // Build output and artifacts
      task.output = this.buildTaskOutput(result);
      task.artifacts = this.buildArtifacts(taskId, result);

      this.updateTaskState(task, 'completed');
      onProgress?.(task);
    } catch (error) {
      task.error = this.buildTaskError(error);
      this.updateTaskState(task, 'failed');
      onProgress?.(task);
    } finally {
      this.abortControllers.delete(taskId);
    }

    return task;
  }

  /**
   * Cancel a running task.
   */
  cancelTask(taskId: string): ACPTask | undefined {
    const task = this.store.get(taskId);
    if (!task) return undefined;

    if (task.state !== 'working' && task.state !== 'submitted') {
      return task; // Already in terminal state
    }

    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
    }

    this.updateTaskState(task, 'canceled');
    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): ACPTask | undefined {
    return this.store.get(taskId);
  }

  /**
   * List all tasks.
   */
  listTasks(): ACPTask[] {
    return this.store.list();
  }

  // ── JSON-RPC Handler ───────────────────────────────────────

  /**
   * Handle an ACP JSON-RPC request.
   * This is the main entry point for ACP protocol messages.
   */
  async handleRequest(request: ACPRequest): Promise<ACPResponse> {
    try {
      switch (request.method) {
        case 'agent/capabilities':
          return this.jsonRpcSuccess(request.id, this.getCapabilities());

        case 'task/submit': {
          const input = request.params as unknown as ACPTaskInput;
          if (!input?.diff) {
            return this.jsonRpcError(request.id, -32602, 'Missing required parameter: diff');
          }
          const task = this.submitTask(input);
          // Fire-and-forget execution (non-blocking)
          void this.executeTask(task.id);
          return this.jsonRpcSuccess(request.id, task);
        }

        case 'task/get': {
          const id = request.params?.id as string;
          const task = this.getTask(id);
          if (!task) {
            return this.jsonRpcError(request.id, -32001, `Task ${id} not found`);
          }
          return this.jsonRpcSuccess(request.id, task);
        }

        case 'task/list':
          return this.jsonRpcSuccess(request.id, this.listTasks());

        case 'task/cancel': {
          const id = request.params?.id as string;
          const task = this.cancelTask(id);
          if (!task) {
            return this.jsonRpcError(request.id, -32001, `Task ${id} not found`);
          }
          return this.jsonRpcSuccess(request.id, task);
        }

        default:
          return this.jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      return this.jsonRpcError(
        request.id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ── Private Helpers ────────────────────────────────────────

  private buildReviewInput(acpInput: ACPTaskInput): ReviewInput {
    const mode = (acpInput.mode as ReviewMode) ?? 'simple';
    const configOverrides = (acpInput.config ?? {}) as Partial<ReviewSettings>;

    return {
      diff: acpInput.diff,
      mode,
      provider: this.options.provider,
      model: this.options.model,
      apiKey: this.options.apiKey,
      settings: {
        ...DEFAULT_SETTINGS,
        ...this.options.defaultSettings,
        ...configOverrides,
        reviewLevel: (acpInput.level as ReviewInput['settings']['reviewLevel']) ?? 'normal',
      },
      context: acpInput.repo
        ? {
            repoFullName: acpInput.repo,
            prNumber: acpInput.prNumber ?? 0,
            commitMessages: acpInput.commitMessages ?? [],
            fileList: acpInput.fileList ?? [],
          }
        : undefined,
    };
  }

  private buildTaskOutput(result: ReviewResult): ACPTaskOutput {
    return {
      status: result.status,
      summary: result.summary,
      findingCount: result.findings.length,
      metadata: {
        mode: result.metadata.mode,
        provider: result.metadata.provider,
        model: result.metadata.model,
        tokensUsed: result.metadata.tokensUsed,
        executionTimeMs: result.metadata.executionTimeMs,
        toolsRun: result.metadata.toolsRun,
      },
    };
  }

  private buildArtifacts(taskId: string, result: ReviewResult): ACPArtifact[] {
    const artifacts: ACPArtifact[] = [];

    // Full review result as JSON
    artifacts.push({
      id: `${taskId}-review`,
      type: 'review-result',
      mimeType: 'application/json',
      data: JSON.stringify(result),
    });

    // Findings as standalone JSON
    artifacts.push({
      id: `${taskId}-findings`,
      type: 'findings-json',
      mimeType: 'application/json',
      data: JSON.stringify(result.findings),
    });

    // SARIF output
    try {
      const sarif = buildSarif(result, '2.1.0');
      artifacts.push({
        id: `${taskId}-sarif`,
        type: 'sarif',
        mimeType: 'application/sarif+json',
        data: JSON.stringify(sarif),
      });
    } catch {
      // SARIF generation failed — non-fatal, skip artifact
    }

    return artifacts;
  }

  private buildTaskError(error: unknown): ACPTaskError {
    if (error instanceof Error) {
      return {
        code: 'REVIEW_FAILED',
        message: error.message,
        details: { stack: error.stack },
      };
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: String(error),
    };
  }

  private updateTaskState(task: ACPTask, state: ACPTaskState): void {
    task.state = state;
    task.updatedAt = new Date().toISOString();
    this.store.set(task);
  }

  private jsonRpcSuccess(id: string | number, result: unknown): ACPResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private jsonRpcError(id: string | number, code: number, message: string): ACPResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ─── Utilities ─────────────────────────────────────────────────

let taskCounter = 0;

function generateTaskId(): string {
  taskCounter++;
  const timestamp = Date.now().toString(36);
  const counter = taskCounter.toString(36).padStart(4, '0');
  return `ghagga-${timestamp}-${counter}`;
}

/** Reset the task counter (for testing only). */
export function resetTaskCounter(): void {
  taskCounter = 0;
}
