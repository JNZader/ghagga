/**
 * Provider Registry with priority order and fallback support
 */

import type { LLMProvider, LLMRequestOptions, LLMResponse } from '../types/index.ts';
import { type AIProvider, AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { GeminiProvider } from './gemini.ts';

/**
 * Options for provider selection
 */
export interface ProviderSelectionOptions {
  preferredProvider?: LLMProvider;
  excludeProviders?: LLMProvider[];
  requireModel?: string;
}

/**
 * Result of a completion with fallback information
 */
export interface CompletionResult {
  response: LLMResponse;
  provider: LLMProvider;
  fallbackUsed: boolean;
  attemptedProviders: LLMProvider[];
}

/**
 * Provider Registry manages AI providers with priority-based selection and fallback
 */
export class ProviderRegistry {
  private providers: Map<LLMProvider, AIProvider> = new Map();

  /**
   * Priority order for provider selection
   * Anthropic is preferred, followed by OpenAI, then Google
   */
  static readonly PRIORITY_ORDER: LLMProvider[] = ['anthropic', 'openai', 'google'];

  constructor() {
    this.providers.set('anthropic', new AnthropicProvider());
    this.providers.set('openai', new OpenAIProvider());
    this.providers.set('google', new GeminiProvider());
  }

  /**
   * Get a provider by name
   */
  getProvider(name: LLMProvider): AIProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get the best available provider based on priority order
   */
  async getBestProvider(
    options?: ProviderSelectionOptions
  ): Promise<AIProvider | null> {
    const priorityOrder = this.getPriorityOrder(options);

    for (const name of priorityOrder) {
      if (options?.excludeProviders?.includes(name)) {
        continue;
      }

      const provider = this.providers.get(name);
      if (!provider) {
        continue;
      }

      if (options?.requireModel && !provider.models.includes(options.requireModel)) {
        continue;
      }

      if (await provider.isAvailable()) {
        return provider;
      }
    }

    return null;
  }

  /**
   * Get all available providers
   */
  async getAvailableProviders(): Promise<AIProvider[]> {
    const available: AIProvider[] = [];

    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        available.push(provider);
      }
    }

    return available;
  }

  /**
   * Get provider names that are currently available
   */
  async getAvailableProviderNames(): Promise<LLMProvider[]> {
    const available: LLMProvider[] = [];

    for (const [name, provider] of this.providers.entries()) {
      if (await provider.isAvailable()) {
        available.push(name);
      }
    }

    return available;
  }

  /**
   * Complete a request with automatic fallback to other providers
   */
  async completeWithFallback(
    options: LLMRequestOptions,
    selectionOptions?: ProviderSelectionOptions
  ): Promise<CompletionResult> {
    const priorityOrder = this.getPriorityOrder(selectionOptions);
    const attemptedProviders: LLMProvider[] = [];
    const errors: Array<{ provider: LLMProvider; error: Error }> = [];

    for (const name of priorityOrder) {
      if (selectionOptions?.excludeProviders?.includes(name)) {
        continue;
      }

      const provider = this.providers.get(name);
      if (!provider) {
        continue;
      }

      if (
        selectionOptions?.requireModel &&
        !provider.models.includes(selectionOptions.requireModel)
      ) {
        continue;
      }

      if (!(await provider.isAvailable())) {
        continue;
      }

      attemptedProviders.push(name);

      try {
        const response = await provider.complete(options);
        return {
          response,
          provider: name,
          fallbackUsed: attemptedProviders.length > 1,
          attemptedProviders,
        };
      } catch (error) {
        errors.push({
          provider: name,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        // Continue to next provider on error
      }
    }

    // All providers failed
    const errorMessages = errors
      .map((e) => `${e.provider}: ${e.error.message}`)
      .join('; ');

    throw new Error(
      `All providers failed. Attempted: ${attemptedProviders.join(', ')}. Errors: ${errorMessages}`
    );
  }

  /**
   * Check if any provider is available
   */
  async hasAvailableProvider(): Promise<boolean> {
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all registered providers (regardless of availability)
   */
  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all registered provider names
   */
  getAllProviderNames(): LLMProvider[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get priority order, optionally with preferred provider first
   */
  private getPriorityOrder(options?: ProviderSelectionOptions): LLMProvider[] {
    if (!options?.preferredProvider) {
      return [...ProviderRegistry.PRIORITY_ORDER];
    }

    const order = ProviderRegistry.PRIORITY_ORDER.filter(
      (p) => p !== options.preferredProvider
    );

    return [options.preferredProvider, ...order];
  }
}

/**
 * Singleton instance for convenience
 */
let registryInstance: ProviderRegistry | null = null;

/**
 * Get the shared provider registry instance
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
  }
  return registryInstance;
}

/**
 * Reset the shared provider registry instance (useful for testing)
 */
export function resetProviderRegistry(): void {
  registryInstance = null;
}
