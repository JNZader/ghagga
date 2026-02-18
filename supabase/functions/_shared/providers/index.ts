/**
 * Provider module exports
 *
 * This module exports all AI provider implementations and the registry.
 */

// Provider interface and Anthropic implementation
export { type AIProvider, AnthropicProvider } from './anthropic.ts';

// OpenAI implementation
export { OpenAIProvider } from './openai.ts';

// Google Gemini implementation
export { GeminiProvider } from './gemini.ts';

// Provider registry and utilities
export {
  ProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
  type ProviderSelectionOptions,
  type CompletionResult,
  type PerRepoCredentials,
} from './registry.ts';

// Per-repo credential loader
export { getRepoCredentials } from './credentials.ts';
