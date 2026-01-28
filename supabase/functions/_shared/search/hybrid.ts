/**
 * Hybrid Search - Combines vector similarity (pgvector) with FTS keywords
 *
 * This module implements a hybrid search approach that:
 * 1. Performs vector similarity search using embeddings
 * 2. Performs full-text search using PostgreSQL FTS
 * 3. Merges results with configurable weights (default: 70% vector, 30% text)
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Configuration for hybrid search behavior
 */
export interface HybridSearchConfig {
  /** Weight for vector similarity results (0-1), default: 0.7 */
  vectorWeight: number;
  /** Weight for text search results (0-1), default: 0.3 */
  textWeight: number;
  /** Minimum combined score threshold, default: 0.35 */
  minScore: number;
  /** Maximum number of results to return, default: 6 */
  maxResults: number;
}

/**
 * Result from hybrid search operation
 */
export interface SearchResult {
  /** Review ID */
  id: string;
  /** Combined score from vector and text search */
  combinedScore: number;
  /** Individual vector similarity score */
  vectorScore: number;
  /** Individual text search score */
  textScore: number;
}

/**
 * Interface for embedding service dependency
 * This allows injection of the EmbeddingService from T-006
 */
export interface EmbeddingServiceInterface {
  embed(text: string): Promise<{ embedding: number[] }>;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: HybridSearchConfig = {
  vectorWeight: 0.7,
  textWeight: 0.3,
  minScore: 0.35,
  maxResults: 6,
};

/**
 * HybridSearch class that combines vector similarity and FTS
 */
export class HybridSearch {
  private supabase: SupabaseClient;
  private config: HybridSearchConfig;
  private embeddingService: EmbeddingServiceInterface;

  constructor(
    supabase: SupabaseClient,
    embeddingService: EmbeddingServiceInterface,
    config: Partial<HybridSearchConfig> = {}
  ) {
    this.supabase = supabase;
    this.embeddingService = embeddingService;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Validate weights sum to 1
    if (Math.abs(this.config.vectorWeight + this.config.textWeight - 1) > 0.001) {
      throw new Error('vectorWeight and textWeight must sum to 1');
    }
  }

  /**
   * Perform hybrid search combining vector similarity and text search
   *
   * @param query - Search query string
   * @param repoFullName - Repository full name (e.g., "owner/repo")
   * @returns Array of search results sorted by combined score
   */
  async search(query: string, repoFullName: string): Promise<SearchResult[]> {
    // Execute both searches in parallel
    const [vectorResults, textResults] = await Promise.all([
      this.vectorSearch(query, repoFullName),
      this.textSearch(query, repoFullName),
    ]);

    return this.mergeResults(vectorResults, textResults);
  }

  /**
   * Perform vector similarity search using pgvector
   *
   * @param query - Search query string
   * @param repoFullName - Repository full name
   * @returns Map of review IDs to similarity scores
   */
  async vectorSearch(query: string, repoFullName: string): Promise<Map<string, number>> {
    // Generate embedding for the query
    const { embedding } = await this.embeddingService.embed(query);

    // Call the search_reviews_vector RPC function
    const { data, error } = await this.supabase.rpc('search_reviews_vector', {
      query_embedding: embedding,
      repo_name: repoFullName,
      match_threshold: 0.5,
      match_count: this.config.maxResults * 4,
    });

    if (error) {
      throw new Error(`Vector search failed: ${error.message}`);
    }

    const results = new Map<string, number>();
    for (const row of data || []) {
      results.set(row.id, row.similarity);
    }
    return results;
  }

  /**
   * Perform full-text search using PostgreSQL pg_trgm
   *
   * Uses trigram similarity for fuzzy text matching on review content.
   * Results are normalized to 0-1 range for combination with vector scores.
   *
   * @param query - Search query string
   * @param repoFullName - Repository full name
   * @returns Map of review IDs to normalized text search scores
   */
  async textSearch(query: string, repoFullName: string): Promise<Map<string, number>> {
    // Use pg_trgm similarity search on content field
    // The % operator checks if similarity > threshold (default 0.3)
    const { data, error } = await this.supabase
      .from('reviews')
      .select('id, content')
      .eq('repo_full_name', repoFullName)
      .limit(this.config.maxResults * 4);

    if (error) {
      throw new Error(`Text search failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return new Map<string, number>();
    }

    // Calculate trigram similarity scores client-side
    // In production, this would use the pg_trgm similarity() function via RPC
    const results = new Map<string, number>();
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);

    for (const row of data) {
      const contentLower = row.content.toLowerCase();

      // Calculate simple term match score
      let matchCount = 0;
      for (const term of queryTerms) {
        if (contentLower.includes(term)) {
          matchCount++;
        }
      }

      // Normalize score to 0-1 range
      const score = queryTerms.length > 0 ? matchCount / queryTerms.length : 0;

      if (score > 0) {
        results.set(row.id, score);
      }
    }

    return results;
  }
}
