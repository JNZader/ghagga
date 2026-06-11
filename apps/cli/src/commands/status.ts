/**
 * Status command — shows current authentication and configuration.
 */

import type { LLMProvider } from 'ghagga-core';
import { DEFAULT_MODELS } from 'ghagga-core';
import { getConfigFilePath, isLoggedIn, loadConfig } from '../lib/config.js';
import { remapLegacyStoredProvider } from '../lib/providers.js';
import { fetchGitHubUser } from '../lib/oauth.js';
import * as tui from '../ui/tui.js';

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const configPath = getConfigFilePath();

  tui.intro('🤖 GHAGGA Status');
  tui.log.message(`   Config: ${configPath}`);

  if (!isLoggedIn()) {
    tui.log.info('   Auth:   Not logged in');
    tui.log.info('\n   Run "ghagga login" to authenticate with GitHub.\n');
    return;
  }

  // Read-time migration: legacy providers stored by an old "ghagga login"
  // are remapped to 'gateway' everywhere else (review, audit) — show the
  // value those commands will actually use, not the raw stored one.
  const storedProvider = config.defaultProvider ?? 'gateway';
  const remap = remapLegacyStoredProvider(storedProvider);
  const defaultModel = DEFAULT_MODELS[remap.provider as LLMProvider] ?? 'auto';
  const providerLabel = remap.remapped
    ? `${remap.provider} (migrated from '${storedProvider}' — run "ghagga login" to refresh)`
    : remap.provider;
  // A stored model belongs to the legacy provider — ignore it after remap
  const modelLabel = (remap.remapped ? undefined : config.defaultModel) ?? defaultModel;

  tui.log.message(`   Auth:   Logged in as ${config.githubLogin ?? 'unknown'}`);
  tui.log.message(`   Provider: ${providerLabel}`);
  tui.log.message(`   Model:    ${modelLabel}`);

  // Validate the stored credential is still valid
  if (config.githubToken) {
    try {
      const user = await fetchGitHubUser(config.githubToken);
      tui.log.success(`   Session: Valid (${user.login})`);
    } catch {
      tui.log.warn('   Session: Expired or invalid');
      tui.log.info('\n   Run "ghagga login" to re-authenticate.\n');
      return;
    }
  }

  tui.outro('Done');
}
