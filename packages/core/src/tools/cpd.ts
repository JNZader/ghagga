/**
 * PMD/CPD (Copy-Paste Detector) for duplicate code detection.
 * Executes cpd as a child process and parses XML output.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewFinding, ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 60_000;
const DEFAULT_MIN_TOKENS = 100;

/**
 * Simple XML parser for CPD output.
 * CPD XML format:
 * <pmd-cpd>
 *   <duplication lines="N" tokens="N">
 *     <file path="..." line="N" endline="N" />
 *     <file path="..." line="N" endline="N" />
 *     <codefragment>...</codefragment>
 *   </duplication>
 * </pmd-cpd>
 */
export function parseCpdXml(xml: string, basePath: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const dupRegex = /<duplication lines="(\d+)" tokens="(\d+)">([\s\S]*?)<\/duplication>/g;
  const fileRegex = /<file\s+path="([^"]+)"\s+line="(\d+)"/g;

  let dupMatch = dupRegex.exec(xml);
  while (dupMatch !== null) {
    const lines = parseInt(dupMatch[1] ?? '0', 10);
    const tokens = parseInt(dupMatch[2] ?? '0', 10);
    const inner = dupMatch[3] ?? '';

    const files: Array<{ path: string; line: number }> = [];
    fileRegex.lastIndex = 0;
    let fileMatch = fileRegex.exec(inner);
    while (fileMatch !== null) {
      files.push({
        path: fileMatch[1]?.replace(`${basePath}/`, ''),
        line: parseInt(fileMatch[2] ?? '0', 10),
      });
      fileMatch = fileRegex.exec(inner);
    }

    if (files.length >= 2) {
      const locations = files.map((f) => `${f.path}:${f.line}`).join(', ');
      findings.push({
        severity: 'medium',
        category: 'duplication',
        file: files[0]?.path,
        line: files[0]?.line,
        message: `Duplicated code block (${lines} lines, ${tokens} tokens) found in: ${locations}`,
        suggestion: 'Extract the duplicated code into a shared function or module.',
        source: 'cpd' as const,
      });
    }
    dupMatch = dupRegex.exec(xml);
  }

  return findings;
}

/**
 * Detect the CPD binary name. Supports both `cpd` (standalone)
 * and `pmd cpd` (PMD 7+ CLI).
 */
async function findCpdBinary(): Promise<{ cmd: string; args: string[] } | null> {
  // Try standalone cpd first (with absolute path fallback)
  const cpdPaths = ['cpd', '/usr/local/bin/cpd'];
  for (const cmd of cpdPaths) {
    try {
      await execFileAsync(cmd, ['--help'], { timeout: 5_000 });
      return { cmd, args: [] };
    } catch {
      // Continue to next
    }
  }

  // Try pmd CLI (PMD 7+) with absolute path fallback
  const pmdPaths = ['pmd', '/usr/local/bin/pmd', '/opt/pmd/bin/pmd'];
  for (const cmd of pmdPaths) {
    try {
      await execFileAsync(cmd, ['cpd', '--help'], { timeout: 5_000 });
      console.error(`[ghagga:cpd] Found pmd at: ${cmd}`);
      return { cmd, args: ['cpd'] };
    } catch {
      // Continue to next
    }
  }

  return null;
}

/**
 * Run CPD against a directory to find duplicated code.
 */
export async function runCpd(
  scanPath: string,
  options: { minimumTokens?: number } = {},
): Promise<ToolResult> {
  const start = Date.now();
  const minimumTokens = options.minimumTokens ?? DEFAULT_MIN_TOKENS;

  const binary = await findCpdBinary();
  if (!binary) {
    console.error('[ghagga:cpd] Binary check FAILED: neither cpd nor pmd found');
    return {
      status: 'skipped',
      findings: [],
      error: 'CPD/PMD not available. Install from: https://pmd.github.io',
      executionTimeMs: Date.now() - start,
    };
  }
  console.error(`[ghagga:cpd] Binary found: ${binary.cmd} ${binary.args.join(' ')}`);

  try {
    const args = [
      ...binary.args,
      '--format',
      'xml',
      '--minimum-tokens',
      String(minimumTokens),
      '--dir',
      scanPath,
      '--skip-lexical-errors',
    ];

    const { stdout } = await execFileAsync(binary.cmd, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    const findings = parseCpdXml(stdout, scanPath);

    return {
      status: 'success',
      findings,
      executionTimeMs: Date.now() - start,
    };
  } catch (error) {
    // CPD exits with code 4 when duplications are found (not an error)
    if (error && typeof error === 'object' && 'stdout' in error) {
      const stdout = (error as { stdout: string }).stdout;
      if (stdout?.includes('<pmd-cpd')) {
        const findings = parseCpdXml(stdout, scanPath);
        return {
          status: 'success',
          findings,
          executionTimeMs: Date.now() - start,
        };
      }
    }

    return {
      status: 'error',
      findings: [],
      error: `CPD failed: ${error instanceof Error ? error.message : String(error)}`,
      executionTimeMs: Date.now() - start,
    };
  }
}
