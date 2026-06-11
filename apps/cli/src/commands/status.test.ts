/**
 * Status command tests.
 *
 * Tests the status display: not-logged-in, valid session,
 * expired session, and default provider/model fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn(),
  getConfigFilePath: vi.fn(),
  isLoggedIn: vi.fn(),
}));

vi.mock('../lib/oauth.js', () => ({
  fetchGitHubUser: vi.fn(),
}));

vi.mock('../ui/tui.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
}));

import { getConfigFilePath, isLoggedIn, loadConfig } from '../lib/config.js';
import { fetchGitHubUser } from '../lib/oauth.js';
import * as tui from '../ui/tui.js';
import { statusCommand } from './status.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockGetConfigFilePath = vi.mocked(getConfigFilePath);
const mockIsLoggedIn = vi.mocked(isLoggedIn);
const mockFetchGitHubUser = vi.mocked(fetchGitHubUser);

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigFilePath.mockReturnValue('/mock-home/.config/ghagga/config.json');
});

// ─── Tests ─────────────────────────────────────────────────────

describe('statusCommand', () => {
  it('shows config path and "not logged in" when no credentials exist', async () => {
    mockLoadConfig.mockReturnValue({});
    mockIsLoggedIn.mockReturnValue(false);

    await statusCommand();

    expect(tui.intro).toHaveBeenCalledWith(expect.stringContaining('GHAGGA Status'));
    expect(tui.log.message).toHaveBeenCalledWith(
      expect.stringContaining('/mock-home/.config/ghagga/config.json'),
    );
    expect(tui.log.info).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
    expect(tui.log.info).toHaveBeenCalledWith(expect.stringContaining('ghagga login'));
    expect(tui.outro).not.toHaveBeenCalled();
  });

  it('shows full status with valid session', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_valid',
      githubLogin: 'validuser',
      defaultProvider: 'ollama',
      defaultModel: 'mistral',
    });
    mockFetchGitHubUser.mockResolvedValue({
      login: 'validuser',
      id: 1,
      avatar_url: 'https://github.com/validuser.png',
    });

    await statusCommand();

    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('Logged in as validuser'));
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('ollama'));
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('mistral'));
    expect(tui.log.success).toHaveBeenCalledWith(expect.stringContaining('Valid (validuser)'));
    expect(tui.outro).toHaveBeenCalledWith('Done');
  });

  it('shows "expired or invalid" when token validation fails', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_expired',
      githubLogin: 'expireduser',
      defaultProvider: 'gateway',
      defaultModel: 'auto',
    });
    mockFetchGitHubUser.mockRejectedValue(new Error('401 Unauthorized'));

    await statusCommand();

    expect(tui.log.warn).toHaveBeenCalledWith(expect.stringContaining('Expired or invalid'));
    expect(tui.log.info).toHaveBeenCalledWith(expect.stringContaining('ghagga login'));
    expect(tui.outro).not.toHaveBeenCalled();
  });

  it('shows gateway/auto defaults when provider and model are not set', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_tok',
      githubLogin: 'user',
    });
    mockFetchGitHubUser.mockResolvedValue({
      login: 'user',
      id: 2,
      avatar_url: '',
    });

    await statusCommand();

    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('gateway'));
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringMatching(/Model:\s+auto/));
    expect(tui.outro).toHaveBeenCalledWith('Done');
  });

  it('remaps a legacy stored provider for display with a migration hint', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_tok',
      githubLogin: 'legacyuser',
      defaultProvider: 'github',
      defaultModel: 'gpt-4o-mini',
    });
    mockFetchGitHubUser.mockResolvedValue({
      login: 'legacyuser',
      id: 3,
      avatar_url: '',
    });

    await statusCommand();

    // Shows the value review/audit will actually use, with a hint
    expect(tui.log.message).toHaveBeenCalledWith(
      expect.stringContaining("gateway (migrated from 'github'"),
    );
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('ghagga login'));
    // Stored model belongs to the legacy provider — gateway default shown instead
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringMatching(/Model:\s+auto/));
    expect(tui.log.message).not.toHaveBeenCalledWith(expect.stringContaining('gpt-4o-mini'));
    expect(tui.outro).toHaveBeenCalledWith('Done');
  });
});
