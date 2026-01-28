/**
 * Embedding Service Module
 *
 * Multi-provider embedding generation with caching support.
 *
 * @module embeddings
 */

// Service exports
export {
  EmbeddingService,
  type EmbeddingProviderType,
  type EmbeddingServiceConfig,
  type EmbeddingResult,
} from "./service.ts";

// Cache exports
export {
  EmbeddingCache,
  hashContent,
  hashContents,
  type EmbeddingCacheEntry,
  type CacheStats,
} from "./cache.ts";
