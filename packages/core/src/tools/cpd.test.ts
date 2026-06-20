import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  promisify: vi.fn((fn: any) => fn),
}));

import { execFile } from 'node:child_process';
import { parseCpdXml, runCpd } from './cpd.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockExecFile = vi.mocked(execFile);

function makeCpdXml(duplications: string[] = []) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<pmd-cpd>',
    ...duplications,
    '</pmd-cpd>',
  ].join('\n');
}

function makeDuplication(files: Array<{ path: string; line: number }>, lines = 10, tokens = 100) {
  const fileElements = files.map(
    (f) => `    <file path="${f.path}" line="${f.line}" endline="${f.line + lines}" />`,
  );
  return [
    `  <duplication lines="${lines}" tokens="${tokens}">`,
    ...fileElements,
    '    <codefragment><![CDATA[duplicated code here]]></codefragment>',
    '  </duplication>',
  ].join('\n');
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runCpd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Binary detection ──

  it('returns skipped when neither cpd nor pmd is available', async () => {
    mockExecFile.mockRejectedValue(new Error('command not found'));

    const result = await runCpd('/project');

    expect(result.status).toBe('skipped');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('CPD/PMD not available');
  });

  it('tries cpd first, then pmd cpd', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'));

    await runCpd('/project');

    // First: cpd --help
    expect(mockExecFile).toHaveBeenCalledWith(
      'cpd',
      ['--help'],
      expect.objectContaining({ timeout: 5_000 }),
    );
    // Second: pmd cpd --help
    expect(mockExecFile).toHaveBeenCalledWith(
      'pmd',
      ['cpd', '--help'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  // ── BL-SARIF-STDOUT: diagnostics must go to stderr, never stdout ──

  it('writes binary-detection diagnostics to stderr (not stdout) so SARIF/JSON stays clean', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecFile
      // Both standalone-cpd paths (`cpd`, `/usr/local/bin/cpd`) fail → fall
      // through to pmd, so the "Found pmd at" diagnostic fires.
      .mockRejectedValueOnce(new Error('not found'))
      .mockRejectedValueOnce(new Error('not found'))
      // pmd cpd --help succeeds (this is the binary)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'pmd version', stderr: '' } as any)
      // pmd cpd scan
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/project');

    // No diagnostic was written to stdout.
    expect(logSpy).not.toHaveBeenCalled();
    // Both binary-detection diagnostic lines went to stderr.
    const stderrText = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrText).toContain('[ghagga:cpd] Found pmd at:');
    expect(stderrText).toContain('[ghagga:cpd] Binary found:');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('uses standalone cpd when available', async () => {
    mockExecFile
      // cpd --help succeeds
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // cpd scan
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/project');

    // The scan call should use 'cpd' (not 'pmd')
    const scanCall = mockExecFile.mock.calls[1]!;
    expect(scanCall[0]).toBe('cpd');
    expect(scanCall[1]).not.toContain('cpd'); // no 'cpd' in args (it's the command itself)
  });

  it('falls back to pmd cpd when standalone cpd is not available', async () => {
    mockExecFile
      // cpd --help fails
      .mockRejectedValueOnce(new Error('not found'))
      // /usr/local/bin/cpd --help fails
      .mockRejectedValueOnce(new Error('not found'))
      // pmd cpd --help succeeds
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'pmd version', stderr: '' } as any)
      // pmd cpd scan
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/project');

    const scanCall = mockExecFile.mock.calls[3]!;
    expect(scanCall[0]).toBe('pmd');
    expect((scanCall[1] as string[])[0]).toBe('cpd');
  });

  // ── Successful run ──

  it('returns success with parsed findings from clean output', async () => {
    const xml = makeCpdXml([
      makeDuplication(
        [
          { path: '/project/src/a.ts', line: 10 },
          { path: '/project/src/b.ts', line: 20 },
        ],
        15,
        120,
      ),
    ]);

    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: xml, stderr: '' } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('duplication');
    expect(result.findings[0]?.message).toContain('15 lines');
    expect(result.findings[0]?.message).toContain('120 tokens');
  });

  it('returns success with empty findings when no duplications', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  // ── Minimum tokens option ──

  it('uses default minimum tokens of 100', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/project');

    const scanCall = mockExecFile.mock.calls[1]!;
    const args = scanCall[1] as string[];
    const tokenIdx = args.indexOf('--minimum-tokens');
    expect(args[tokenIdx + 1]).toBe('100');
  });

  it('uses custom minimum tokens when provided', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/project', { minimumTokens: 50 });

    const scanCall = mockExecFile.mock.calls[1]!;
    const args = scanCall[1] as string[];
    const tokenIdx = args.indexOf('--minimum-tokens');
    expect(args[tokenIdx + 1]).toBe('50');
  });

  // ── CPD exit code 4 (duplications found) ──

  it('handles CPD exit code 4 by reading stdout from error object', async () => {
    const xml = makeCpdXml([
      makeDuplication(
        [
          { path: '/project/src/x.ts', line: 1 },
          { path: '/project/src/y.ts', line: 5 },
        ],
        20,
        200,
      ),
    ]);

    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // CPD exit code 4: error object with stdout containing results
      .mockRejectedValueOnce({
        message: 'Process exited with code 4',
        stdout: xml,
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('20 lines');
  });

  it('handles exit code 4 with pmd-cpd tag in stdout', async () => {
    const xmlWithDup = makeCpdXml([
      makeDuplication([
        { path: '/project/src/a.ts', line: 1 },
        { path: '/project/src/b.ts', line: 1 },
      ]),
    ]);

    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockRejectedValueOnce({ stdout: xmlWithDup } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('success');
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  // ── Error handling ──

  it('returns error when scan fails without stdout', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      .mockRejectedValueOnce(new Error('Out of memory'));

    const result = await runCpd('/project');

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('CPD failed');
    expect(result.error).toContain('Out of memory');
  });

  it('returns error when error object has stdout without pmd-cpd tag', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      .mockRejectedValueOnce({
        message: 'Exit code 1',
        stdout: 'some non-XML garbage',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('error');
  });

  it('returns error when error has empty stdout', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      .mockRejectedValueOnce({
        message: 'Failed',
        stdout: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runCpd('/project');

    expect(result.status).toBe('error');
  });

  it('includes executionTimeMs in all results', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'));

    const result = await runCpd('/project');

    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  // ── Scan arguments ──

  it('passes correct arguments to cpd', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'cpd version', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeCpdXml([]), stderr: '' } as any);

    await runCpd('/my/project', { minimumTokens: 75 });

    const scanCall = mockExecFile.mock.calls[1]!;
    const args = scanCall[1] as string[];
    expect(args).toContain('--format');
    expect(args).toContain('xml');
    expect(args).toContain('--minimum-tokens');
    expect(args).toContain('75');
    expect(args).toContain('--dir');
    expect(args).toContain('/my/project');
    expect(args).toContain('--skip-lexical-errors');
  });
});

// ─── parseCpdXml ────────────────────────────────────────────────

describe('parseCpdXml', () => {
  it('returns empty array for empty CPD output', () => {
    const xml = makeCpdXml([]);
    expect(parseCpdXml(xml, '/project')).toEqual([]);
  });

  it('parses a single duplication with 2 files', () => {
    const xml = makeCpdXml([
      makeDuplication(
        [
          { path: '/project/src/a.ts', line: 10 },
          { path: '/project/src/b.ts', line: 20 },
        ],
        15,
        120,
      ),
    ]);

    const findings = parseCpdXml(xml, '/project');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.category).toBe('duplication');
    expect(findings[0]?.file).toBe('src/a.ts');
    expect(findings[0]?.line).toBe(10);
    expect(findings[0]?.source).toBe('cpd');
  });

  it('skips duplications with fewer than 2 files', () => {
    const xml = `<pmd-cpd>
  <duplication lines="5" tokens="50">
    <file path="/project/src/only.ts" line="1" endline="5" />
    <codefragment><![CDATA[code]]></codefragment>
  </duplication>
</pmd-cpd>`;

    const findings = parseCpdXml(xml, '/project');
    expect(findings).toHaveLength(0);
  });
});
