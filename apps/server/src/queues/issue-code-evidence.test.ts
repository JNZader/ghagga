import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the composition root (token-bearing adapter) and the credential provider;
// discoverCodePaths (ghagga-core) is used REAL — it is deterministic and tested.
const mockFetchFileContents = vi.fn();
const mockGetToken = vi.fn();

vi.mock('../github/forge-adapter-factory.js', () => ({
  makeGitHubAdapter: vi.fn(() => ({ fetchFileContents: mockFetchFileContents })),
}));
vi.mock('ghagga-forge', () => ({
  // A class (not an arrow) so `new GitHubAppCredentialProvider(...)` is valid.
  GitHubAppCredentialProvider: class {
    getToken() {
      return mockGetToken();
    }
  },
}));

import { collectIssueCodeEvidence } from './issue-code-evidence.js';

const log = { warn: vi.fn(), info: vi.fn() };

describe('collectIssueCodeEvidence', () => {
  beforeEach(() => {
    // Reset ONLY the leaf mocks (not the makeGitHubAdapter factory mock, whose
    // implementation must persist). mockReset clears leaked implementations.
    mockFetchFileContents.mockReset();
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue('tok-abc');
    log.warn.mockClear();
    log.info.mockClear();
    process.env.GITHUB_APP_ID = 'app-1';
    process.env.GITHUB_PRIVATE_KEY = 'key-1';
  });
  afterEach(() => {
    // `= undefined` sets the STRING "undefined" (truthy) — must delete to unset.
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
  });

  const call = (issueText: string) =>
    collectIssueCodeEvidence({ installationId: 1, repoFullName: 'octo/demo', issueText, log });

  it('fetches referenced files (default branch) and formats a fenced block', async () => {
    mockFetchFileContents.mockImplementation((_repo, path: string) =>
      Promise.resolve(`// contents of ${path}`),
    );
    const out = await call('The bug is in src/a.ts and also src/b.ts.');

    expect(out).toContain('## RELEVANT SOURCE CODE');
    expect(out).toContain('### src/a.ts');
    expect(out).toContain('// contents of src/a.ts');
    expect(out).toContain('### src/b.ts');
    // ref omitted → default branch (adapter called with only repo + path).
    expect(mockFetchFileContents).toHaveBeenCalledWith(expect.anything(), 'src/a.ts');
    expect(log.info).toHaveBeenCalled();
  });

  it('returns "" and does NOT mint a token when no paths are discovered', async () => {
    const out = await call('Just a vague complaint, no file mentioned.');
    expect(out).toBe('');
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockFetchFileContents).not.toHaveBeenCalled();
  });

  it('degrades to "" (text-only) when GitHub App credentials are missing', async () => {
    delete process.env.GITHUB_APP_ID;
    const out = await call('see src/a.ts');
    expect(out).toBe('');
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/credentials missing/),
    );
  });

  it('degrades to "" when the token mint fails', async () => {
    mockGetToken.mockRejectedValue(new Error('mint boom'));
    const out = await call('see src/a.ts');
    expect(out).toBe('');
    expect(mockFetchFileContents).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/mint failed/));
  });

  it('skips a file that is missing (null) and keeps the ones that resolve', async () => {
    mockFetchFileContents.mockImplementation((_repo, path: string) =>
      Promise.resolve(path === 'src/a.ts' ? 'real code' : null),
    );
    const out = await call('src/a.ts and src/b.ts');
    expect(out).toContain('### src/a.ts');
    expect(out).not.toContain('### src/b.ts');
  });

  it('skips a per-file fetch fault but keeps the others (never fatal)', async () => {
    mockFetchFileContents.mockImplementation((_repo, path: string) => {
      if (path === 'src/a.ts') return Promise.reject(new Error('403'));
      return Promise.resolve('ok code');
    });
    const out = await call('src/a.ts and src/b.ts');
    expect(out).toContain('### src/b.ts');
    expect(out).not.toContain('### src/a.ts');
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/fetch failed/),
    );
  });

  it('returns "" with a loud warn when paths were discovered but none attached', async () => {
    mockFetchFileContents.mockResolvedValue(null);
    const out = await call('src/a.ts src/b.ts');
    expect(out).toBe('');
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/discovered paths but attached none/),
    );
  });

  it('truncates an oversized file snippet', async () => {
    mockFetchFileContents.mockResolvedValue('x'.repeat(10_000));
    const out = await call('src/a.ts');
    expect(out).toContain('… (truncated)');
  });

  it('drops files over the total char budget and reports it (never over-reports)', async () => {
    // Each ~3000-char file; the 10_000 budget fits ~3 of 6 → the rest are dropped.
    mockFetchFileContents.mockResolvedValue('y'.repeat(3000));
    const out = await call('src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts');
    // The block never exceeds the budget (+ a small header/framing allowance).
    expect(out.length).toBeLessThan(11_000);
    const info = log.info.mock.calls.at(-1)?.[0] as
      | { discovered: number; attached: number; droppedForBudget: number }
      | undefined;
    expect(info).toBeDefined();
    expect(info?.discovered).toBe(6);
    expect(info?.attached).toBeLessThan(6);
    expect(info?.droppedForBudget).toBeGreaterThan(0);
  });
});
