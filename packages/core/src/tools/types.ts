/**
 * Extensible tool system types.
 *
 * Defines the core interfaces for the plugin registry:
 * ToolDefinition, ExecutionContext, RawToolOutput, TimeBudget.
 *
 * All tool plugins implement ToolDefinition.
 * Distribution adapters implement ExecutionContext.
 */

import type { ReviewFinding } from '../types.js';

// ─── Tool Identity ──────────────────────────────────────────────

export type ToolName =
  | 'semgrep'
  | 'trivy'
  | 'cpd'
  | 'gitleaks'
  | 'shellcheck'
  | 'markdownlint'
  | 'lizard'
  | 'ruff'
  | 'bandit'
  | 'golangci-lint'
  | 'biome'
  | 'pmd'
  | 'psalm'
  | 'clippy'
  | 'hadolint'
  | 'zizmor'
  | 'sonarqube';

export type ToolCategory =
  | 'security'
  | 'quality'
  | 'secrets'
  | 'complexity'
  | 'duplication'
  | 'sca'
  | 'docs'
  | 'linting';

export type ToolTier = 'always-on' | 'auto-detect';

// ─── Raw Output ─────────────────────────────────────────────────

export interface RawToolOutput {
  /** The tool's standard output */
  stdout: string;

  /** The tool's standard error */
  stderr: string;

  /** Process exit code */
  exitCode: number;

  /** True if the tool was killed due to timeout */
  timedOut: boolean;
}

// ─── Execution Context ──────────────────────────────────────────

export interface ExecOptions {
  /** Timeout in milliseconds */
  timeoutMs: number;

  /** Working directory */
  cwd?: string;

  /** Treat these exit codes as success (in addition to 0) */
  allowExitCodes?: number[];

  /** Environment variables to add/override */
  env?: Record<string, string>;
}

/**
 * Abstract execution context injected into tool plugins.
 * Implemented by NodeExecutionContext (CLI), ActionsExecutionContext (Action),
 * and MockExecutionContext (tests).
 */
export interface ExecutionContext {
  /** Execute a command and capture output */
  exec(command: string, args: string[], opts: ExecOptions): Promise<RawToolOutput>;

  /** Attempt to restore cached tool binaries. Returns true on cache hit. */
  cacheRestore(toolName: string, paths: string[]): Promise<boolean>;

  /** Save tool binaries to cache. Non-fatal on failure. */
  cacheSave(toolName: string, paths: string[]): Promise<void>;

  /** Structured logging */
  log(level: 'info' | 'warn' | 'error', message: string): void;

  /**
   * Call an MCP tool by name. Optional — only available when an MCP server
   * is configured (e.g., SonarQube MCP server). Returns the tool's JSON response.
   * Undefined when no MCP server is connected.
   */
  mcpCall?(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

// ─── Tool Definition ────────────────────────────────────────────

export interface ToolDefinition {
  /** Unique identifier (lowercase kebab-case) */
  name: ToolName;

  /** Human-readable display name for UI */
  displayName: string;

  /** Purpose category */
  category: ToolCategory;

  /** Activation tier */
  tier: ToolTier;

  /** File-based activation (required for auto-detect, optional for always-on) */
  detect?: (files: string[]) => boolean;

  /** Install the tool binary. Receives execution context for DI. */
  install: (ctx: ExecutionContext) => Promise<void>;

  /** Run the tool. Returns raw stdout/stderr/exitCode. */
  run: (
    ctx: ExecutionContext,
    repoDir: string,
    files: string[],
    timeout: number,
  ) => Promise<RawToolOutput>;

  /** Parse raw output into normalized findings. */
  parse: (raw: RawToolOutput, repoDir: string) => ReviewFinding[];

  /** Pinned tool version */
  version: string;

  /** Expected output format (for documentation; parse handles actual parsing) */
  outputFormat: 'json' | 'sarif' | 'xml' | 'text';

  /** Cache paths for binary caching (relative or absolute) */
  cachePaths?: string[];

  /** Expected non-zero exit codes that are NOT errors (e.g., CPD returns 4 on duplications) */
  successExitCodes?: number[];
}

// ─── Time Budget ────────────────────────────────────────────────

export interface TimeBudget {
  /** Total budget in milliseconds */
  totalMs: number;

  /** Allocated milliseconds per tool */
  perToolMs: Map<string, number>;

  /** Minimum milliseconds per tool */
  minimumPerToolMs: number;
}
