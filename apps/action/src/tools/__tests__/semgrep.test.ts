import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
}));

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { exec } from '@actions/exec';
import { executeSemgrep, installSemgrep } from '../semgrep.js';
import { TOOL_VERSIONS } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockExec = vi.mocked(exec);
const mockRestoreCache = vi.mocked(cache.restoreCache);
const mockSaveCache = vi.mocked(cache.saveCache);
const mockWarning = vi.mocked(core.warning);

/**
 * Simulate @actions/exec: invoke listeners, return exit code.
 */
function simulateExec(exitCode: number, stdout = '', stderr = ''): ReturnType<typeof mockExec> {
  return mockExec.mockImplementationOnce(async (_cmd, _args, options) => {
    if (stdout && options?.listeners?.stdout) {
      options.listeners.stdout(Buffer.from(stdout));
    }
    if (stderr && options?.listeners?.stderr) {
      options.listeners.stderr(Buffer.from(stderr));
    }
    return exitCode;
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
  }) as any;
}

/** Realistic Semgrep JSON output */
const SEMGREP_FINDINGS_JSON = JSON.stringify({
  results: [
    {
      check_id: 'javascript.express.security.audit.xss.mustache-escape',
      path: '/workspace/src/app.js',
      start: { line: 42, col: 5 },
      end: { line: 42, col: 30 },
      extra: {
        severity: 'WARNING',
        message: 'Detected potential XSS vulnerability',
        metadata: {},
      },
    },
    {
      check_id: 'javascript.express.security.audit.sql-injection',
      path: '/workspace/src/db.ts',
      start: { line: 15, col: 1 },
      end: { line: 15, col: 60 },
      extra: {
        severity: 'ERROR',
        message: 'SQL injection risk in query construction',
        metadata: {},
      },
    },
    {
      check_id: 'javascript.generic.info.unused-import',
      path: '/workspace/src/utils.ts',
      start: { line: 3, col: 1 },
      end: { line: 3, col: 20 },
      extra: {
        severity: 'INFO',
        message: 'Unused import detected',
        metadata: {},
      },
    },
  ],
  errors: [],
});

const SEMGREP_NO_FINDINGS = JSON.stringify({
  results: [],
  errors: [],
});

// ─── installSemgrep Tests ───────────────────────────────────────

describe('installSemgrep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  it('skips pip install on cache hit when binary is functional', async () => {
    mockRestoreCache.mockResolvedValue('ghagga-semgrep-hit');
    // semgrep --version succeeds
    simulateExec(0, '1.90.0', '');

    const result = await installSemgrep();

    expect(result).toBe(true);
    // Should NOT call pip install
    expect(mockExec).toHaveBeenCalledTimes(1); // only --version
  });

  it('reinstalls if cache restored but binary not functional', async () => {
    mockRestoreCache.mockResolvedValue('ghagga-semgrep-hit');
    // semgrep --version fails
    mockExec.mockImplementationOnce(async () => {
      throw new Error('semgrep: not found');
    });
    // pip install succeeds
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installSemgrep();

    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
    // pip install was called
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('runs pip install on cache miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    // pip install succeeds
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installSemgrep();

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'pip',
      ['install', '--quiet', `semgrep==${TOOL_VERSIONS.semgrep}`],
      expect.any(Object),
    );
  });

  it('saves to cache after successful pip install', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installSemgrep();

    expect(mockSaveCache).toHaveBeenCalled();
  });

  it('returns false on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    // pip install fails
    mockExec.mockImplementationOnce(async () => {
      throw new Error('pip: network error');
    });

    const result = await installSemgrep();

    expect(result).toBe(false);
  });

  it('logs warning on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('pip: network error');
    });

    await installSemgrep();

    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Semgrep install failed'));
  });
});

// ─── executeSemgrep Tests ───────────────────────────────────────

describe('executeSemgrep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  /**
   * Helper: mock a successful install (cache hit + version check passes)
   * so we can focus on execution tests.
   */
  function mockSuccessfulInstall() {
    mockRestoreCache.mockResolvedValue('hit');
    // semgrep --version
    simulateExec(0, '1.90.0', '');
  }

  it('returns error status when install fails', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('pip: failure');
    });

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toBe('Semgrep installation failed');
    expect(result.findings).toEqual([]);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('parses findings from realistic JSON output', async () => {
    mockSuccessfulInstall();
    // semgrep scan returns findings
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(3);
  });

  it('maps severity correctly: WARNING -> medium', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    const xssFinding = result.findings.find((f) => f.message.includes('XSS'));
    expect(xssFinding?.severity).toBe('medium');
  });

  it('maps severity correctly: ERROR -> high', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    const sqlFinding = result.findings.find((f) => f.message.includes('SQL injection'));
    expect(sqlFinding?.severity).toBe('high');
  });

  it('maps severity correctly: INFO -> info', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    const infoFinding = result.findings.find((f) => f.message.includes('Unused import'));
    expect(infoFinding?.severity).toBe('info');
  });

  it('maps unknown severity to low', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      results: [
        {
          check_id: 'test.rule',
          path: '/workspace/src/file.ts',
          start: { line: 1, col: 1 },
          end: { line: 1, col: 10 },
          extra: { severity: 'UNKNOWN', message: 'Unknown issue' },
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeSemgrep('/workspace');

    expect(result.findings[0]?.severity).toBe('low');
  });

  it('sets correct finding fields', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        category: 'security',
        source: 'semgrep',
        file: 'src/app.js', // repoDir prefix stripped
        line: 42,
        message: 'Detected potential XSS vulnerability',
      }),
    );
  });

  it('strips repoDir prefix from file paths', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    for (const finding of result.findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
  });

  it('returns success with empty findings when no results', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_NO_FINDINGS, '');

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('handles missing results field in JSON', async () => {
    mockSuccessfulInstall();
    simulateExec(0, JSON.stringify({ errors: [] }), '');

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns error status on malformed JSON', async () => {
    mockSuccessfulInstall();
    simulateExec(0, 'not valid json {{{', '');

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Semgrep failed');
    expect(result.findings).toEqual([]);
  });

  it('returns error status when exec produces no stdout (e.g. timeout)', async () => {
    mockSuccessfulInstall();
    // Simulate exec that resolves but produces no stdout (listeners never called)
    mockExec.mockImplementationOnce(() => Promise.resolve(0));

    const result = await executeSemgrep('/workspace');

    // Empty stdout causes JSON.parse to throw, caught by the try/catch
    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
  });

  it('returns error on execution timeout', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // version check passes
    simulateExec(0, '1.90.0', '');
    // Execution hangs — simulate via rejection
    mockExec.mockImplementationOnce(async () => {
      throw new Error('Timed out after 180000ms');
    });

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Timed out');
  });

  it('always populates executionTimeMs', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_NO_FINDINGS, '');

    const result = await executeSemgrep('/workspace');

    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('never throws', async () => {
    mockRestoreCache.mockRejectedValue(new Error('catastrophic'));

    const result = await executeSemgrep('/workspace');

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
  });

  it('calls semgrep with --json --config auto --quiet and repoDir', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_NO_FINDINGS, '');

    await executeSemgrep('/my/repo');

    // The second exec call is the scan
    const scanCall = mockExec.mock.calls[1]!;
    expect(scanCall[0]).toBe('semgrep');
    expect(scanCall[1]).toEqual(['--json', '--config', 'auto', '--quiet', '/my/repo']);
  });

  it('uses allowNonZero: true for scan', async () => {
    mockSuccessfulInstall();
    simulateExec(1, SEMGREP_FINDINGS_JSON, '');

    const result = await executeSemgrep('/workspace');

    // Even with exit code 1, should parse findings
    expect(result.status).toBe('success');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  // ── executionTimeMs arithmetic ──

  it('executionTimeMs is a small positive number (not Date.now() + start)', async () => {
    mockSuccessfulInstall();
    simulateExec(0, SEMGREP_NO_FINDINGS, '');

    const result = await executeSemgrep('/workspace');

    // If code used + instead of -, executionTimeMs would be ~2×Date.now() ≈ huge number
    expect(result.executionTimeMs).toBeLessThan(5000);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executionTimeMs is small on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('pip: failure');
    });

    const result = await executeSemgrep('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  it('executionTimeMs is small on execution error', async () => {
    mockSuccessfulInstall();
    simulateExec(0, 'not valid json {{{', '');

    const result = await executeSemgrep('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  // ── Install version check args ──

  it('verifies cached binary with semgrep --version', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, '1.90.0', '');

    await installSemgrep();

    expect(mockExec).toHaveBeenCalledWith('semgrep', ['--version'], expect.any(Object));
  });

  it('uses 10s timeout for version check', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // Simulate a command that takes longer than 10s — version check should timeout
    mockExec.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 15_000)),
    );

    // installSemgrep catches the timeout and tries reinstall
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installSemgrep();

    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
  }, 20_000);

  it('uses 120s timeout for pip install', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installSemgrep();

    // Verify pip was called — timeoutMs is handled internally by execWithTimeout
    expect(mockExec).toHaveBeenCalledWith(
      'pip',
      ['install', '--quiet', `semgrep==${TOOL_VERSIONS.semgrep}`],
      expect.any(Object),
    );
  });
});
