/**
 * Trivy vulnerability scanner — install, execute, parse.
 *
 * Installs Trivy via official install script on the GitHub Actions runner,
 * executes it against the repo checkout, and parses JSON output into ReviewFinding[].
 *
 * Severity mapping replicates packages/core/src/tools/trivy.ts mapSeverity:
 *   CRITICAL -> critical
 *   HIGH     -> high
 *   MEDIUM   -> medium
 *   LOW      -> low
 *   default  -> info
 */

import * as core from '@actions/core';
import { restoreToolCache, saveToolCache } from './cache.js';
import { execWithTimeout } from './exec.js';
import type { FindingSeverity, ReviewFinding, ToolResult } from './types.js';
import { TOOL_TIMEOUT_MS, TOOL_VERSIONS } from './types.js';

/**
 * Map Trivy severity to GHAGGA FindingSeverity.
 * Replicates the pattern from packages/core/src/tools/trivy.ts.
 */
function mapSeverity(trivySeverity: string): FindingSeverity {
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

/**
 * Install Trivy on the runner (skip if cached).
 * Uses the official install script from GitHub.
 * @returns true if installed/available, false if install failed
 */
export async function installTrivy(): Promise<boolean> {
  const cached = await restoreToolCache('trivy');
  if (cached) {
    // Verify binary works after cache restore
    try {
      await execWithTimeout('trivy', ['--version'], { timeoutMs: 10_000 });
      return true;
    } catch {
      core.warning('Trivy cache restored but binary not functional, reinstalling');
    }
  }

  try {
    // Install Trivy via official install script
    //   curl -sfL https://raw.githubusercontent.com/.../install.sh | sh -s -- -b /usr/local/bin
    await execWithTimeout(
      'bash',
      [
        '-c',
        `curl -sL "https://github.com/aquasecurity/trivy/releases/download/v${TOOL_VERSIONS.trivy}/trivy_${TOOL_VERSIONS.trivy}_Linux-64bit.tar.gz" -o /tmp/trivy.tar.gz && tar -xzf /tmp/trivy.tar.gz -C /tmp && mv /tmp/trivy /usr/local/bin/trivy && chmod +x /usr/local/bin/trivy && rm -f /tmp/trivy.tar.gz /tmp/LICENSE /tmp/README.md`,
      ],
      { timeoutMs: 120_000 },
    );
    await saveToolCache('trivy');
    return true;
  } catch (error) {
    core.warning(`Trivy install failed: ${error}`);
    return false;
  }
}

/**
 * Run Trivy and parse results.
 * @returns ToolResult (never throws)
 */
export async function executeTrivy(repoDir: string): Promise<ToolResult> {
  const start = Date.now();
  try {
    const installed = await installTrivy();
    if (!installed) {
      return {
        status: 'error',
        findings: [],
        error: 'Trivy installation failed',
        executionTimeMs: Date.now() - start,
      };
    }

    const { stdout } = await execWithTimeout(
      'trivy',
      ['fs', '--format', 'json', '--scanners', 'vuln', '--quiet', repoDir],
      { timeoutMs: TOOL_TIMEOUT_MS, allowNonZero: true },
    );

    const result: {
      Results?: Array<{
        Target: string;
        Vulnerabilities?: Array<{
          VulnerabilityID: string;
          PkgName: string;
          InstalledVersion: string;
          FixedVersion?: string;
          Severity: string;
          Title?: string;
          Description?: string;
        }>;
      }>;
    } = JSON.parse(stdout);

    const findings: ReviewFinding[] = [];

    for (const target of result.Results ?? []) {
      for (const vuln of target.Vulnerabilities ?? []) {
        const fixInfo = vuln.FixedVersion
          ? ` (fix: upgrade to ${vuln.FixedVersion})`
          : ' (no fix available)';

        findings.push({
          severity: mapSeverity(vuln.Severity),
          category: 'dependency-vulnerability',
          file: target.Target,
          message: `${vuln.VulnerabilityID}: ${vuln.PkgName}@${vuln.InstalledVersion} - ${vuln.Title ?? vuln.Description ?? 'Known vulnerability'}${fixInfo}`,
          source: 'trivy' as const,
        });
      }
    }

    return {
      status: 'success',
      findings,
      executionTimeMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'error',
      findings: [],
      error: `Trivy failed: ${error instanceof Error ? error.message : String(error)}`,
      executionTimeMs: Date.now() - start,
    };
  }
}
