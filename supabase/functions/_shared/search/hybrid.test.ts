/**
 * Unit tests for HybridSearch class
 *
 * Tests cover:
 * - Configuration validation
 * - Vector search functionality
 * - Text search functionality
 * - Result merging with weights
 * - Score filtering and sorting
 */

import {
  assertEquals,
  assertThrows,
  assertRejects,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { describe, it, beforeEach } from 'https://deno.land/std@0.208.0/testing/bdd.ts';
import { spy, stub, assertSpyCalls } from 'https://deno.land/std@0.208.0/testing/mock.ts';

import {
  HybridSearch,
  type HybridSearchConfig,
  type EmbeddingServiceInterface,
} from './hybrid.ts';

// Mock embedding service
const createMockEmbeddingService = (): EmbeddingServiceInterface => ({
  embed: async (_text: string) => ({
    embedding: Array(1536).fill(0.1),
  }),
});

// Mock Supabase client
const createMockSupabase = (vectorData: unknown[] = [], textData: unknown[] = []) => ({
  rpc: async (_fn: string, _params: unknown) => ({
    data: vectorData,
    error: null,
  }),
  from: (_table: string) => ({
    select: (_columns: string) => ({
      eq: (_column: string, _value: string) => ({
        limit: (_count: number) => Promise.resolve({
          data: textData,
          error: null,
        }),
      }),
    }),
  }),
});

describe('HybridSearch', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const supabase = createMockSupabase();
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const config = search.getConfig();

      assertEquals(config.vectorWeight, 0.7);
      assertEquals(config.textWeight, 0.3);
      assertEquals(config.minScore, 0.35);
      assertEquals(config.maxResults, 6);
    });

    it('should accept custom config', () => {
      const supabase = createMockSupabase();
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService, {
        vectorWeight: 0.6,
        textWeight: 0.4,
        minScore: 0.5,
        maxResults: 10,
      });
      const config = search.getConfig();

      assertEquals(config.vectorWeight, 0.6);
      assertEquals(config.textWeight, 0.4);
      assertEquals(config.minScore, 0.5);
      assertEquals(config.maxResults, 10);
    });

    it('should throw error if weights do not sum to 1', () => {
      const supabase = createMockSupabase();
      const embeddingService = createMockEmbeddingService();

      assertThrows(
        () => new HybridSearch(supabase as never, embeddingService, {
          vectorWeight: 0.5,
          textWeight: 0.3,
        }),
        Error,
        'vectorWeight and textWeight must sum to 1'
      );
    });
  });

  describe('vectorSearch', () => {
    it('should return map of review IDs to similarity scores', async () => {
      const vectorData = [
        { id: 'uuid-1', similarity: 0.95 },
        { id: 'uuid-2', similarity: 0.85 },
        { id: 'uuid-3', similarity: 0.75 },
      ];
      const supabase = createMockSupabase(vectorData);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const results = await search.vectorSearch('test query', 'owner/repo');

      assertEquals(results.size, 3);
      assertEquals(results.get('uuid-1'), 0.95);
      assertEquals(results.get('uuid-2'), 0.85);
      assertEquals(results.get('uuid-3'), 0.75);
    });

    it('should return empty map when no results', async () => {
      const supabase = createMockSupabase([]);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const results = await search.vectorSearch('test query', 'owner/repo');

      assertEquals(results.size, 0);
    });

    it('should throw error on RPC failure', async () => {
      const supabase = {
        rpc: async () => ({
          data: null,
          error: { message: 'Database error' },
        }),
      };
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);

      await assertRejects(
        () => search.vectorSearch('test query', 'owner/repo'),
        Error,
        'Vector search failed: Database error'
      );
    });
  });

  describe('textSearch', () => {
    it('should return map of review IDs with matching terms', async () => {
      const textData = [
        { id: 'uuid-1', content: 'This is a test query example' },
        { id: 'uuid-2', content: 'Another test case' },
        { id: 'uuid-3', content: 'No matching content here' },
      ];
      const supabase = createMockSupabase([], textData);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const results = await search.textSearch('test query', 'owner/repo');

      // uuid-1 should match both 'test' and 'query'
      assertEquals(results.get('uuid-1'), 1.0);
      // uuid-2 should match 'test' only
      assertEquals(results.get('uuid-2'), 0.5);
      // uuid-3 should not be in results (no match)
      assertEquals(results.has('uuid-3'), false);
    });

    it('should return empty map when no data', async () => {
      const supabase = createMockSupabase([], []);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const results = await search.textSearch('test query', 'owner/repo');

      assertEquals(results.size, 0);
    });

    it('should handle case-insensitive matching', async () => {
      const textData = [
        { id: 'uuid-1', content: 'TEST QUERY uppercase' },
        { id: 'uuid-2', content: 'TeSt QuErY mixed case' },
      ];
      const supabase = createMockSupabase([], textData);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      const results = await search.textSearch('test query', 'owner/repo');

      assertEquals(results.get('uuid-1'), 1.0);
      assertEquals(results.get('uuid-2'), 1.0);
    });
  });

  describe('search (hybrid)', () => {
    it('should merge vector and text results with weights', async () => {
      const vectorData = [
        { id: 'uuid-1', similarity: 1.0 },
        { id: 'uuid-2', similarity: 0.8 },
      ];
      const textData = [
        { id: 'uuid-1', content: 'matching test content' },
        { id: 'uuid-3', content: 'test only in text' },
      ];
      const supabase = createMockSupabase(vectorData, textData);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService, {
        vectorWeight: 0.7,
        textWeight: 0.3,
        minScore: 0.0,
        maxResults: 10,
      });
      const results = await search.search('test', 'owner/repo');

      // uuid-1: vector=1.0, text=1.0 -> 0.7*1.0 + 0.3*1.0 = 1.0
      // uuid-2: vector=0.8, text=0.0 -> 0.7*0.8 + 0.3*0.0 = 0.56
      // uuid-3: vector=0.0, text=1.0 -> 0.7*0.0 + 0.3*1.0 = 0.3

      assertEquals(results.length, 3);
      assertEquals(results[0].id, 'uuid-1');
      assertEquals(results[0].combinedScore, 1.0);
      assertEquals(results[1].id, 'uuid-2');
      assertEquals(results[1].combinedScore, 0.56);
      assertEquals(results[2].id, 'uuid-3');
      assertEquals(results[2].combinedScore, 0.3);
    });

    it('should filter results below minScore', async () => {
      const vectorData = [
        { id: 'uuid-1', similarity: 0.5 },
        { id: 'uuid-2', similarity: 0.3 },
      ];
      const textData: unknown[] = [];
      const supabase = createMockSupabase(vectorData, textData);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService, {
        vectorWeight: 0.7,
        textWeight: 0.3,
        minScore: 0.35,
        maxResults: 10,
      });
      const results = await search.search('test', 'owner/repo');

      // uuid-1: 0.7*0.5 + 0.3*0 = 0.35 (equals threshold, included)
      // uuid-2: 0.7*0.3 + 0.3*0 = 0.21 (below threshold, excluded)
      assertEquals(results.length, 1);
      assertEquals(results[0].id, 'uuid-1');
    });

    it('should limit results to maxResults', async () => {
      const vectorData = Array.from({ length: 10 }, (_, i) => ({
        id: `uuid-${i}`,
        similarity: 1 - i * 0.05,
      }));
      const supabase = createMockSupabase(vectorData, []);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService, {
        vectorWeight: 0.7,
        textWeight: 0.3,
        minScore: 0.0,
        maxResults: 3,
      });
      const results = await search.search('test', 'owner/repo');

      assertEquals(results.length, 3);
    });

    it('should sort results by combined score descending', async () => {
      const vectorData = [
        { id: 'uuid-3', similarity: 0.5 },
        { id: 'uuid-1', similarity: 0.9 },
        { id: 'uuid-2', similarity: 0.7 },
      ];
      const supabase = createMockSupabase(vectorData, []);
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService, {
        vectorWeight: 0.7,
        textWeight: 0.3,
        minScore: 0.0,
        maxResults: 10,
      });
      const results = await search.search('test', 'owner/repo');

      assertEquals(results[0].id, 'uuid-1');
      assertEquals(results[1].id, 'uuid-2');
      assertEquals(results[2].id, 'uuid-3');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const supabase = createMockSupabase();
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);
      search.updateConfig({ vectorWeight: 0.6, textWeight: 0.4 });
      const config = search.getConfig();

      assertEquals(config.vectorWeight, 0.6);
      assertEquals(config.textWeight, 0.4);
    });

    it('should throw error if updated weights do not sum to 1', () => {
      const supabase = createMockSupabase();
      const embeddingService = createMockEmbeddingService();

      const search = new HybridSearch(supabase as never, embeddingService);

      assertThrows(
        () => search.updateConfig({ vectorWeight: 0.8 }),
        Error,
        'vectorWeight and textWeight must sum to 1'
      );
    });
  });
});
