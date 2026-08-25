import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the composition root (token-bearing adapter) and the credential provider;
// discoverCodePaths/discoverSearchTerms (ghagga-core) are used REAL — deterministic
// and already unit-tested.
const mockFetchFileContents = vi.fn();
const mockSearchCode = vi.fn();
const mockGetToken = vi.fn();
const mockMakeGitHubAdapter = vi.fn();

vi.mock('../github/forge-adapter-factory.js', () => ({
  makeGitHubAdapter: (...args: unknown[]) => mockMakeGitHubAdapter(...args),
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
    mockSearchCode.mockReset();
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue('tok-abc');
    // Default: an adapter WITH both capabilities (the common case).
    mockMakeGitHubAdapter.mockReset();
    mockMakeGitHubAdapter.mockReturnValue({
      fetchFileContents: mockFetchFileContents,
      searchCode: mockSearchCode,
    });
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
    // 2 paths discovered → search gate does NOT fire (PATH_DISCOVERY_SUFFICIENT=2).
    const out = await call('The bug is in src/a.ts and also src/b.ts.');

    expect(out).toContain('## RELEVANT SOURCE CODE');
    expect(out).toContain('### src/a.ts');
    expect(out).toContain('// contents of src/a.ts');
    expect(out).toContain('### src/b.ts');
    // ref omitted → default branch (adapter called with only repo + path).
    expect(mockFetchFileContents).toHaveBeenCalledWith(expect.anything(), 'src/a.ts');
    expect(mockSearchCode).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('returns "" WITHOUT minting a token when no paths are discovered and no backtick terms exist', async () => {
    const out = await call('Just a vague complaint, no file mentioned.');
    expect(out).toBe('');
    // No paths AND no search terms → nothing to fetch or search → do NOT mint a
    // throwaway installation token (the search terms are computed before the mint).
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockFetchFileContents).not.toHaveBeenCalled();
  });

  it('DOES mint a token when a backtick term exists even with zero paths (search needs it)', async () => {
    // 0 paths but a backtick-quoted symbol → search fallback fires, which needs a token.
    const out = await call('the `fetchGraph` helper is broken');
    // (adapter.searchCode is stubbed to [] by default here → merged empty → '')
    expect(out).toBe('');
    expect(mockGetToken).toHaveBeenCalled();
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

  // ─── T6: code-search fallback wiring ────────────────────────────

  describe('code-search fallback (triage-search-discovery T6)', () => {
    it('TRIGGERS the search fallback when fewer than 2 paths are discovered', async () => {
      mockFetchFileContents.mockResolvedValue('code');
      mockSearchCode.mockResolvedValue(['src/found.ts']);
      // 1 path discovered ('src/a.ts'), plus a backtick term ('fetchGraph').
      const out = await call('src/a.ts is broken, see `fetchGraph`');
      expect(mockSearchCode).toHaveBeenCalledWith(expect.anything(), 'fetchGraph', 5);
      expect(out).toContain('### src/found.ts');
    });

    it('SKIPS the search fallback when 2 or more paths are discovered', async () => {
      mockFetchFileContents.mockResolvedValue('code');
      const out = await call('src/a.ts and src/b.ts, also see `fetchGraph`');
      expect(mockSearchCode).not.toHaveBeenCalled();
      expect(out).toContain('### src/a.ts');
      expect(out).toContain('### src/b.ts');
    });

    it('CAPABILITY-GATES: an adapter without searchCode never triggers the fallback', async () => {
      mockMakeGitHubAdapter.mockReturnValue({ fetchFileContents: mockFetchFileContents });
      mockFetchFileContents.mockResolvedValue('code');
      const out = await call('see `fetchGraph` but no path mentioned');
      expect(mockSearchCode).not.toHaveBeenCalled();
      // No paths, no search results → nothing to attach.
      expect(out).toBe('');
    });

    it('bounds the number of search calls at MAX_SEARCH_CALLS(3) even with more terms', async () => {
      mockSearchCode.mockResolvedValue([]);
      const text = '`term1` `term2` `term3` `term4` `term5` no path here';
      await call(text);
      expect(mockSearchCode).toHaveBeenCalledTimes(3);
    });

    it('calls searchCode SEQUENTIALLY (term N+1 waits for term N)', async () => {
      const order: string[] = [];
      mockSearchCode.mockImplementation(async (_repo, term: string) => {
        order.push(`start:${term}`);
        await new Promise((r) => setTimeout(r, 1));
        order.push(`end:${term}`);
        return [];
      });
      await call('`termA` `termB` no path here');
      expect(order).toEqual(['start:termA', 'end:termA', 'start:termB', 'end:termB']);
    });

    it('DEGRADES on a searchCode throw: breaks the loop, never propagates, keeps prior results', async () => {
      mockFetchFileContents.mockResolvedValue('code');
      mockSearchCode
        .mockResolvedValueOnce(['src/from-term1.ts'])
        .mockRejectedValueOnce(new Error('rate limited hard'));
      const out = await call('`term1` `term2` `term3` no path here');
      expect(mockSearchCode).toHaveBeenCalledTimes(2); // stopped after the throw
      expect(out).toContain('### src/from-term1.ts');
      expect(log.warn).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringMatching(/code search failed/),
      );
    });

    it('MERGES path-discovery + search results, path-precedence, deduped, capped at 6', async () => {
      mockFetchFileContents.mockResolvedValue('code');
      mockSearchCode.mockResolvedValue(['src/a.ts', 'src/found1.ts', 'src/found2.ts']);
      // 1 path discovered ('src/a.ts') triggers search; search re-finds src/a.ts
      // (dup, must be dropped) plus 2 new paths.
      const out = await call('src/a.ts is broken, see `fetchGraph`');
      const sections = [...out.matchAll(/### (\S+)/g)].map((m) => m[1]);
      expect(sections).toEqual(['src/a.ts', 'src/found1.ts', 'src/found2.ts']);
    });

    it('returns "" when merged (paths + search) is empty', async () => {
      mockSearchCode.mockResolvedValue([]);
      const out = await call('no path, no backtick term here');
      expect(out).toBe('');
      expect(mockFetchFileContents).not.toHaveBeenCalled();
    });

    it('REGRESSION: the path-only flow (≥2 paths, no search) is unaffected by the early-return removal', async () => {
      mockFetchFileContents.mockImplementation((_repo, path: string) =>
        Promise.resolve(`// ${path}`),
      );
      const out = await call('The bug is in src/a.ts and also src/b.ts.');
      expect(mockSearchCode).not.toHaveBeenCalled();
      expect(out).toContain('### src/a.ts');
      expect(out).toContain('### src/b.ts');
    });
  });
});
