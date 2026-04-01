/**
 * SonarQube plugin — static analysis via MCP (auto-detect).
 *
 * Fetches SonarQube issues for files under review via an MCP server.
 * Unlike CLI-based plugins, this one uses `ctx.mcpCall()` instead of
 * `ctx.exec()`. Activates only when an MCP server with the
 * `sonarqube_issues` tool is available.
 *
 * Uses ExecutionContext for DI — mcpCall is optional and undefined
 * when no MCP server is configured.
 */

import type { FindingSeverity, ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from '../types.js';

/**
 * Module-level flag indicating whether an MCP server with SonarQube
 * capabilities is available. Set by the caller before tool resolution.
 *
 * Default: false — the plugin is inert unless explicitly enabled.
 */
let mcpAvailable = false;

/**
 * Enable SonarQube MCP detection.
 * Call this before `resolveActivatedTools()` when an MCP-capable
 * ExecutionContext is provided.
 */
export function setSonarQubeMcpAvailable(available: boolean): void {
  mcpAvailable = available;
}

/**
 * Check current MCP availability flag.
 * Exported for testing.
 */
export function isSonarQubeMcpAvailable(): boolean {
  return mcpAvailable;
}

// ─── Severity Mapping ──────────────────────────────────────────────

/**
 * Map SonarQube severity to GHAGGA FindingSeverity.
 *
 * SonarQube levels: BLOCKER, CRITICAL, MAJOR, MINOR, INFO
 */
export function mapSonarQubeSeverity(severity: string): FindingSeverity {
  switch (severity.toUpperCase()) {
    case 'BLOCKER':
    case 'CRITICAL':
      return 'critical';
    case 'MAJOR':
      return 'high';
    case 'MINOR':
      return 'medium';
    case 'INFO':
      return 'low';
    default:
      return 'low';
  }
}

/**
 * Map SonarQube issue type to a review category.
 *
 * SonarQube types: BUG, VULNERABILITY, CODE_SMELL, SECURITY_HOTSPOT
 */
export function mapSonarQubeCategory(type: string): string {
  switch (type.toUpperCase()) {
    case 'VULNERABILITY':
    case 'SECURITY_HOTSPOT':
      return 'security';
    case 'BUG':
      return 'bug';
    case 'CODE_SMELL':
      return 'quality';
    default:
      return 'quality';
  }
}

// ─── Response Types ────────────────────────────────────────────────

/** Single issue from SonarQube API / MCP response */
export interface SonarQubeIssue {
  key: string;
  rule: string;
  severity: string;
  component: string;
  line?: number;
  message: string;
  type: string;
  effort?: string;
}

/** Top-level MCP response shape */
interface SonarQubeResponse {
  issues?: SonarQubeIssue[];
}

// ─── Parse Function ────────────────────────────────────────────────

/**
 * Parse SonarQube JSON output into ReviewFinding[].
 * Exported for direct testing with fixture data.
 */
export function parseSonarQubeOutput(raw: RawToolOutput, _repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];
  if (!raw.stdout || raw.stdout.trim().length === 0) return [];

  try {
    const data: SonarQubeResponse = JSON.parse(raw.stdout);
    const issues = data.issues ?? [];

    return issues.map((issue) => ({
      severity: mapSonarQubeSeverity(issue.severity),
      category: mapSonarQubeCategory(issue.type),
      file: issue.component,
      line: issue.line,
      message: `${issue.rule}: ${issue.message}`,
      source: 'sonarqube' as const,
    }));
  } catch {
    return [];
  }
}

// ─── Plugin Definition ─────────────────────────────────────────────

export const sonarqubePlugin: ToolDefinition = {
  name: 'sonarqube',
  displayName: 'SonarQube (MCP)',
  category: 'quality',
  tier: 'auto-detect',
  version: 'mcp',
  outputFormat: 'json',

  /**
   * Detect: activates when MCP is available AND there are files to scan.
   * The mcpAvailable flag is set externally before tool resolution.
   */
  detect(files: string[]): boolean {
    return mcpAvailable && files.length > 0;
  },

  /**
   * Install: no-op — SonarQube runs on an external server via MCP.
   */
  async install(_ctx: ExecutionContext): Promise<void> {
    // Nothing to install — MCP server is external
  },

  /**
   * Run: call the SonarQube MCP server to fetch issues for the given files.
   * Falls back to an empty result if mcpCall is not available.
   */
  async run(
    ctx: ExecutionContext,
    _repoDir: string,
    files: string[],
    _timeout: number,
  ): Promise<RawToolOutput> {
    if (!ctx.mcpCall) {
      ctx.log('info', '[ghagga:sonarqube] No MCP connection — skipping');
      return { stdout: '{"issues":[]}', stderr: '', exitCode: 0, timedOut: false };
    }

    try {
      const result = await ctx.mcpCall('sonarqube_issues', {
        file_paths: files,
      });

      // MCP tools return structured data — serialize to JSON for the parse step
      const stdout = typeof result === 'string' ? result : JSON.stringify(result);

      return { stdout, stderr: '', exitCode: 0, timedOut: false };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.log('warn', `[ghagga:sonarqube] MCP call failed: ${msg}`);
      return { stdout: '{"issues":[]}', stderr: msg, exitCode: 1, timedOut: false };
    }
  },

  parse: parseSonarQubeOutput,
};
