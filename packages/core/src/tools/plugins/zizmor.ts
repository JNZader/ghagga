/**
 * Zizmor plugin — GitHub Actions security analysis (auto-detect).
 *
 * Scans .github/workflows/*.{yml,yaml} files for security vulnerabilities
 * including template injection, unpinned actions, and excessive permissions.
 *
 * Uses ExecutionContext for DI instead of direct child_process.
 */

import type { FindingSeverity, ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────

const ZIZMOR_VERSION = '1.23.1';
const ZIZMOR_BIN = '/usr/local/bin/zizmor';

/** Regex for GitHub Actions workflow files */
const WORKFLOW_PATTERN = /(^|\/)\.github\/workflows\/[^/]+\.(yml|yaml)$/;

// ─── SARIF Types (v2.1.0 subset) ───────────────────────────────

interface SarifLog {
  runs?: SarifRun[];
}

interface SarifRun {
  results?: SarifResult[];
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}

// ─── Severity Mapping ───────────────────────────────────────────

const SARIF_SEVERITY_MAP: Record<string, FindingSeverity> = {
  error: 'high',
  warning: 'medium',
  note: 'info',
  none: 'low',
};

/**
 * Rules that indicate direct code execution risk.
 * Findings from these rules are elevated to 'critical' regardless of SARIF level.
 */
const CRITICAL_RULES: ReadonlySet<string> = new Set(['template-injection']);

/**
 * Map zizmor SARIF severity level to GHAGGA FindingSeverity.
 * Exported for direct unit testing.
 */
export function mapZizmorSeverity(level: string, ruleId?: string): FindingSeverity {
  if (ruleId && CRITICAL_RULES.has(ruleId)) {
    return 'critical';
  }
  return SARIF_SEVERITY_MAP[level.toLowerCase()] ?? 'low';
}

// ─── Parse Function ─────────────────────────────────────────────

/**
 * Parse zizmor SARIF v2.1.0 output into ReviewFinding[].
 * Exported for direct testing with fixture data.
 */
export function parseZizmorOutput(raw: RawToolOutput, repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];

  try {
    const sarif: SarifLog = JSON.parse(raw.stdout);
    const results = sarif.runs?.[0]?.results;
    if (!results || results.length === 0) return [];

    return results.map((result) => {
      const location = result.locations?.[0]?.physicalLocation;
      const uri = location?.artifactLocation?.uri ?? 'unknown';
      const line = location?.region?.startLine;
      const ruleId = result.ruleId ?? 'unknown';
      const messageText = result.message?.text ?? 'Security issue detected';
      const level = result.level ?? 'none';

      return {
        severity: mapZizmorSeverity(level, ruleId),
        category: 'security',
        file: uri.replace(`${repoDir}/`, ''),
        line,
        message: `${ruleId}: ${messageText}`,
        source: 'zizmor' as const,
      };
    });
  } catch {
    return [];
  }
}

// ─── Plugin Definition ──────────────────────────────────────────

export const zizmorPlugin: ToolDefinition = {
  name: 'zizmor',
  displayName: 'Zizmor',
  category: 'security',
  tier: 'auto-detect',
  version: ZIZMOR_VERSION,
  outputFormat: 'sarif',
  cachePaths: [ZIZMOR_BIN],

  detect(files: string[]): boolean {
    return files.some((f) => WORKFLOW_PATTERN.test(f));
  },

  async install(ctx: ExecutionContext): Promise<void> {
    const cached = await ctx.cacheRestore('zizmor', [ZIZMOR_BIN]);
    if (cached) {
      try {
        await ctx.exec('zizmor', ['--version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Zizmor cache restored but binary not functional, reinstalling');
      }
    }

    await ctx.exec(
      'bash',
      [
        '-c',
        `curl -sL "https://github.com/woodruffw/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu" -o ${ZIZMOR_BIN} && chmod +x ${ZIZMOR_BIN}`,
      ],
      { timeoutMs: 120_000 },
    );
    await ctx.exec('zizmor', ['--version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('zizmor', [ZIZMOR_BIN]);
  },

  async run(
    ctx: ExecutionContext,
    _repoDir: string,
    files: string[],
    timeout: number,
  ): Promise<RawToolOutput> {
    const workflowFiles = files.filter((f) => WORKFLOW_PATTERN.test(f));

    if (workflowFiles.length === 0) {
      return { stdout: '{}', stderr: '', exitCode: 0, timedOut: false };
    }

    return ctx.exec('zizmor', ['--format', 'sarif', ...workflowFiles], {
      timeoutMs: timeout,
      allowExitCodes: [1], // zizmor returns 1 when findings are present
    });
  },

  parse: parseZizmorOutput,
};
