/**
 * CLI embedding provider resolution (design D2, task 5.2).
 *
 * Merges the `EMBEDDING_*` keys stored in `~/.config/ghagga/config.json`
 * over `process.env` before delegating to `resolveEmbeddingConfig` /
 * `createEmbeddingProvider` from `ghagga-core` — the same resolver every
 * construction site (server, CLI, Action) shares. Config-file values win
 * over env so `ghagga login`-style persisted preferences aren't shadowed
 * by ambient env vars.
 */

import type { EmbeddingConfig, EmbeddingProvider } from 'ghagga-core';
import { createEmbeddingProvider, resolveEmbeddingConfig } from 'ghagga-core';
import { loadConfig } from './config.js';

/** Resolve the merged embedding config (config-file over env, design D2). */
export function resolveCliEmbeddingConfig(): EmbeddingConfig {
  const fileConfig = loadConfig();

  const merged: Record<string, string | undefined> = {
    EMBEDDING_PROVIDER: fileConfig.embeddingProvider ?? process.env.EMBEDDING_PROVIDER,
    EMBEDDING_MODEL: fileConfig.embeddingModel ?? process.env.EMBEDDING_MODEL,
    EMBEDDING_BASE_URL: fileConfig.embeddingBaseUrl ?? process.env.EMBEDDING_BASE_URL,
    EMBEDDING_API_KEY: fileConfig.embeddingApiKey ?? process.env.EMBEDDING_API_KEY,
    EMBEDDING_DIMENSION:
      fileConfig.embeddingDimension !== undefined
        ? String(fileConfig.embeddingDimension)
        : process.env.EMBEDDING_DIMENSION,
    EMBEDDING_CANDIDATE_K:
      fileConfig.embeddingCandidateK !== undefined
        ? String(fileConfig.embeddingCandidateK)
        : process.env.EMBEDDING_CANDIDATE_K,
  };

  return resolveEmbeddingConfig(merged);
}

/**
 * Resolve the merged config AND build the concrete provider in one call —
 * the common case for every SqliteMemoryStorage construction site.
 * Returns `provider: undefined` when unconfigured (`none`-default parity).
 */
export function resolveCliEmbeddingProvider(): {
  config: EmbeddingConfig;
  provider: EmbeddingProvider | undefined;
} {
  const config = resolveCliEmbeddingConfig();
  return { config, provider: createEmbeddingProvider(config) ?? undefined };
}
