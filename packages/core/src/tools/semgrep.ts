/**
 * Semgrep static analysis tool runner.
 * Executes semgrep as a child process and parses JSON output.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FindingSeverity, ReviewFinding, ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, 'semgrep-rules.yml');
const TIMEOUT_MS = 60_000;

/**
 * Resolve the semgrep binary path.
 * Uses SEMGREP_PATH env var if set, otherwise falls back to PATH lookup.
 */
function resolveSemgrepBinary(): string {
  return process.env.SEMGREP_PATH ?? 'semgrep';
}

interface SemgrepResult {
  results: Array<{
    check_id: string;
    path: string;
    start: { line: number; col: number };
    end: { line: number; col: number };
    extra: {
      message: string;
      severity: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  errors: Array<{ message: string }>;
}

export function mapSeverity(semgrepSeverity: string): FindingSeverity {
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
 * Run Semgrep against file contents.
 * Files are written to a temp directory, scanned, then cleaned up.
 */
export async function runSemgrep(
  files: Map<string, string>,
  customRulesPath?: string,
): Promise<ToolResult> {
  const start = Date.now();

  const semgrepBin = resolveSemgrepBinary();

  try {
    // Check if semgrep is available
    const { stdout: semVer } = await execFileAsync(semgrepBin, ['--version'], { timeout: 10_000 });
    console.error(`[ghagga:semgrep] Version check OK (${semgrepBin}): ${semVer.trim()}`);
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown>;
    const stderr = errObj?.stderr ?? '';
    const code = errObj?.code ?? '';
    const signal = errObj?.signal ?? '';
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ghagga:semgrep] Version check FAILED (${semgrepBin}): code=${code} signal=${signal} stderr=${stderr} message=${message}`,
    );
    return {
      status: 'skipped',
      findings: [],
      error: `Semgrep not available: ${message}`,
      executionTimeMs: Date.now() - start,
    };
  }

  let tempDir: string | undefined;
  try {
    // Write files to temp directory
    tempDir = await mkdtemp(join(tmpdir(), 'ghagga-semgrep-'));
    for (const [filePath, content] of files) {
      const fullPath = join(tempDir, filePath);
      const dir = dirname(fullPath);
      await mkdtemp(dir).catch(() => {}); // ignore if exists
      await writeFile(fullPath, content, 'utf8').catch(async () => {
        // Create parent dirs recursively
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, 'utf8');
      });
    }

    // Run semgrep
    console.error(
      `[ghagga:semgrep] Scanning ${files.size} files in ${tempDir}, rules: ${RULES_PATH}`,
    );
    const configArgs = ['--config', RULES_PATH];
    if (customRulesPath) {
      configArgs.push('--config', customRulesPath);
    }

    const { stdout } = await execFileAsync(semgrepBin, ['--json', ...configArgs, tempDir], {
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    const result: SemgrepResult = JSON.parse(stdout);

    const findings: ReviewFinding[] = result.results.map((r) => ({
      severity: mapSeverity(r.extra.severity),
      category: 'security',
      file: r.path.replace(`${tempDir}/`, ''),
      line: r.start.line,
      message: r.extra.message,
      suggestion: undefined,
      source: 'semgrep' as const,
    }));

    return {
      status: 'success',
      findings,
      executionTimeMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const errObj = error as Record<string, unknown>;
    const stderr = String(errObj?.stderr ?? '');
    const stdout = String(errObj?.stdout ?? '');
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[ghagga:semgrep] Scan FAILED: ${message}\n  stderr: ${stderr.substring(0, 500)}\n  stdout: ${stdout.substring(0, 500)}`,
    );
    return {
      status: 'error',
      findings: [],
      error: `Semgrep failed: ${error instanceof Error ? error.message : String(error)}`,
      executionTimeMs: Date.now() - start,
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
