/**
 * Embedding Cache - Caches embeddings to reduce API calls
 *
 * Uses content hash to identify cached embeddings, keyed by provider and model.
 */

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Cache entry structure
export interface EmbeddingCacheEntry {
  content_hash: string;
  provider: string;
  model: string;
  embedding: number[];
  dimensions: number;
  created_at: string;
  updated_at: string;
}

// Cache statistics
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
}

export class EmbeddingCache {
  private supabase: SupabaseClient;
  private tableName: string;
  private stats: CacheStats;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    tableName: string = "embedding_cache",
  ) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.tableName = tableName;
    this.stats = { hits: 0, misses: 0, hitRate: 0 };
  }

  /**
   * Create cache instance from environment variables
   */
  static fromEnv(tableName: string = "embedding_cache"): EmbeddingCache {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY",
      );
    }

    return new EmbeddingCache(supabaseUrl, supabaseKey, tableName);
  }

  /**
   * Get cached embedding by content hash
   */
  async get(
    contentHash: string,
    provider: string,
    model: string,
  ): Promise<number[] | null> {
    const { data, error } = await this.supabase
      .from(this.tableName)
      .select("embedding")
      .eq("content_hash", contentHash)
      .eq("provider", provider)
      .eq("model", model)
      .single();

    if (error || !data) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    this.stats.hits++;
    this.updateHitRate();
    return data.embedding;
  }

  /**
   * Store embedding in cache
   */
  async set(
    contentHash: string,
    provider: string,
    model: string,
    embedding: number[],
  ): Promise<void> {
    const { error } = await this.supabase.from(this.tableName).upsert(
      {
        content_hash: contentHash,
        provider,
        model,
        embedding,
        dimensions: embedding.length,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "content_hash,provider,model",
      },
    );

    if (error) {
      console.error("Failed to cache embedding:", error.message);
    }
  }

  /**
   * Get multiple cached embeddings at once
   */
  async getMany(
    contentHashes: string[],
    provider: string,
    model: string,
  ): Promise<Map<string, number[]>> {
    if (contentHashes.length === 0) {
      return new Map();
    }

    const { data, error } = await this.supabase
      .from(this.tableName)
      .select("content_hash, embedding")
      .eq("provider", provider)
      .eq("model", model)
      .in("content_hash", contentHashes);

    const result = new Map<string, number[]>();

    if (error || !data) {
      this.stats.misses += contentHashes.length;
      this.updateHitRate();
      return result;
    }

    for (const row of data) {
      result.set(row.content_hash, row.embedding);
    }

    this.stats.hits += result.size;
    this.stats.misses += contentHashes.length - result.size;
    this.updateHitRate();

    return result;
  }

  /**
   * Store multiple embeddings at once
   */
  async setMany(
    entries: Array<{
      contentHash: string;
      provider: string;
      model: string;
      embedding: number[];
    }>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const records = entries.map((entry) => ({
      content_hash: entry.contentHash,
      provider: entry.provider,
      model: entry.model,
      embedding: entry.embedding,
      dimensions: entry.embedding.length,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await this.supabase.from(this.tableName).upsert(records, {
      onConflict: "content_hash,provider,model",
    });

    if (error) {
      console.error("Failed to cache embeddings:", error.message);
    }
  }

  /**
   * Delete cached embedding
   */
  async delete(
    contentHash: string,
    provider: string,
    model: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from(this.tableName)
      .delete()
      .eq("content_hash", contentHash)
      .eq("provider", provider)
      .eq("model", model);

    if (error) {
      console.error("Failed to delete cached embedding:", error.message);
    }
  }

  /**
   * Clear all cached embeddings for a specific provider/model
   */
  async clearProvider(provider: string, model?: string): Promise<number> {
    let query = this.supabase
      .from(this.tableName)
      .delete()
      .eq("provider", provider);

    if (model) {
      query = query.eq("model", model);
    }

    const { error, count } = await query.select("*", { count: "exact" });

    if (error) {
      console.error("Failed to clear cache:", error.message);
      return 0;
    }

    return count ?? 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, hitRate: 0 };
  }

  /**
   * Update hit rate calculation
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

/**
 * Generate a content hash for caching
 * Uses a simple but effective hash for text content
 */
export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate hash for multiple content strings (for batch operations)
 */
export async function hashContents(contents: string[]): Promise<string[]> {
  return Promise.all(contents.map(hashContent));
}
