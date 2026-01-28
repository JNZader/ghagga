/**
 * Embedding Service - Multi-provider embedding generation with fallback support
 *
 * Supports OpenAI and Gemini providers with automatic selection and fallback.
 */

import type {
  EmbeddingConfig as BaseEmbeddingConfig,
  EmbeddingResponse,
  EmbeddingUsage,
} from "../types/embeddings.ts";

// Extended provider types for this service
export type EmbeddingProviderType = "openai" | "gemini" | "auto";

// Service-specific configuration extending the base config
export interface EmbeddingServiceConfig {
  provider: EmbeddingProviderType;
  fallback: EmbeddingProviderType | "none";
  model: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  dimensions?: number;
  batchSize?: number;
}

// Result from a single embedding operation
export interface EmbeddingResult {
  embedding: number[];
  model: string;
  provider: string;
  dimensions: number;
  usage?: EmbeddingUsage;
}

// Provider API endpoints
const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const GEMINI_EMBEDDING_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Default models per provider
const DEFAULT_MODELS: Record<string, string> = {
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
};

// Default dimensions per model
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "embedding-001": 768,
};

export class EmbeddingService {
  private config: EmbeddingServiceConfig;

  constructor(config: EmbeddingServiceConfig) {
    this.config = {
      ...config,
      batchSize: config.batchSize ?? 100,
    };
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const provider =
      this.config.provider === "auto"
        ? await this.autoSelectProvider()
        : this.config.provider;

    try {
      return await this.executeProvider(provider, text);
    } catch (error) {
      if (
        this.config.fallback !== "none" &&
        this.config.fallback !== provider
      ) {
        const fallbackProvider =
          this.config.fallback === "auto"
            ? await this.autoSelectProvider([provider])
            : this.config.fallback;

        console.warn(
          `Primary provider ${provider} failed, trying fallback ${fallbackProvider}`,
        );
        return await this.executeProvider(fallbackProvider, text);
      }
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts efficiently
   * OpenAI supports batch in single request, others use Promise.all
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    const provider =
      this.config.provider === "auto"
        ? await this.autoSelectProvider()
        : this.config.provider;

    try {
      return await this.executeBatchProvider(provider, texts);
    } catch (error) {
      if (
        this.config.fallback !== "none" &&
        this.config.fallback !== provider
      ) {
        const fallbackProvider =
          this.config.fallback === "auto"
            ? await this.autoSelectProvider([provider])
            : this.config.fallback;

        console.warn(
          `Primary provider ${provider} failed for batch, trying fallback ${fallbackProvider}`,
        );
        return await this.executeBatchProvider(fallbackProvider, texts);
      }
      throw error;
    }
  }

  /**
   * Auto-select the best available provider based on API key availability
   */
  private async autoSelectProvider(
    exclude: string[] = [],
  ): Promise<"openai" | "gemini"> {
    // Prefer OpenAI for better batch support
    if (this.config.openaiApiKey && !exclude.includes("openai")) {
      return "openai";
    }
    if (this.config.geminiApiKey && !exclude.includes("gemini")) {
      return "gemini";
    }

    throw new Error(
      "No API key available for any embedding provider. " +
        "Please configure openaiApiKey or geminiApiKey.",
    );
  }

  /**
   * Execute embedding request for a specific provider
   */
  private async executeProvider(
    provider: "openai" | "gemini",
    text: string,
  ): Promise<EmbeddingResult> {
    switch (provider) {
      case "openai":
        return await this.embedWithOpenAI(text);
      case "gemini":
        return await this.embedWithGemini(text);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Execute batch embedding request for a specific provider
   */
  private async executeBatchProvider(
    provider: "openai" | "gemini",
    texts: string[],
  ): Promise<EmbeddingResult[]> {
    switch (provider) {
      case "openai":
        return await this.embedBatchWithOpenAI(texts);
      case "gemini":
        return await this.embedBatchWithGemini(texts);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Generate embedding using OpenAI API
   */
  private async embedWithOpenAI(text: string): Promise<EmbeddingResult> {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const model = this.config.model || DEFAULT_MODELS.openai;

    const response = await fetch(OPENAI_EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: model,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const embedding = data.data[0].embedding;

    return {
      embedding,
      model: data.model,
      provider: "openai",
      dimensions: embedding.length,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * Generate batch embeddings using OpenAI API (single request)
   */
  private async embedBatchWithOpenAI(
    texts: string[],
  ): Promise<EmbeddingResult[]> {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const model = this.config.model || DEFAULT_MODELS.openai;
    const batchSize = this.config.batchSize ?? 100;
    const results: EmbeddingResult[] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const response = await fetch(OPENAI_EMBEDDING_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: batch,
          model: model,
          dimensions: this.config.dimensions,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `OpenAI batch embedding failed: ${response.status} - ${error}`,
        );
      }

      const data = await response.json();

      // OpenAI returns embeddings in order
      for (const item of data.data) {
        results.push({
          embedding: item.embedding,
          model: data.model,
          provider: "openai",
          dimensions: item.embedding.length,
          usage: data.usage
            ? {
                promptTokens: Math.floor(
                  data.usage.prompt_tokens / batch.length,
                ),
                totalTokens: Math.floor(
                  data.usage.total_tokens / batch.length,
                ),
              }
            : undefined,
        });
      }
    }

    return results;
  }

  /**
   * Generate embedding using Gemini API
   */
  private async embedWithGemini(text: string): Promise<EmbeddingResult> {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) {
      throw new Error("Gemini API key not configured");
    }

    const model = this.config.model || DEFAULT_MODELS.gemini;
    const url = `${GEMINI_EMBEDDING_URL}/${model}:embedContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: {
          parts: [{ text }],
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini embedding failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const embedding = data.embedding.values;

    return {
      embedding,
      model: model,
      provider: "gemini",
      dimensions: embedding.length,
    };
  }

  /**
   * Generate batch embeddings using Gemini API
   * Gemini uses batchEmbedContents endpoint
   */
  private async embedBatchWithGemini(
    texts: string[],
  ): Promise<EmbeddingResult[]> {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) {
      throw new Error("Gemini API key not configured");
    }

    const model = this.config.model || DEFAULT_MODELS.gemini;
    const url = `${GEMINI_EMBEDDING_URL}/${model}:batchEmbedContents?key=${apiKey}`;
    const batchSize = this.config.batchSize ?? 100;
    const results: EmbeddingResult[] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const requests = batch.map((text) => ({
        model: `models/${model}`,
        content: {
          parts: [{ text }],
        },
      }));

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `Gemini batch embedding failed: ${response.status} - ${error}`,
        );
      }

      const data = await response.json();

      for (const item of data.embeddings) {
        results.push({
          embedding: item.values,
          model: model,
          provider: "gemini",
          dimensions: item.values.length,
        });
      }
    }

    return results;
  }

  /**
   * Get the expected dimensions for the configured model
   */
  getExpectedDimensions(): number {
    if (this.config.dimensions) {
      return this.config.dimensions;
    }
    return MODEL_DIMENSIONS[this.config.model] ?? 1536;
  }

  /**
   * Get the current configuration
   */
  getConfig(): EmbeddingServiceConfig {
    return { ...this.config };
  }
}
