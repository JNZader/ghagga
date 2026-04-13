/**
 * ACP (Agent Communication Protocol) types for ghagga.
 *
 * Based on the Agent Client Protocol specification from
 * agentclientprotocol/agent-client-protocol.
 *
 * ACP defines a standard lifecycle for agent tasks:
 *   submitted → working → completed | failed | canceled
 *
 * This module maps ghagga's review lifecycle to ACP's task lifecycle.
 */

// ─── ACP Task Lifecycle ────────────────────────────────────────

export type ACPTaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled';

/**
 * ACP Task — the core unit of work in the protocol.
 * Each task represents a single code review request.
 */
export interface ACPTask {
  /** Unique task identifier */
  id: string;

  /** Current task state */
  state: ACPTaskState;

  /** Human-readable description of the task */
  description: string;

  /** Task input parameters */
  input: ACPTaskInput;

  /** Task output (populated when state is 'completed') */
  output?: ACPTaskOutput;

  /** Error details (populated when state is 'failed') */
  error?: ACPTaskError;

  /** Artifacts produced during the task */
  artifacts: ACPArtifact[];

  /** ISO 8601 timestamp when the task was created */
  createdAt: string;

  /** ISO 8601 timestamp of the last state transition */
  updatedAt: string;
}

// ─── ACP Task Input ────────────────────────────────────────────

/**
 * Input parameters for a ghagga review task via ACP.
 */
export interface ACPTaskInput {
  /** The unified diff to review */
  diff: string;

  /** Review mode (maps to ghagga's ReviewMode) */
  mode?: string;

  /** Review strictness level */
  level?: string;

  /** Repository context */
  repo?: string;

  /** PR number */
  prNumber?: number;

  /** Commit messages */
  commitMessages?: string[];

  /** File list (derived from diff if not provided) */
  fileList?: string[];

  /** Additional configuration overrides */
  config?: Record<string, unknown>;
}

// ─── ACP Task Output ───────────────────────────────────────────

/**
 * Output from a completed ghagga review task.
 */
export interface ACPTaskOutput {
  /** Review status */
  status: string;

  /** Human-readable summary */
  summary: string;

  /** Number of findings */
  findingCount: number;

  /** Execution metadata */
  metadata: {
    mode: string;
    provider: string;
    model: string;
    tokensUsed: number;
    executionTimeMs: number;
    toolsRun: string[];
  };
}

// ─── ACP Artifact ──────────────────────────────────────────────

export type ACPArtifactType = 'review-result' | 'sarif' | 'findings-json';

/**
 * An artifact produced by the review task.
 * ACP artifacts are typed blobs that clients can consume.
 */
export interface ACPArtifact {
  /** Artifact identifier */
  id: string;

  /** Artifact type */
  type: ACPArtifactType;

  /** MIME type of the artifact data */
  mimeType: string;

  /** Artifact data (JSON-serialized) */
  data: string;
}

// ─── ACP Error ─────────────────────────────────────────────────

export interface ACPTaskError {
  /** Error code */
  code: string;

  /** Human-readable error message */
  message: string;

  /** Optional additional details */
  details?: Record<string, unknown>;
}

// ─── ACP Server Capabilities ───────────────────────────────────

/**
 * Capabilities advertised by the ghagga ACP server.
 * Clients use this to discover what the agent can do.
 */
export interface ACPAgentCapabilities {
  /** Agent name */
  name: string;

  /** Agent version */
  version: string;

  /** Human-readable description */
  description: string;

  /** Supported task types */
  taskTypes: string[];

  /** Supported review modes */
  reviewModes: string[];

  /** Whether the agent supports streaming progress */
  supportsStreaming: boolean;

  /** Whether the agent supports cancellation */
  supportsCancellation: boolean;
}

// ─── ACP Message Types (JSON-RPC 2.0) ─────────────────────────

export interface ACPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface ACPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ACPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}
