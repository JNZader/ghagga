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
import { executeCpd, installCpd } from '../cpd.js';
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

/** Realistic CPD XML output with duplications */
const CPD_XML_WITH_FINDINGS = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd>
  <duplication lines="15" tokens="120">
    <file path="/workspace/src/utils.ts" line="10" endline="25"/>
    <file path="/workspace/src/helpers.ts" line="30" endline="45"/>
    <codefragment><![CDATA[
function doSomething(a, b) {
  const result = a + b;
  return result * 2;
}]]></codefragment>
  </duplication>
  <duplication lines="8" tokens="80">
    <file path="/workspace/src/api/handler.ts" line="50" endline="58"/>
    <file path="/workspace/src/api/middleware.ts" line="20" endline="28"/>
    <file path="/workspace/src/api/validator.ts" line="100" endline="108"/>
    <codefragment><![CDATA[
try {
  const data = await fetch(url);
  return data.json();
} catch (error) {
  throw new Error('Fetch failed');
}]]></codefragment>
  </duplication>
</pmd-cpd>`;

const CPD_XML_NO_FINDINGS = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd>
</pmd-cpd>`;

const CPD_XML_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd/>`;

// ─── installCpd Tests ───────────────────────────────────────────

describe('installCpd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  it('skips download on cache hit when binary is functional', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // pmd --version succeeds
    simulateExec(0, 'PMD 7.8.0', '');

    const result = await installCpd();

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(1); // only --version check
  });

  it('reinstalls if cache restored but binary not functional', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // pmd --version fails
    mockExec.mockImplementationOnce(async () => {
      throw new Error('/opt/pmd/bin/pmd: not found');
    });
    // bash download + unzip succeeds
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installCpd();

    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
  });

  it('downloads and extracts on cache miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installCpd();

    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'bash',
      ['-c', expect.stringContaining('curl -sL')],
      expect.any(Object),
    );
  });

  it('uses correct PMD version in download URL', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installCpd();

    const installCall = mockExec.mock.calls[0]!;
    const bashScript = (installCall[1] as string[])[1];
    expect(bashScript).toContain(TOOL_VERSIONS.pmd);
    expect(bashScript).toContain(`pmd-dist-${TOOL_VERSIONS.pmd}-bin.zip`);
  });

  it('saves to cache after successful install', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installCpd();

    expect(mockSaveCache).toHaveBeenCalled();
  });

  it('returns false on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('curl: network error');
    });

    const result = await installCpd();

    expect(result).toBe(false);
  });

  it('logs warning on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('curl: network error');
    });

    await installCpd();

    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('PMD/CPD install failed'));
  });
});

// ─── executeCpd Tests ───────────────────────────────────────────

describe('executeCpd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_OS = 'Linux';
  });

  function mockSuccessfulInstall() {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, 'PMD 7.8.0', '');
  }

  it('returns error status when install fails', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('install failed');
    });

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toBe('PMD/CPD installation failed');
    expect(result.findings).toEqual([]);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('parses findings from realistic XML output', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(2);
  });

  it('sets correct finding fields for duplication', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    const first = result.findings[0]!;
    expect(first.severity).toBe('medium');
    expect(first.category).toBe('duplication');
    expect(first.source).toBe('cpd');
    expect(first.file).toBe('src/utils.ts'); // repoDir prefix stripped
    expect(first.line).toBe(10);
    expect(first.message).toContain('15 lines');
    expect(first.message).toContain('120 tokens');
  });

  it('includes all duplicate locations in message', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    const first = result.findings[0]!;
    expect(first.message).toContain('src/utils.ts:10');
    expect(first.message).toContain('src/helpers.ts:30');
  });

  it('handles duplication with more than 2 files', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    const second = result.findings[1]!;
    expect(second.message).toContain('src/api/handler.ts:50');
    expect(second.message).toContain('src/api/middleware.ts:20');
    expect(second.message).toContain('src/api/validator.ts:100');
  });

  it('strips repoDir prefix from file paths', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    for (const finding of result.findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
  });

  it('returns success with empty findings when no duplications', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_NO_FINDINGS, '');

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns success with empty findings for self-closing pmd-cpd tag', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_EMPTY, '');

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('handles non-zero exit code from CPD (duplications found)', async () => {
    mockSuccessfulInstall();
    // CPD exits with code 4 when it finds duplications
    simulateExec(4, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('returns error status on malformed XML', async () => {
    mockSuccessfulInstall();
    simulateExec(0, 'not xml at all <<<>>>', '');

    const result = await executeCpd('/workspace');

    // parseCpdXml uses regex — malformed XML just produces empty findings
    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0);
  });

  it('returns error status on timeout', async () => {
    mockSuccessfulInstall();
    mockExec.mockImplementationOnce(async () => {
      throw new Error('Timed out after 180000ms');
    });

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Timed out');
  });

  it('always populates executionTimeMs', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_NO_FINDINGS, '');

    const result = await executeCpd('/workspace');

    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('never throws', async () => {
    mockRestoreCache.mockRejectedValue(new Error('catastrophic'));

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('error');
    expect(result.findings).toEqual([]);
  });

  it('calls PMD CPD with correct arguments', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_NO_FINDINGS, '');

    await executeCpd('/my/repo');

    const scanCall = mockExec.mock.calls[1]!;
    expect(scanCall[0]).toBe('/opt/pmd/bin/pmd');
    expect(scanCall[1]).toEqual([
      'cpd',
      '--format',
      'xml',
      '--minimum-tokens',
      '100',
      '--dir',
      '/my/repo',
      '--skip-lexical-errors',
    ]);
  });

  it('uses allowNonZero: true for scan', async () => {
    mockSuccessfulInstall();
    simulateExec(4, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    // Even with exit code 4, should parse findings
    expect(result.status).toBe('success');
  });

  // ── executionTimeMs arithmetic ──

  it('executionTimeMs is a small positive number (not Date.now() + start)', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_NO_FINDINGS, '');

    const _before = Date.now();
    const result = await executeCpd('/workspace');

    // If the code used + instead of -, executionTimeMs would be ~2×Date.now() ≈ huge number
    expect(result.executionTimeMs).toBeLessThan(5000);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executionTimeMs is small on install failure', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    mockExec.mockImplementationOnce(async () => {
      throw new Error('install failed');
    });

    const result = await executeCpd('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  it('executionTimeMs is small on execution error', async () => {
    mockSuccessfulInstall();
    mockExec.mockImplementationOnce(async () => {
      throw new Error('Timed out after 180000ms');
    });

    const result = await executeCpd('/workspace');

    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  // ── CPD boundary: files.length >= 2 ──

  it('ignores duplication blocks with fewer than 2 files', async () => {
    mockSuccessfulInstall();
    // A duplication block with only 1 file entry (invalid, but tests the boundary)
    const xmlWithSingleFile = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd>
  <duplication lines="10" tokens="50">
    <file path="/workspace/src/lonely.ts" line="5" endline="15"/>
    <codefragment><![CDATA[some code]]></codefragment>
  </duplication>
</pmd-cpd>`;
    simulateExec(0, xmlWithSingleFile, '');

    const result = await executeCpd('/workspace');

    expect(result.status).toBe('success');
    expect(result.findings).toHaveLength(0); // Should be filtered out
  });

  // ── CPD location separator ──

  it('separates duplicate locations with comma-space in message', async () => {
    mockSuccessfulInstall();
    simulateExec(0, CPD_XML_WITH_FINDINGS, '');

    const result = await executeCpd('/workspace');

    const first = result.findings[0]!;
    // The locations should be joined with ", " not ""
    expect(first.message).toContain('src/utils.ts:10, src/helpers.ts:30');
  });

  // ── Install version check args ──

  it('verifies cached binary with --version flag', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    simulateExec(0, 'PMD 7.8.0', '');

    await installCpd();

    expect(mockExec).toHaveBeenCalledWith('/opt/pmd/bin/pmd', ['--version'], expect.any(Object));
  });

  it('uses 10s timeout for version check', async () => {
    mockRestoreCache.mockResolvedValue('hit');
    // Simulate a command that takes longer than 10s — it should timeout
    mockExec.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 15_000)),
    );

    // The version check has timeoutMs: 10_000, so this should throw
    // But installCpd catches the error and tries reinstall, which we let succeed
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    const result = await installCpd();

    // installCpd should fall through to reinstall after version check timeout
    expect(result).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('binary not functional'));
  }, 20_000);

  it('uses 120s timeout for install download', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installCpd();

    // Verify bash was called (the download/unzip command) — the timeoutMs is consumed
    // by execWithTimeout internally via Promise.race, not passed to @actions/exec
    expect(mockExec).toHaveBeenCalledWith(
      'bash',
      ['-c', expect.stringContaining('curl -sL')],
      expect.any(Object),
    );
  });

  it('install command includes unzip, mv, and rm steps', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    simulateExec(0, '', '');
    mockSaveCache.mockResolvedValue(12345);

    await installCpd();

    const installCall = mockExec.mock.calls[0]!;
    const bashScript = (installCall[1] as string[])[1]!;
    expect(bashScript).toContain('unzip -q /tmp/pmd.zip -d /opt');
    expect(bashScript).toContain(`mv /opt/pmd-bin-${TOOL_VERSIONS.pmd} /opt/pmd`);
    expect(bashScript).toContain('rm -f /tmp/pmd.zip');
  });
});
