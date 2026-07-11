/**
 * CLI configuration management.
 *
 * Stores auth credentials and preferences in ~/.config/ghagga/config.json
 * following the XDG Base Directory specification.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface GhaggaCliConfig {
  /** GitHub OAuth access token from Device Flow */
  githubToken?: string;

  /** GitHub username (fetched after login) */
  githubLogin?: string;

  /**
   * GitLab Personal/Project/Group Access Token (PAT). SEPARATE from the GitHub
   * token: a GitHub token MUST NOT be used against GitLab. Resolved by the `--mr`
   * post-back AFTER env GITLAB_TOKEN / GL_TOKEN.
   */
  gitlabToken?: string;

  /** Default LLM provider */
  defaultProvider?: string;

  /** Default model for the provider */
  defaultModel?: string;

  /**
   * Embedding provider config overrides (design D2). Config-file keys take
   * precedence over the matching `EMBEDDING_*` env vars — see
   * `resolveCliEmbeddingConfig` in `./embedding.js`.
   */
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingDimension?: number;
  embeddingCandidateK?: number;
}

// ─── Paths ──────────────────────────────────────────────────────

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base = xdgConfig || join(homedir(), '.config');
  return join(base, 'ghagga');
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

// ─── Read / Write ───────────────────────────────────────────────

/**
 * Load the CLI config file. Returns empty config if not found.
 */
export function loadConfig(): GhaggaCliConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as GhaggaCliConfig;
  } catch {
    return {};
  }
}

/**
 * Save the CLI config file. Creates the directory if needed.
 */
export function saveConfig(config: GhaggaCliConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Clear all stored auth credentials.
 */
export function clearConfig(): void {
  saveConfig({});
}

/**
 * Check if the user is logged in (has a stored token).
 */
export function isLoggedIn(): boolean {
  const config = loadConfig();
  return !!config.githubToken;
}

/**
 * Get the stored GitHub token, or null if not logged in.
 */
export function getStoredToken(): string | null {
  const config = loadConfig();
  return config.githubToken ?? null;
}

/**
 * Get the stored GitLab token, or null if none. SEPARATE from
 * {@link getStoredToken} (GitHub): the `--mr` post-back must never authenticate
 * to GitLab with a GitHub token.
 */
export function getStoredGitLabToken(): string | null {
  const config = loadConfig();
  return config.gitlabToken ?? null;
}

/**
 * Get the config file path (for display in status/error messages).
 */
export function getConfigFilePath(): string {
  return getConfigPath();
}
