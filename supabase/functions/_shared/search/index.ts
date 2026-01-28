/**
 * Search module - Hybrid search combining vector similarity and FTS
 *
 * This module provides search capabilities that combine:
 * - Vector similarity search using pgvector embeddings
 * - Full-text search using PostgreSQL pg_trgm
 *
 * @example
 * ```typescript
 * import { HybridSearch } from '../_shared/search/index.ts';
 *
 * const search = new HybridSearch(supabase, embeddingService, {
 *   vectorWeight: 0.7,
 *   textWeight: 0.3,
 *   minScore: 0.35,
 *   maxResults: 6,
 * });
 *
 * const results = await search.search('authentication bug', 'owner/repo');
 * ```
 */

export {
  HybridSearch,
  type HybridSearchConfig,
  type SearchResult,
  type EmbeddingServiceInterface,
} from './hybrid.ts';
