/**
 * Login command tests.
 *
 * Tests the GitHub Device Flow login orchestration:
 * already-logged-in shortcut, happy path, spinner lifecycle,
 * browser auto-open, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../lib/oauth.js', () => ({
  requestDeviceCode: vi.fn(),
  pollForAccessToken: vi.fn(),
  fetchGitHubUser: vi.fn(),
}));

const mockSpinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };

vi.mock('../ui/tui.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  spinner: vi.fn(() => mockSpinner),
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('node:os', () => ({
  platform: vi.fn().mockReturnValue('linux'),
}));

import { loadConfig, saveConfig } from '../lib/config.js';
import { fetchGitHubUser, pollForAccessToken, requestDeviceCode } from '../lib/oauth.js';
import * as tui from '../ui/tui.js';
import { loginCommand } from './login.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockRequestDeviceCode = vi.mocked(requestDeviceCode);
const mockPollForAccessToken = vi.mocked(pollForAccessToken);
const mockFetchGitHubUser = vi.mocked(fetchGitHubUser);

// ─── Setup ─────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock spy type
let mockExit: any;

beforeEach(() => {
  vi.clearAllMocks();
  mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
});

afterEach(() => {
  mockExit.mockRestore();
});

// ─── Helpers ───────────────────────────────────────────────────

function setupHappyPath() {
  mockLoadConfig.mockReturnValue({});
  mockRequestDeviceCode.mockResolvedValue({
    device_code: 'dc_123',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  });
  mockPollForAccessToken.mockResolvedValue({
    access_token: 'gho_newtoken',
    token_type: 'bearer',
    scope: '',
  });
  mockFetchGitHubUser.mockResolvedValue({
    login: 'newuser',
    id: 42,
    avatar_url: 'https://github.com/newuser.png',
  });
}

// ─── Tests ─────────────────────────────────────────────────────

describe('loginCommand', () => {
  it('shows "already logged in" when token and login exist', async () => {
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_existing',
      githubLogin: 'existinguser',
    });

    await loginCommand();

    expect(tui.log.info).toHaveBeenCalledWith(
      expect.stringContaining('Already logged in as existinguser'),
    );
    expect(mockRequestDeviceCode).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('completes full device flow and saves config on success', async () => {
    setupHappyPath();

    await loginCommand();

    // Verify device code was requested
    expect(mockRequestDeviceCode).toHaveBeenCalledOnce();

    // Verify user code was displayed
    expect(tui.log.message).toHaveBeenCalledWith(expect.stringContaining('ABCD-1234'));

    // Verify poll was called with device code params
    expect(mockPollForAccessToken).toHaveBeenCalledWith('dc_123', 5, 900);

    // Verify user was fetched with the new token
    expect(mockFetchGitHubUser).toHaveBeenCalledWith('gho_newtoken');

    // Verify config was saved with correct data
    // (gateway/auto — 'github' is a legacy provider the CLI no longer accepts)
    expect(mockSaveConfig).toHaveBeenCalledWith({
      githubToken: 'gho_newtoken',
      githubLogin: 'newuser',
      defaultProvider: 'gateway',
      defaultModel: 'auto',
    });

    // Verify success message
    expect(tui.log.success).toHaveBeenCalledWith(expect.stringContaining('newuser'));
  });

  it('manages spinner lifecycle: start → stop', async () => {
    setupHappyPath();

    await loginCommand();

    expect(tui.spinner).toHaveBeenCalledOnce();
    expect(mockSpinner.start).toHaveBeenCalledWith('Waiting for authorization...');
    expect(mockSpinner.stop).toHaveBeenCalledWith('Authorization received');

    // start must be called before stop
    const startOrder = mockSpinner.start.mock.invocationCallOrder[0]!;
    const stopOrder = mockSpinner.stop.mock.invocationCallOrder[0]!;
    expect(startOrder).toBeLessThan(stopOrder);
  });

  it('shows browser-opened message when tryOpenBrowser succeeds', async () => {
    setupHappyPath();

    await loginCommand();

    // tryOpenBrowser uses dynamic import of node:child_process
    // When exec doesn't throw, the browser is considered "opened"
    expect(tui.log.info).toHaveBeenCalledWith(
      expect.stringContaining('Browser opened automatically'),
    );
  });

  it('calls tui.log.error and process.exit(1) on failure', async () => {
    mockLoadConfig.mockReturnValue({});
    mockRequestDeviceCode.mockRejectedValue(new Error('Network error'));

    await loginCommand();

    expect(tui.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Login failed: Network error'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
