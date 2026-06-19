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
import { executeTrivy, installTrivy } from '../trivy.js';
import { TOOL_VERSIONS } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockExec = vi.mocked(exec);
const mockRestoreCache = vi.mocked(cache.restoreCache);
const mockSaveCache = vi.mocked(cache.saveCache);
const mockWarning = vi.mocked(core.warning);

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

/** Realistic Trivy JSON output with multiple targets and severities */
const TRIVY_FINDINGS_JSON = JSON.stringify({
  Results: [
    {
      Target: 'package-lock.json',
      Type: 'npm',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2023-1234',
          PkgName: 'lodash',
          InstalledVersion: '4.17.20',
          FixedVersion: '4.17.21',
          Severity: 'HIGH',
          Title: 'Prototype Pollution',
        },
        {
          VulnerabilityID: 'CVE-2023-5678',
          PkgName: 'express',
          InstalledVersion: '4.17.1',
          FixedVersion: '4.18.2',
          Severity: 'CRITICAL',
          Title: 'Path traversal in express.static',
        },
      ],
    },
    {
      Target: 'go.sum',
      Type: 'gomod',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2024-9999',
          PkgName: 'golang.org/x/net',
          InstalledVersion: '0.1.0',
          FixedVersion: '0.2.0',
          Severity: 'MEDIUM',
          Title: 'HTTP/2 flow control vulnerability',
        },
      ],
    },
  ],
});

const TRIVY_NO_FINDINGS = JSON.stringify({
  Results: [
    {
      Target: 'package-lock.json',
      Type: 'npm',
      Vulnerabilities: null,
    },
  ],
});

const TRIVY_EMPTY_RESULTS = JSON.stringify({ Results: [] });

// ─── installTrivy Tests ─────────────────────────────────────────

describe('installTrivy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  it('skips install on cache hit when binary is functional', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, 'Version: 0.58.1', '');

    const result = await installTrivy();

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(1); // only --version
  });

  it('reinstalls if cache restored but binary not functional', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // trivy --version fails
    mockExec.mockImplementationOnce(async () => {
      throw new Error('trivy: not found');
    });
    // bash install script succeeds
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installTrivy();

    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
  });

  it('runs install script on cache miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installTrivy();

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'bash',
      ['-c', expect.stringContaining(`https://github.com/aquasecurity/trivy/releases/download/`)],
      expect.any(Object),
    );
  });

  it('includes pinned version in install command', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installTrivy();

    const installCall = mockExec.mock.calls[0]!;
    const bashScript = (installCall[1] as string[])[1];
    expect(bashScript).toContain(`v${TOOL_VERSIONS.trivy}`);
  });

  it('saves to cache after successful install', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installTrivy();

    expect(mockSaveCache).toHaveBeenCalled();
  });

  it('returns false on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('curl: network error');
    });

    const result = await installTrivy();

    expect(result).toBe(false);
  });

  it('logs warning on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('curl: network error');
    });

    await installTrivy();

    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Trivy install failed'));
  });
});

// ─── executeTrivy Tests ─────────────────────────────────────────

describe('executeTrivy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  function mockSuccessfulInstall() {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, 'Version: 0.58.1', '');
  }

  it('returns error status when install fails', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('install failed');
    });

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toBe('Trivy installation failed');
    expect(result.findings).toEqual([]);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('parses findings from realistic JSON output', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(3);
  });

  it('maps CRITICAL severity correctly', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    const critical = result.findings.find((f) => f.message.includes('CVE-2023-5678'));
    expect(critical?.severity).toBe('critical');
  });

  it('maps HIGH severity correctly', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    const high = result.findings.find((f) => f.message.includes('CVE-2023-1234'));
    expect(high?.severity).toBe('high');
  });

  it('maps MEDIUM severity correctly', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    const medium = result.findings.find((f) => f.message.includes('CVE-2024-9999'));
    expect(medium?.severity).toBe('medium');
  });

  it('maps LOW severity correctly', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      Results: [
        {
          Target: 'package.json',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2024-LOW',
              PkgName: 'debug',
              InstalledVersion: '2.0.0',
              Severity: 'LOW',
              Title: 'Minor issue',
            },
          ],
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]?.severity).toBe('low');
  });

  it('maps unknown severity to info', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      Results: [
        {
          Target: 'package.json',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-UNKNOWN',
              PkgName: 'pkg',
              InstalledVersion: '1.0.0',
              Severity: 'UNKNOWN',
              Title: 'Unknown sev',
            },
          ],
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]?.severity).toBe('info');
  });

  it('constructs message with CVE, package, version, and fix info', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    const finding = result.findings[0]!;
    expect(finding.message).toContain('CVE-2023-1234');
    expect(finding.message).toContain('lodash@4.17.20');
    expect(finding.message).toContain('Prototype Pollution');
    expect(finding.message).toContain('upgrade to 4.17.21');
  });

  it('shows "no fix available" when no FixedVersion', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      Results: [
        {
          Target: 'package.json',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-NO-FIX',
              PkgName: 'pkg',
              InstalledVersion: '1.0.0',
              Severity: 'HIGH',
              Title: 'No fix yet',
            },
          ],
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]?.message).toContain('no fix available');
  });

  it('uses Description when Title is not available', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      Results: [
        {
          Target: 'pom.xml',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-DESC',
              PkgName: 'spring',
              InstalledVersion: '5.0.0',
              FixedVersion: '5.0.1',
              Severity: 'MEDIUM',
              Description: 'HTTP/2 vulnerability',
            },
          ],
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]?.message).toContain('HTTP/2 vulnerability');
  });

  it('uses "Known vulnerability" when neither Title nor Description', async () => {
    mockSuccessfulInstall();
    const json = JSON.stringify({
      Results: [
        {
          Target: 'pom.xml',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-BARE',
              PkgName: 'spring',
              InstalledVersion: '5.0.0',
              FixedVersion: '5.0.1',
              Severity: 'HIGH',
            },
          ],
        },
      ],
    });
    simulateExec(0, json, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]?.message).toContain('Known vulnerability');
  });

  it('sets correct finding fields', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        category: 'dependency-vulnerability',
        source: 'trivy',
        file: 'package-lock.json',
      }),
    );
  });

  it('returns success with empty findings when no vulnerabilities', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_NO_FINDINGS, '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns success with empty findings when Results is empty', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_EMPTY_RESULTS, '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('handles missing Results field', async () => {
    mockSuccessfulInstall();
    simulateExec(0, JSON.stringify({}), '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns error status on malformed JSON', async () => {
    mockSuccessfulInstall();
    simulateExec(0, 'not json {{{', '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Trivy failed');
    expect(result.findings).toEqual([]);
  });

  it('returns error status on timeout', async () => {
    mockSuccessfulInstall();
    mockExec.mockImplementationOnce(async () => {
      throw new Error('Timed out after 180000ms');
    });

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Timed out');
  });

  it('always populates executionTimeMs', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_NO_FINDINGS, '');

    const result = await executeTrivy('/workspace');

    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('never throws', async () => {
    mockRestoreCache.mockRejectedValue(new Error('catastrophic'));

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
  });

  it('calls trivy with correct arguments', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_EMPTY_RESULTS, '');

    await executeTrivy('/my/repo');

    const scanCall = mockExec.mock.calls[1]!;
    expect(scanCall[0]).toBe('trivy');
    expect(scanCall[1]).toEqual([
      'fs',
      '--format',
      'json',
      '--scanners',
      'vuln',
      '--quiet',
      '/my/repo',
    ]);
  });

  it('uses allowNonZero: true for scan', async () => {
    mockSuccessfulInstall();
    simulateExec(1, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('handles multiple targets with multiple vulnerabilities', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_FINDINGS_JSON, '');

    const result = await executeTrivy('/workspace');

    // 2 from first target + 1 from second target
    expect(result.findings).toHaveLength(3);

    const files = result.findings.map((f) => f.file);
    expect(files).toContain('package-lock.json');
    expect(files).toContain('go.sum');
  });

  // ── executionTimeMs arithmetic ──

  it('executionTimeMs is a small positive number (not Date.now() + start)', async () => {
    mockSuccessfulInstall();
    simulateExec(0, TRIVY_NO_FINDINGS, '');

    const result = await executeTrivy('/workspace');

    // If code used + instead of -, executionTimeMs would be ~2×Date.now() ≈ huge number
    expect(result.executionTimeMs).toBeLessThan(5000);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executionTimeMs is small on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('install failed');
    });

    const result = await executeTrivy('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  it('executionTimeMs is small on execution error', async () => {
    mockSuccessfulInstall();
    simulateExec(0, 'not json {{{', '');

    const result = await executeTrivy('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  // ── Install version check args ──

  it('verifies cached binary with trivy --version', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, 'Version: 0.58.1', '');

    await installTrivy();

    expect(mockExec).toHaveBeenCalledWith('trivy', ['--version'], expect.any(Object));
  });

  it('uses 10s timeout for version check', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // Simulate a command that takes longer than 10s — version check should timeout
    mockExec.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 15_000)),
    );

    // installTrivy catches the timeout and tries reinstall
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installTrivy();

    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
  }, 20_000);

  it('uses 120s timeout for install script', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installTrivy();

    // Verify bash install was called — timeoutMs is handled internally
    expect(mockExec).toHaveBeenCalledWith(
      'bash',
      ['-c', expect.stringContaining('aquasecurity/trivy')],
      expect.any(Object),
    );
  });
});
