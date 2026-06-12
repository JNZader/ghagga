/**
 * Provider resolution helpers for the review pipeline.
 *
 * Moved verbatim from pipeline.ts (split-review-pipeline refactor).
 */

import { resolveCredentialEnvVar } from '../providers/cli-bridge.js';
import {
  createCLIBridgeGenerateFn,
  createGatewayGenerateFn,
  createOllamaGenerateFn,
  type GenerateTextFn,
} from '../providers/generate-fn.js';
import type { ProviderChainEntry, ReviewInput, ReviewMode } from '../types.js';

// ─── Provider Resolution ────────────────────────────────────────

/**
 * Determine if AI review is enabled.
 * Defaults to true for backward compatibility (CLI/Action don't set this).
 */
export function resolveAiEnabled(input: ReviewInput): boolean {
  if (input.aiReviewEnabled === false) return false;
  // If chain is explicitly empty and no single provider, treat as disabled
  if (input.providerChain && input.providerChain.length === 0 && !input.provider) {
    console.warn(
      '[ghagga] AI review enabled but provider chain is empty and no single provider — treating as disabled',
    );
    return false;
  }
  return true;
}

/**
 * Resolve the primary provider from chain or flat fields.
 * Returns the first entry in the chain, or builds one from flat fields.
 */
export function resolvePrimaryProvider(input: ReviewInput): ProviderChainEntry {
  if (input.providerChain && input.providerChain.length > 0) {
    const first = input.providerChain[0];
    if (first) return first;
  }

  // Backward compat: single provider from flat fields
  if (!input.provider || !input.model || !input.apiKey) {
    throw new Error('No provider chain and no single provider configured');
  }
  return {
    provider: input.provider as ProviderChainEntry['provider'],
    model: input.model,
    apiKey: input.apiKey,
  };
}

/**
 * Build the 3-entry ConsensusModelConfig array for the for/against/neutral votes.
 *
 * Distribution rules (given a chain of length N):
 *   N >= 3 : chain[0]→for, chain[1]→against, chain[2]→neutral
 *   N == 2 : chain[0]→for, chain[1]→against, chain[0]→neutral
 *   N == 1 : all 3 votes use chain[0]  (same as primary-only)
 *   N == 0 : all 3 votes use `primary` (backward compat)
 *
 * This spreads consensus votes across providers so each vote hits a
 * different TPM budget instead of all three hammering the same limit.
 */
export function buildConsensusModels(
  chain: ProviderChainEntry[] | undefined,
  primary: ProviderChainEntry,
): import('../agents/consensus.js').ConsensusModelConfig[] {
  const stances = ['for', 'against', 'neutral'] as const;

  return stances.map((stance, i) => {
    const entry =
      chain && chain.length > 0 ? (chain[i % chain.length] as ProviderChainEntry) : primary;
    return {
      provider: entry.provider as import('../types.js').LLMProvider,
      model: entry.model,
      apiKey: entry.apiKey,
      stance,
    };
  });
}

/**
 * Resolve the model name for token budget calculation.
 */
export function resolvePrimaryModel(input: ReviewInput): string {
  if (input.providerChain && input.providerChain.length > 0) {
    return input.providerChain[0]?.model ?? 'gpt-4o-mini';
  }
  return input.model ?? 'gpt-4o-mini';
}

// ─── GenerateTextFn Resolution ──────────────────────────────────

/**
 * Create the appropriate GenerateTextFn(s) based on the provider type.
 *
 * - cli-bridge: single fn wrapping generateViaCLI
 * - gateway: one fn per gateway chain entry (for round-robin distribution)
 * - ollama: single fn wrapping local Ollama OpenAI-compatible API
 *
 * Providers that are no longer supported directly (anthropic, openai, etc.)
 * throw a migration error pointing users to gateway mode.
 */
export function resolveGenerateTextFns(
  input: ReviewInput,
  isCliBridge: boolean,
  isGateway: boolean,
  isOllama: boolean,
): GenerateTextFn[] {
  if (isCliBridge) {
    // Resolve CLI bridge options from provider chain or flat input fields
    const cliBridgeEntry = input.providerChain?.[0];
    const preferredCLI =
      (cliBridgeEntry?.model ?? input.model) !== 'auto'
        ? (cliBridgeEntry?.model ?? input.model)
        : undefined;

    const cliModel = cliBridgeEntry?.cliModel;

    // Build credentials from the decrypted API key
    const decryptedKey = cliBridgeEntry?.apiKey || input.apiKey;
    const credentialEnvName = resolveCredentialEnvVar(preferredCLI, cliModel);
    const credentials: Record<string, string> = {};
    if (preferredCLI && credentialEnvName && decryptedKey) {
      credentials[credentialEnvName] = decryptedKey;
    }

    return [
      createCLIBridgeGenerateFn({
        preferredCLI,
        cliModel,
        credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
      }),
    ];
  }

  if (isGateway) {
    // Map ALL gateway entries in the chain — one GenerateTextFn per model
    // for round-robin distribution in workflow/consensus modes
    const chain = input.providerChain?.filter((e) => e.provider === 'gateway') ?? [];

    if (chain.length > 0) {
      // Use gatewayUrl and token from the first entry (shared across all)
      const gatewayUrl = chain[0]?.gatewayUrl ?? '';
      const gatewayToken = chain[0]?.apiKey || input.apiKey || '';

      return chain.map((entry) => {
        const model = entry.model !== 'auto' ? entry.model : undefined;
        return createGatewayGenerateFn({
          gatewayUrl,
          gatewayToken,
          model,
          project: 'ghagga',
        });
      });
    }

    // Fallback: single entry from flat input fields
    return [
      createGatewayGenerateFn({
        gatewayUrl: '',
        gatewayToken: input.apiKey || '',
        model: input.model !== 'auto' ? input.model : undefined,
        project: 'ghagga',
      }),
    ];
  }

  if (isOllama) {
    const model = input.model && input.model !== 'auto' ? input.model : 'llama3';
    return [createOllamaGenerateFn(model, input.ollamaBaseURL)];
  }

  // Legacy provider migration guard — should never reach here with the narrowed type,
  // but protects against runtime strings from older configs.
  const legacyProvider = input.providerChain?.[0]?.provider ?? input.provider ?? 'unknown';
  throw new Error(
    `Provider '${legacyProvider}' is no longer supported directly. ` +
      `Set provider: 'gateway' and configure credentials in mcp-llm-bridge. ` +
      `See docs/configuration.md#gateway-mode-mcp-llm-bridge`,
  );
}

/**
 * Resolve the effective review mode.
 *
 * Diagnostic mode requires direct model access. Ollama provides it
 * (runDiagnosticReview uses createOllamaGenerateFn); CLI bridge and
 * gateway do not, so they fall back to simple mode.
 */
export function resolveEffectiveMode(
  mode: ReviewMode,
  isCliBridge: boolean,
  isGateway: boolean,
): ReviewMode {
  if (mode === 'diagnostic' && (isCliBridge || isGateway)) {
    return 'simple';
  }
  // Fan-out works with all backends (uses generateFns like workflow/consensus)
  return mode;
}
