/**
 * Tests for CLI configuration management.
 *
 * Mocks node:fs and node:os to isolate file system operations.
 * Validates loadConfig, saveConfig, clearConfig, isLoggedIn,
 * getStoredToken, and getConfigFilePath.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/mock-home'),
}));

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  clearConfig,
  getConfigFilePath,
  getStoredToken,
  isLoggedIn,
  loadConfig,
  saveConfig,
} from './config.js';

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockHomedir = vi.mocked(homedir);

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue('/mock-home');
  // Clear XDG override so getConfigDir uses homedir()
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
});

// ─── loadConfig ────────────────────────────────────────────────

describe('loadConfig', () => {
  it('should return empty object when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const config = loadConfig();

    expect(config).toEqual({});
    expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('config.json'));
  });

  it('should parse and return valid JSON config', () => {
    const stored = { githubToken: 'gho_abc123', githubLogin: 'testuser' };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(stored));

    const config = loadConfig();

    expect(config).toEqual(stored);
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('config.json'), 'utf-8');
  });

  it('should return empty object when file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ broken json!!!');

    const config = loadConfig();

    expect(config).toEqual({});
  });

  it('should return empty object when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const config = loadConfig();

    expect(config).toEqual({});
  });

  it('should use XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    mockExistsSync.mockReturnValue(false);

    loadConfig();

    expect(mockExistsSync).toHaveBeenCalledWith(
      expect.stringContaining('/custom/config/ghagga/config.json'),
    );
  });

  it('should use homedir/.config when XDG_CONFIG_HOME is not set', () => {
    mockExistsSync.mockReturnValue(false);

    loadConfig();

    expect(mockExistsSync).toHaveBeenCalledWith(
      expect.stringContaining('/mock-home/.config/ghagga/config.json'),
    );
  });
});

// ─── saveConfig ────────────────────────────────────────────────

describe('saveConfig', () => {
  it('should create config directory if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    saveConfig({ githubToken: 'gho_token' });

    expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('ghagga'), {
      recursive: true,
      mode: 0o700,
    });
  });

  it('should not create directory if it already exists', () => {
    mockExistsSync.mockReturnValue(true);

    saveConfig({ githubToken: 'gho_token' });

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('should write JSON with 2-space indent and trailing newline', () => {
    mockExistsSync.mockReturnValue(true);
    const config = { githubToken: 'gho_abc', githubLogin: 'user' };

    saveConfig(config);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('should save empty config object', () => {
    mockExistsSync.mockReturnValue(true);

    saveConfig({});

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      '{}\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('should save all optional fields when provided', () => {
    mockExistsSync.mockReturnValue(true);
    const config = {
      githubToken: 'gho_tok',
      githubLogin: 'user',
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-20250514',
    };

    saveConfig(config);

    const writtenJson = mockWriteFileSync.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed).toEqual(config);
  });

  it('should set restrictive permissions on config directory (0o700)', () => {
    mockExistsSync.mockReturnValue(false);

    saveConfig({ githubToken: 'gho_token' });

    const mkdirOpts = mockMkdirSync.mock.calls[0]?.[1] as { mode?: number };
    expect(mkdirOpts.mode).toBe(0o700);
  });

  it('should set restrictive permissions on config file (0o600)', () => {
    mockExistsSync.mockReturnValue(true);

    saveConfig({ githubToken: 'gho_token' });

    const writeOpts = mockWriteFileSync.mock.calls[0]?.[2] as { mode?: number };
    expect(writeOpts.mode).toBe(0o600);
  });
});

// ─── clearConfig ───────────────────────────────────────────────

describe('clearConfig', () => {
  it('should save an empty object', () => {
    // existsSync is called twice: once for dir check, once for config path
    // In saveConfig, existsSync is called for the dir
    mockExistsSync.mockReturnValue(true);

    clearConfig();

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      '{}\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
  });
});

// ─── isLoggedIn ────────────────────────────────────────────────

describe('isLoggedIn', () => {
  it('should return true when githubToken exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ githubToken: 'gho_valid' }));

    expect(isLoggedIn()).toBe(true);
  });

  it('should return false when githubToken is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ githubLogin: 'user' }));

    expect(isLoggedIn()).toBe(false);
  });

  it('should return false when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(isLoggedIn()).toBe(false);
  });

  it('should return false when githubToken is empty string', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ githubToken: '' }));

    expect(isLoggedIn()).toBe(false);
  });
});

// ─── getStoredToken ────────────────────────────────────────────

describe('getStoredToken', () => {
  it('should return the token when present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ githubToken: 'gho_secret123' }));

    expect(getStoredToken()).toBe('gho_secret123');
  });

  it('should return null when token is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    expect(getStoredToken()).toBeNull();
  });

  it('should return null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(getStoredToken()).toBeNull();
  });
});

// ─── getConfigFilePath ─────────────────────────────────────────

describe('getConfigFilePath', () => {
  it('should return path ending with ghagga/config.json', () => {
    const path = getConfigFilePath();

    expect(path).toMatch(/ghagga[/\\]config\.json$/);
  });

  it('should use homedir base path', () => {
    const path = getConfigFilePath();

    expect(path).toContain('/mock-home/.config/ghagga');
  });

  it('should respect XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/xdg/path';

    const path = getConfigFilePath();

    expect(path).toContain('/xdg/path/ghagga');
  });
});
