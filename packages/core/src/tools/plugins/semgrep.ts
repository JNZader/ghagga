/**
 * Semgrep plugin — security analysis (always-on).
 *
 * Adapted from:
 * - packages/core/src/tools/semgrep.ts (parsing logic)
 * - apps/action/src/tools/semgrep.ts (install/run flow)
 *
 * Uses ExecutionContext for DI instead of direct child_process.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FindingSeverity, ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from '../types.js';

const SEMGREP_VERSION = '1.90.0';

/**
 * Resolve the bundled curated ruleset path relative to this plugin's location.
 *
 * Works in BOTH dev (src/tools/plugins/semgrep.ts -> src/tools/semgrep-rules.yml)
 * and the published build (dist/tools/plugins/semgrep.js -> dist/tools/semgrep-rules.yml),
 * provided the build copies the .yml into dist/tools/ (see package.json `build` script).
 *
 * Returns undefined if the file is not present so the plugin degrades gracefully
 * to `--config auto` only.
 */
export function resolveSemgrepRulesPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const rulesPath = join(here, '..', 'semgrep-rules.yml');
  return existsSync(rulesPath) ? rulesPath : undefined;
}

/**
 * Map Semgrep severity to GHAGGA FindingSeverity.
 * ERROR -> high, WARNING -> medium, INFO -> info, default -> low
 */
export function mapSemgrepSeverity(semgrepSeverity: string): FindingSeverity {
  switch (semgrepSeverity.toUpperCase()) {
    case 'ERROR':
      return 'high';
    case 'WARNING':
      return 'medium';
    case 'INFO':
      return 'info';
    default:
      return 'low';
  }
}

/**
 * Parse Semgrep JSON output into ReviewFinding[].
 * Exported for direct testing with fixture data.
 */
export function parseSemgrepOutput(raw: RawToolOutput, repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];

  try {
    const result = JSON.parse(raw.stdout) as {
      results?: Array<{
        path: string;
        start: { line: number };
        extra: { severity: string; message: string };
      }>;
    };

    return (result.results ?? []).map((r) => ({
      severity: mapSemgrepSeverity(r.extra.severity),
      category: 'security',
      file: r.path.replace(`${repoDir}/`, ''),
      line: r.start.line,
      message: r.extra.message,
      source: 'semgrep' as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Operational-failure detection for raw semgrep output (demo investigation D4).
 *
 * Semgrep exits 0 (clean) or 1 (findings present); exit codes >= 2 mark an
 * operational failure (bad config, unparsable rules, internal error).
 * Separately, the JSON `errors` array can be non-empty even on exit 0 — when
 * it comes with zero `results`, the scan did not actually run.
 *
 * Lives in `run` (throwing), NOT in `parse`: the orchestrator's parseSafe
 * swallows parse throws (pinned behavior — a parse error degrades to zero
 * findings with status "success"), while a run() throw reaches the
 * orchestrator's catch and is recorded with status "error". Before this
 * check, a crashed semgrep resolved with unparseable stdout, parse()
 * swallowed it, and the review reported "success (0 findings)" for a scan
 * that never ran.
 *
 * @throws {Error} when the scan operationally failed.
 */
export function assertSemgrepSucceeded(raw: RawToolOutput): void {
  // Timeout is the orchestrator's call (raw.timedOut → status "error").
  if (raw.timedOut) return;

  let failure: string | undefined;

  if (raw.exitCode >= 2) {
    const detail = raw.stderr.trim() || raw.stdout.trim();
    failure = `semgrep operational failure (exit ${raw.exitCode})${
      detail ? `: ${detail.slice(0, 300)}` : ''
    }`;
  } else {
    try {
      const parsed = JSON.parse(raw.stdout) as {
        results?: unknown[];
        errors?: Array<{ message?: string }>;
      };
      const errorCount = parsed.errors?.length ?? 0;
      if (errorCount > 0 && (parsed.results?.length ?? 0) === 0) {
        const first = parsed.errors?.[0]?.message ?? 'no detail';
        failure = `semgrep reported ${errorCount} error(s) and 0 results: ${String(first).slice(0, 300)}`;
      }
    } catch {
      // Malformed stdout with exit 0/1 keeps the legacy path: parse()
      // returns [] and parseSafe's warn log records the parse error.
    }
  }

  if (failure) throw new Error(failure);
}

export const semgrepPlugin: ToolDefinition = {
  name: 'semgrep',
  displayName: 'Semgrep',
  category: 'security',
  tier: 'always-on',
  version: SEMGREP_VERSION,
  outputFormat: 'json',
  cachePaths: ['/usr/local/bin/semgrep'],

  async install(ctx: ExecutionContext): Promise<void> {
    const cached = await ctx.cacheRestore('semgrep', ['/usr/local/bin/semgrep']);
    if (cached) {
      try {
        await ctx.exec('semgrep', ['--version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Semgrep cache restored but binary not functional, reinstalling');
      }
    }

    await ctx.exec('pip', ['install', '--quiet', `semgrep==${SEMGREP_VERSION}`], {
      timeoutMs: 120_000,
    });
    await ctx.exec('semgrep', ['--version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('semgrep', ['/usr/local/bin/semgrep']);
  },

  async run(
    ctx: ExecutionContext,
    repoDir: string,
    _files: string[],
    timeout: number,
  ): Promise<RawToolOutput> {
    // Always run the broad registry ruleset (`auto`) AND, when available, ghagga's
    // own curated rules bundled with the package. Semgrep unions multiple --config
    // flags, so the curated rules run even offline. Degrade gracefully if missing.
    const configArgs = ['--config', 'auto'];
    const rulesPath = resolveSemgrepRulesPath();
    if (rulesPath) {
      configArgs.push('--config', rulesPath);
    } else {
      ctx.log('warn', 'semgrep: bundled semgrep-rules.yml not found, using --config auto only');
    }

    const raw = await ctx.exec('semgrep', ['--json', ...configArgs, '--quiet', repoDir], {
      timeoutMs: timeout,
      allowExitCodes: [1], // semgrep returns 1 when findings are present
    });

    // Exit >= 2 or an errors-array-only JSON payload is an operational
    // failure — surface it as a tool error instead of "success (0 findings)".
    assertSemgrepSucceeded(raw);

    return raw;
  },

  parse: parseSemgrepOutput,
};
