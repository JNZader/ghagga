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
import { mapSeverity, runTrivy } from './trivy.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockExecFile = vi.mocked(execFile);

// biome-ignore lint/suspicious/noExplicitAny: mock helper
function makeTrivyOutput(results: any[] = []) {
  return JSON.stringify({ Results: results });
}

function makeTrivyTarget(
  target: string,
  vulns: Array<{
    VulnerabilityID?: string;
    PkgName?: string;
    InstalledVersion?: string;
    FixedVersion?: string;
    Severity?: string;
    Title?: string;
    Description?: string;
  }> = [],
) {
  return {
    Target: target,
    Type: 'npm',
    Vulnerabilities: vulns.map((v) => ({
      VulnerabilityID: v.VulnerabilityID ?? 'CVE-2024-0001',
      PkgName: v.PkgName ?? 'lodash',
      InstalledVersion: v.InstalledVersion ?? '4.17.20',
      FixedVersion: v.FixedVersion,
      Severity: v.Severity ?? 'HIGH',
      Title: v.Title,
      Description: v.Description,
    })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runTrivy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Trivy not available ──

  it('returns skipped when trivy is not available', async () => {
    mockExecFile.mockRejectedValue(new Error('trivy: command not found'));

    const result = await runTrivy('/project');

    expect(result.status).toBe('skipped');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('Trivy not available');
  });

  it('checks trivy version first', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'));

    await runTrivy('/project');

    expect(mockExecFile).toHaveBeenCalledWith(
      'trivy',
      ['--version'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  // ── Successful run ──

  it('returns success with parsed vulnerability findings', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: 'Version: 0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          makeTrivyTarget('package-lock.json', [
            {
              VulnerabilityID: 'CVE-2024-1234',
              PkgName: 'express',
              InstalledVersion: '4.17.1',
              FixedVersion: '4.18.2',
              Severity: 'HIGH',
              Title: 'Prototype pollution in express',
            },
          ]),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        severity: 'high',
        category: 'dependency-vulnerability',
        file: 'package-lock.json',
        source: 'trivy',
      }),
    );
    expect(result.findings[0]?.message).toContain('CVE-2024-1234');
    expect(result.findings[0]?.message).toContain('express@4.17.1');
    expect(result.findings[0]?.message).toContain('Prototype pollution in express');
    expect(result.findings[0]?.message).toContain('fix: upgrade to 4.18.2');
    expect(result.findings[0]?.suggestion).toBe('Upgrade express to 4.18.2');
  });

  it('handles no fix available', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          makeTrivyTarget('yarn.lock', [
            {
              VulnerabilityID: 'CVE-2024-5678',
              PkgName: 'node-forge',
              InstalledVersion: '1.0.0',
              FixedVersion: undefined,
              Severity: 'CRITICAL',
              Title: 'Buffer overflow',
            },
          ]),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.findings[0]?.message).toContain('no fix available');
    expect(result.findings[0]?.suggestion).toBeUndefined();
  });

  it('uses Description when Title is not available', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          makeTrivyTarget('go.sum', [
            {
              VulnerabilityID: 'CVE-2024-9999',
              PkgName: 'golang.org/x/net',
              InstalledVersion: '0.1.0',
              FixedVersion: '0.2.0',
              Severity: 'MEDIUM',
              Title: undefined,
              Description: 'HTTP/2 flow control vulnerability',
            },
          ]),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.findings[0]?.message).toContain('HTTP/2 flow control vulnerability');
  });

  it('uses "Known vulnerability" when neither Title nor Description available', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          makeTrivyTarget('pom.xml', [
            {
              VulnerabilityID: 'CVE-2024-0000',
              PkgName: 'spring-core',
              InstalledVersion: '5.3.0',
              FixedVersion: '5.3.5',
              Severity: 'LOW',
              Title: undefined,
              Description: undefined,
            },
          ]),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.findings[0]?.message).toContain('Known vulnerability');
  });

  it('returns empty findings when no vulnerabilities found', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          { Target: 'package-lock.json', Type: 'npm', Vulnerabilities: null },
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns empty findings when Results is empty', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('handles missing Results field', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({}),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('parses multiple targets with multiple vulnerabilities', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockResolvedValueOnce({
        stdout: makeTrivyOutput([
          makeTrivyTarget('package-lock.json', [
            {
              VulnerabilityID: 'CVE-1',
              PkgName: 'pkg1',
              InstalledVersion: '1.0',
              Severity: 'HIGH',
              Title: 'V1',
            },
            {
              VulnerabilityID: 'CVE-2',
              PkgName: 'pkg2',
              InstalledVersion: '2.0',
              Severity: 'CRITICAL',
              Title: 'V2',
            },
          ]),
          makeTrivyTarget('go.sum', [
            {
              VulnerabilityID: 'CVE-3',
              PkgName: 'pkg3',
              InstalledVersion: '3.0',
              Severity: 'LOW',
              Title: 'V3',
            },
          ]),
        ]),
        stderr: '',
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
      } as any);

    const result = await runTrivy('/project');

    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]?.file).toBe('package-lock.json');
    expect(result.findings[2]?.file).toBe('go.sum');
  });

  // ── Scan arguments ──

  it('calls trivy with correct arguments', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: makeTrivyOutput([]), stderr: '' } as any);

    await runTrivy('/my/project');

    const scanCall = mockExecFile.mock.calls[1]!;
    expect(scanCall[0]).toBe('trivy');
    expect(scanCall[1]).toEqual([
      'fs',
      '--format',
      'json',
      '--scanners',
      'vuln',
      '--quiet',
      '/my/project',
    ]);
  });

  // ── Error handling ──

  it('returns error status when scan fails', async () => {
    mockExecFile
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce({ stdout: '0.50.0', stderr: '' } as any)
      .mockRejectedValueOnce(new Error('Timeout'));

    const result = await runTrivy('/project');

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('Trivy failed');
    expect(result.error).toContain('Timeout');
  });

  it('includes executionTimeMs in all results', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'));

    const result = await runTrivy('/project');

    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── mapSeverity ────────────────────────────────────────────────

describe('mapSeverity', () => {
  it('maps CRITICAL to critical', () => expect(mapSeverity('CRITICAL')).toBe('critical'));
  it('maps HIGH to high', () => expect(mapSeverity('HIGH')).toBe('high'));
  it('maps MEDIUM to medium', () => expect(mapSeverity('MEDIUM')).toBe('medium'));
  it('maps LOW to low', () => expect(mapSeverity('LOW')).toBe('low'));
  it('maps unknown to info', () => expect(mapSeverity('UNKNOWN')).toBe('info'));
  it('is case-insensitive', () => expect(mapSeverity('critical')).toBe('critical'));
});
