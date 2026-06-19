import { describe, expect, it, vi } from 'vitest';
import type { ForgeCredentialProvider } from '../../ports/credential-provider.js';
import { TemporaryGitHubTokenSource } from './temporary-github-token-source.js';

describe('TemporaryGitHubTokenSource (task 1.3)', () => {
  it('implements the ForgeCredentialProvider port', () => {
    const provider: ForgeCredentialProvider = new TemporaryGitHubTokenSource({
      mint: vi.fn().mockResolvedValue('t'),
      installationId: 1,
      appId: 'app',
      privateKey: 'pk',
    });
    expect(typeof provider.getToken).toBe('function');
  });

  it('getToken mints a fresh token via the injected mint fn', async () => {
    const mint = vi.fn().mockResolvedValue('minted-token');
    const source = new TemporaryGitHubTokenSource({
      mint,
      installationId: 99,
      appId: 'app-id',
      privateKey: 'PEM',
    });
    await expect(source.getToken()).resolves.toBe('minted-token');
    // No repositoryIds → options undefined (matches client.getInstallationToken default).
    expect(mint).toHaveBeenCalledWith(99, 'app-id', 'PEM', undefined);
  });

  it('passes repositoryIds scoping when provided', async () => {
    const mint = vi.fn().mockResolvedValue('scoped');
    const source = new TemporaryGitHubTokenSource({
      mint,
      installationId: 99,
      appId: 'app-id',
      privateKey: 'PEM',
      repositoryIds: [1, 2],
    });
    await source.getToken();
    expect(mint).toHaveBeenCalledWith(99, 'app-id', 'PEM', { repositoryIds: [1, 2] });
  });

  it('mints a NEW token on every call (no caching in P1)', async () => {
    const mint = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const source = new TemporaryGitHubTokenSource({
      mint,
      installationId: 1,
      appId: 'app',
      privateKey: 'pk',
    });
    await expect(source.getToken()).resolves.toBe('a');
    await expect(source.getToken()).resolves.toBe('b');
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
