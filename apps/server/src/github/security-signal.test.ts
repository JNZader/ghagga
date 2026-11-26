import { gunzipSync } from 'node:zlib';
import type { ReviewFinding } from 'ghagga-core';
import { describe, expect, it, vi } from 'vitest';
import { publishSecuritySignal, type SecuritySignalClient } from './security-signal.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'critical',
    category: 'security',
    file: 'src/a.ts',
    line: 4,
    message: 'SQL injection',
    source: 'ai',
    ...overrides,
  };
}

function client(overrides: Partial<SecuritySignalClient> = {}): SecuritySignalClient {
  return {
    listCheckRunsByName: vi.fn().mockResolvedValue([]),
    createCheckRun: vi.fn().mockResolvedValue({ id: 9 }),
    updateCheckRun: vi.fn().mockResolvedValue(undefined),
    uploadSarif: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const base = {
  owner: 'octo',
  repo: 'demo',
  token: 'tok',
  headSha: 'abc1234',
  prNumber: 7,
  status: 'FAILED',
  threshold: undefined,
};

describe('publishSecuritySignal', () => {
  it('creates a failing check and uploads SARIF while a critical finding is present', async () => {
    const github = client();
    await publishSecuritySignal({ ...base, client: github, findings: [finding()] });

    expect(github.createCheckRun).toHaveBeenCalledWith(
      'octo',
      'demo',
      expect.objectContaining({
        name: 'ghagga/security',
        conclusion: 'failure',
        headSha: 'abc1234',
      }),
      'tok',
    );
    expect(github.updateCheckRun).not.toHaveBeenCalled();
    const payload = vi.mocked(github.uploadSarif!).mock.calls[0]?.[2];
    expect(payload?.ref).toBe('refs/pull/7/head');
    const sarif = JSON.parse(
      gunzipSync(Buffer.from(payload?.sarif ?? '', 'base64')).toString('utf8'),
    );
    expect(sarif.runs[0].results).toHaveLength(1);
  });

  it('updates the existing check to success when the finding is gone', async () => {
    const github = client({
      listCheckRunsByName: vi.fn().mockResolvedValue([{ id: 4 }, { id: 11 }]),
    });
    await publishSecuritySignal({ ...base, client: github, findings: [], status: 'PASSED' });

    expect(github.updateCheckRun).toHaveBeenCalledWith(
      'octo',
      'demo',
      11,
      expect.objectContaining({ conclusion: 'success' }),
      'tok',
    );
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('keeps the failing check when the finding is still there on a later review', async () => {
    const github = client({
      listCheckRunsByName: vi.fn().mockResolvedValue([{ id: 11 }]),
    });
    await publishSecuritySignal({ ...base, client: github, findings: [finding()] });
    expect(github.updateCheckRun).toHaveBeenCalledWith(
      'octo',
      'demo',
      11,
      expect.objectContaining({ conclusion: 'failure' }),
      'tok',
    );
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('does not touch the check when the review was skipped', async () => {
    const github = client();
    await publishSecuritySignal({ ...base, client: github, findings: [], status: 'SKIPPED' });
    expect(github.listCheckRunsByName).not.toHaveBeenCalled();
    expect(github.uploadSarif).not.toHaveBeenCalled();
  });

  it('reports a SARIF failure without throwing', async () => {
    const onSarifError = vi.fn();
    const github = client({
      uploadSarif: vi.fn().mockRejectedValue(new Error('403')),
    });
    await expect(
      publishSecuritySignal({
        ...base,
        client: github,
        findings: [finding()],
        onSarifError,
      }),
    ).resolves.toBeUndefined();
    expect(github.createCheckRun).toHaveBeenCalledOnce();
    expect(onSarifError).toHaveBeenCalledOnce();
  });
});
