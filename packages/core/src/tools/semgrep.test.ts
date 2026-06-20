import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

// We need to mock promisify to return our mock execFile
vi.mock('node:util', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  promisify: vi.fn((fn: any) => fn),
}));

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mapSeverity, runSemgrep } from './semgrep.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockExecFile = vi.mocked(execFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdtemp = vi.mocked(mkdtemp);
const mockRm = vi.mocked(rm);

// biome-ignore lint/suspicious/noExplicitAny: mock helper
function makeSemgrepOutput(results: any[] = []) {
  return JSON.stringify({
    results,
    errors: [],
  });
}

function makeSemgrepResult(
  overrides: Partial<{
    check_id: string;
    path: string;
    startLine: number;
    message: string;
    severity: string;
  }> = {},
) {
  return {
    check_id: overrides.check_id ?? 'rules.test-rule',
    path: overrides.path ?? '/tmp/ghagga-semgrep-abc123/src/index.ts',
    start: { line: overrides.startLine ?? 10, col: 1 },
    end: { line: (overrides.startLine ?? 10) + 5, col: 20 },
    extra: {
      message: overrides.message ?? 'Potential issue found',
      severity: overrides.severity ?? 'WARNING',
      metadata: {},
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runSemgrep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockMkdtemp.mockResolvedValue('/tmp/ghagga-semgrep-abc123' as any);
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockWriteFile.mockResolvedValue(undefined as any);
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockRm.mockResolvedValue(undefined as any);
  });

  // ── Semgrep not available ──

  it('returns skipped when semgrep is not available', async () => {
    mockExecFile.mockRejectedValue(new Error('semgrep not found'));

    const result = await runSemgrep(new Map([['file.ts', 'content']]));

    expect(result.status).toBe('skipped');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('Semgrep not available');
  });

  it('checks semgrep version first', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'));

    await runSemgrep(new Map());

    expect(mockExecFile).toHaveBeenCalledWith(
      'semgrep',
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  // ── Successful run ──

  it('returns success with parsed findings', async () => {
    // First call: version check
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      // Second call: actual scan
      .mockResolvedValueOnce({
        stdout: makeSemgrepOutput([
          makeSemgrepResult({
            path: '/tmp/ghagga-semgrep-abc123/src/auth.ts',
            startLine: 42,
            message: 'SQL injection risk',
            severity: 'ERROR',
          }),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const files = new Map([['src/auth.ts', 'const query = "SELECT * FROM users WHERE id=" + id;']]);
    const result = await runSemgrep(files);

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        severity: 'high',
        category: 'security',
        file: 'src/auth.ts',
        line: 42,
        message: 'SQL injection risk',
        source: 'semgrep',
      }),
    );
  });

  // ── BL-SARIF-STDOUT: diagnostics must go to stderr, never stdout ──

  it('writes progress/diagnostics to stderr (not stdout) so SARIF/JSON stays clean', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeSemgrepOutput([]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    await runSemgrep(new Map([['file.ts', 'clean code']]));

    // No diagnostic was written to stdout.
    expect(logSpy).not.toHaveBeenCalled();
    // The version-check + scanning progress lines went to stderr.
    const stderrText = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrText).toContain('[ghagga:semgrep] Version check OK');
    expect(stderrText).toContain('[ghagga:semgrep] Scanning');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns success with empty findings when no issues found', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeSemgrepOutput([]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runSemgrep(new Map([['file.ts', 'clean code']]));

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('parses multiple findings', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeSemgrepOutput([
          makeSemgrepResult({
            path: '/tmp/ghagga-semgrep-abc123/a.ts',
            message: 'Issue 1',
            severity: 'ERROR',
          }),
          makeSemgrepResult({
            path: '/tmp/ghagga-semgrep-abc123/b.ts',
            message: 'Issue 2',
            severity: 'WARNING',
          }),
          makeSemgrepResult({
            path: '/tmp/ghagga-semgrep-abc123/c.ts',
            message: 'Issue 3',
            severity: 'INFO',
          }),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const files = new Map([
      ['a.ts', 'a'],
      ['b.ts', 'b'],
      ['c.ts', 'c'],
    ]);
    const result = await runSemgrep(files);

    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]?.severity).toBe('high');
    expect(result.findings[1]?.severity).toBe('medium');
    expect(result.findings[2]?.severity).toBe('info');
  });

  // ── File handling ──

  it('writes all files to temp directory', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeSemgrepOutput([]), stderr: '' } as any);

    const files = new Map([
      ['src/a.ts', 'content a'],
      ['src/b.ts', 'content b'],
    ]);

    await runSemgrep(files);

    expect(mockMkdtemp).toHaveBeenCalled();
    // writeFile called for each file (might be called more on retry)
    expect(mockWriteFile).toHaveBeenCalled();
  });

  // ── Custom rules ──

  it('includes custom rules path when provided', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeSemgrepOutput([]), stderr: '' } as any);

    await runSemgrep(new Map([['file.ts', 'code']]), '/path/to/custom-rules.yml');

    // The second execFile call (scan) should include custom rules
    const scanCall = mockExecFile.mock.calls[1]!;
    const args = scanCall[1] as string[];
    expect(args).toContain('--config');
    expect(args).toContain('/path/to/custom-rules.yml');
  });

  // ── Temp dir cleanup ──

  it('cleans up temp directory after successful run', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeSemgrepOutput([]), stderr: '' } as any);

    await runSemgrep(new Map([['file.ts', 'code']]));

    expect(mockRm).toHaveBeenCalledWith('/tmp/ghagga-semgrep-abc123', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up temp directory even on scan error', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockRejectedValueOnce(new Error('Scan failed'));

    await runSemgrep(new Map([['file.ts', 'code']]));

    expect(mockRm).toHaveBeenCalledWith('/tmp/ghagga-semgrep-abc123', {
      recursive: true,
      force: true,
    });
  });

  // ── Error handling ──

  it('returns error status when scan fails', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockRejectedValueOnce(new Error('Process timeout'));

    const result = await runSemgrep(new Map([['file.ts', 'code']]));

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('Semgrep failed');
    expect(result.error).toContain('Process timeout');
  });

  it('includes executionTimeMs in all results', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeSemgrepOutput([]), stderr: '' } as any);

    const result = await runSemgrep(new Map([['file.ts', 'code']]));

    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.executionTimeMs).toBe('number');
  });

  it('strips temp dir prefix from finding file paths', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeSemgrepOutput([
          makeSemgrepResult({
            path: '/tmp/ghagga-semgrep-abc123/src/deep/nested/file.ts',
          }),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runSemgrep(new Map([['src/deep/nested/file.ts', 'code']]));

    expect(result.findings[0]?.file).toBe('src/deep/nested/file.ts');
    expect(result.findings[0]?.file).not.toContain('/tmp/');
  });
});

// ─── mapSeverity (also tested in parsers.test.ts but for completeness) ──

describe('mapSeverity', () => {
  it('maps ERROR to high', () => expect(mapSeverity('ERROR')).toBe('high'));
  it('maps WARNING to medium', () => expect(mapSeverity('WARNING')).toBe('medium'));
  it('maps INFO to info', () => expect(mapSeverity('INFO')).toBe('info'));
  it('maps unknown to low', () => expect(mapSeverity('OTHER')).toBe('low'));
});
