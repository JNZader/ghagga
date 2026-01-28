/**
 * Embedding types for vector storage and similarity search
 */

// Embedding provider types
export type EmbeddingProvider = 'openai' | 'cohere' | 'voyage' | 'local';

// Embedding model configuration
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
}

// Embedding request
export interface EmbeddingRequest {
  input: string | string[];
  model?: string;
}

// Embedding response
export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage?: EmbeddingUsage;
}

// Embedding usage tracking
export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

// Stored embedding record
export interface EmbeddingRecord {
  id: string;
  content_type: EmbeddingContentType;
  content_id: string;
  content_hash: string;
  embedding: number[];
  metadata?: EmbeddingMetadata;
  created_at: string;
}

// Types of content that can have embeddings
export type EmbeddingContentType =
  | 'review'
  | 'thread'
  | 'message'
  | 'file'
  | 'code_snippet'
  | 'documentation';

// Embedding metadata
export interface EmbeddingMetadata {
  repo_full_name?: string;
  file_path?: string;
  language?: string;
  chunk_index?: number;
  total_chunks?: number;
}

// Similarity search query
export interface SimilaritySearchQuery {
  embedding: number[];
  content_type?: EmbeddingContentType;
  repo_full_name?: string;
  limit?: number;
  threshold?: number;
}

// Similarity search result
export interface SimilaritySearchResult {
  id: string;
  content_type: EmbeddingContentType;
  content_id: string;
  similarity: number;
  metadata?: EmbeddingMetadata;
}

// Batch embedding request for multiple items
export interface BatchEmbeddingRequest {
  items: BatchEmbeddingItem[];
  model?: string;
}

// Single item in batch embedding
export interface BatchEmbeddingItem {
  id: string;
  content: string;
  content_type: EmbeddingContentType;
  metadata?: EmbeddingMetadata;
}

// Batch embedding result
export interface BatchEmbeddingResult {
  id: string;
  embedding: number[];
  success: boolean;
  error?: string;
}
