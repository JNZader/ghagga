/**
 * Trivy plugin — SCA vulnerability + license scanning (always-on).
 *
 * Adapted from:
 * - packages/core/src/tools/trivy.ts (parsing logic)
 * - apps/action/src/tools/trivy.ts (install/run flow)
 *
 * Enhanced: adds --scanners license to existing vuln scanner.
 * Uses ExecutionContext for DI instead of direct child_process.
 */

import type { FindingSeverity, ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from '../types.js';

const TRIVY_VERSION = '0.69.3';

/**
 * Map Trivy severity to GHAGGA FindingSeverity.
 * CRITICAL -> critical, HIGH -> high, MEDIUM -> medium, LOW -> low, default -> info
 */
export function mapTrivySeverity(trivySeverity: string): FindingSeverity {
  switch (trivySeverity.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'info';
  }
}

/** Trivy JSON output structure */
interface TrivyResult {
  Results?: Array<{
    Target: string;
    Type?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID: string;
      PkgName: string;
      InstalledVersion: string;
      FixedVersion?: string;
      Severity: string;
      Title?: string;
      Description?: string;
    }>;
    Licenses?: Array<{
      Severity: string;
      Category: string;
      PkgName: string;
      Name: string;
      Confidence: number;
    }>;
  }>;
}

/**
 * Parse Trivy JSON output into ReviewFinding[].
 * Handles both vulnerability and license findings.
 * Exported for direct testing with fixture data.
 */
export function parseTrivyOutput(raw: RawToolOutput, _repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];

  try {
    const result: TrivyResult = JSON.parse(raw.stdout);
    const findings: ReviewFinding[] = [];

    for (const target of result.Results ?? []) {
      // Parse vulnerability findings (existing behavior)
      for (const vuln of target.Vulnerabilities ?? []) {
        const fixInfo = vuln.FixedVersion
          ? ` (fix: upgrade to ${vuln.FixedVersion})`
          : ' (no fix available)';

        findings.push({
          severity: mapTrivySeverity(vuln.Severity),
          category: 'dependency-vulnerability',
          file: target.Target,
          message: `${vuln.VulnerabilityID}: ${vuln.PkgName}@${vuln.InstalledVersion} - ${vuln.Title ?? vuln.Description ?? 'Known vulnerability'}${fixInfo}`,
          source: 'trivy' as const,
        });
      }

      // Parse license findings (new enhancement)
      for (const license of target.Licenses ?? []) {
        findings.push({
          severity: 'info',
          category: 'license',
          file: target.Target,
          message: `${license.PkgName}: ${license.Name} (${license.Category})`,
          source: 'trivy' as const,
        });
      }
    }

    return findings;
  } catch {
    return [];
  }
}

export const trivyPlugin: ToolDefinition = {
  name: 'trivy',
  displayName: 'Trivy',
  category: 'sca',
  tier: 'always-on',
  version: TRIVY_VERSION,
  outputFormat: 'json',
  cachePaths: ['/usr/local/bin/trivy'],

  async install(ctx: ExecutionContext): Promise<void> {
    const cached = await ctx.cacheRestore('trivy', ['/usr/local/bin/trivy']);
    if (cached) {
      try {
        await ctx.exec('trivy', ['--version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Trivy cache restored but binary not functional, reinstalling');
      }
    }

    // Install Trivy via official install script
    await ctx.exec(
      'bash',
      [
        '-c',
        `curl -sL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" -o /tmp/trivy.tar.gz && tar -xzf /tmp/trivy.tar.gz -C /tmp && mv /tmp/trivy /usr/local/bin/trivy && chmod +x /usr/local/bin/trivy && rm -f /tmp/trivy.tar.gz /tmp/LICENSE /tmp/README.md`,
      ],
      { timeoutMs: 120_000 },
    );
    await ctx.exec('trivy', ['--version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('trivy', ['/usr/local/bin/trivy']);
  },

  async run(
    ctx: ExecutionContext,
    repoDir: string,
    _files: string[],
    timeout: number,
  ): Promise<RawToolOutput> {
    // Enhanced: adds 'license' scanner alongside 'vuln'
    return ctx.exec(
      'trivy',
      ['fs', '--format', 'json', '--scanners', 'vuln,license', '--quiet', repoDir],
      {
        timeoutMs: timeout,
        allowExitCodes: [1],
      },
    );
  },

  parse: parseTrivyOutput,
};
