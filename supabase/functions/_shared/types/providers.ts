/**
 * Provider types for LLM and AI services
 */

// Supported LLM providers
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'ollama'
  | 'groq'
  | 'mistral';

// Provider configuration
export interface ProviderConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

// Provider credentials stored in database
export interface ProviderCredentials {
  id: string;
  installation_id: number;
  provider: LLMProvider;
  api_key_encrypted: string;
  base_url?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Chat message format for LLM requests
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

// LLM request options
export interface LLMRequestOptions {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
}

// LLM response
export interface LLMResponse {
  content: string;
  model: string;
  usage?: TokenUsage;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls';
}

// Token usage tracking
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Provider health check result
export interface ProviderHealthCheck {
  provider: LLMProvider;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

// Model information
export interface ModelInfo {
  id: string;
  provider: LLMProvider;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

// Provider rate limit info
export interface RateLimitInfo {
  provider: LLMProvider;
  requestsPerMinute: number;
  tokensPerMinute: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetAt?: string;
}
