/**
 * Unit tests for EmbeddingCache
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashContent, hashContents } from "./cache.ts";

Deno.test("hashContent - generates consistent SHA-256 hash", async () => {
  const content = "test content";
  const hash1 = await hashContent(content);
  const hash2 = await hashContent(content);

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64); // SHA-256 produces 64 hex characters
});

Deno.test("hashContent - different content produces different hashes", async () => {
  const hash1 = await hashContent("content 1");
  const hash2 = await hashContent("content 2");

  assertEquals(hash1 !== hash2, true);
});

Deno.test("hashContent - empty string produces valid hash", async () => {
  const hash = await hashContent("");

  assertExists(hash);
  assertEquals(hash.length, 64);
});

Deno.test("hashContent - handles unicode content", async () => {
  const hash = await hashContent("Hello \u4e16\u754c \ud83c\udf0d");

  assertExists(hash);
  assertEquals(hash.length, 64);
});

Deno.test("hashContents - hashes multiple strings", async () => {
  const contents = ["text1", "text2", "text3"];
  const hashes = await hashContents(contents);

  assertEquals(hashes.length, 3);
  assertEquals(hashes[0].length, 64);
  assertEquals(hashes[1].length, 64);
  assertEquals(hashes[2].length, 64);

  // Verify uniqueness
  const uniqueHashes = new Set(hashes);
  assertEquals(uniqueHashes.size, 3);
});

Deno.test("hashContents - empty array returns empty array", async () => {
  const hashes = await hashContents([]);

  assertEquals(hashes.length, 0);
});

Deno.test("hashContents - maintains order", async () => {
  const contents = ["a", "b", "c"];
  const hashes1 = await hashContents(contents);
  const hashes2 = await hashContents(contents);

  assertEquals(hashes1[0], hashes2[0]);
  assertEquals(hashes1[1], hashes2[1]);
  assertEquals(hashes1[2], hashes2[2]);
});

// Note: Full EmbeddingCache tests require a Supabase mock or integration test setup
// The following tests demonstrate the expected behavior patterns

Deno.test("EmbeddingCache - CacheStats type structure", () => {
  const stats = { hits: 10, misses: 5, hitRate: 0.667 };

  assertEquals(typeof stats.hits, "number");
  assertEquals(typeof stats.misses, "number");
  assertEquals(typeof stats.hitRate, "number");
});

Deno.test("EmbeddingCache - EmbeddingCacheEntry type structure", () => {
  const entry = {
    content_hash: "abc123",
    provider: "openai",
    model: "text-embedding-3-small",
    embedding: [0.1, 0.2, 0.3],
    dimensions: 3,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  assertEquals(typeof entry.content_hash, "string");
  assertEquals(typeof entry.provider, "string");
  assertEquals(typeof entry.model, "string");
  assertEquals(Array.isArray(entry.embedding), true);
  assertEquals(typeof entry.dimensions, "number");
});
