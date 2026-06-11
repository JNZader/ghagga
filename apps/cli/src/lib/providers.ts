/**
 * Provider resolution helpers.
 *
 * GHAGGA v3 only supports three providers: gateway, cli-bridge, ollama.
 * Older versions of "ghagga login" stored direct SDK providers (most
 * commonly 'github') in the user config. Those stored values are migrated
 * at read time so existing users don't get a hard failure on first run.
 */

/**
 * Providers that existed before the gateway refactor and are no longer
 * supported directly. Explicit usage (--provider flag / env var) is a hard
 * error; values loaded from stored config are remapped to 'gateway'.
 */
export const LEGACY_CLI_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'github',
  'groq',
  'openrouter',
  'azure',
  'deepseek',
  'qwen',
  'cerebras',
]);

export function isLegacyProvider(provider: string | undefined): boolean {
  return provider !== undefined && LEGACY_CLI_PROVIDERS.has(provider);
}

export interface LegacyRemapResult {
  /** The provider to use (remapped to 'gateway' when the input was legacy) */
  provider: string;
  /** True when a legacy stored provider was remapped */
  remapped: boolean;
}

/**
 * Read-time migration for provider values loaded from STORED CONFIG.
 *
 * Do NOT use this for explicit --provider flags or env vars — those should
 * keep failing loudly so the user fixes their invocation.
 */
export function remapLegacyStoredProvider(provider: string): LegacyRemapResult {
  if (LEGACY_CLI_PROVIDERS.has(provider)) {
    return { provider: 'gateway', remapped: true };
  }
  return { provider, remapped: false };
}
