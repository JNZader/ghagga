/**
 * Unit tests for EmbeddingService
 */

import {
  assertEquals,
  assertRejects,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  stub,
  returnsNext,
  Stub,
} from "https://deno.land/std@0.208.0/testing/mock.ts";
import { EmbeddingService, type EmbeddingServiceConfig } from "./service.ts";

// Mock response helpers
function createOpenAIResponse(embedding: number[], model: string = "text-embedding-3-small") {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{ object: "embedding", embedding, index: 0 }],
      model,
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createOpenAIBatchResponse(
  embeddings: number[][],
  model: string = "text-embedding-3-small"
) {
  return new Response(
    JSON.stringify({
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model,
      usage: { prompt_tokens: 10 * embeddings.length, total_tokens: 10 * embeddings.length },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createGeminiResponse(embedding: number[]) {
  return new Response(
    JSON.stringify({
      embedding: { values: embedding },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createGeminiBatchResponse(embeddings: number[][]) {
  return new Response(
    JSON.stringify({
      embeddings: embeddings.map((values) => ({ values })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createErrorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("EmbeddingService - embed() with OpenAI", async () => {
  const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createOpenAIResponse(mockEmbedding))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "openai",
      fallback: "none",
      model: "text-embedding-3-small",
      openaiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const result = await service.embed("test text");

    assertEquals(result.embedding, mockEmbedding);
    assertEquals(result.provider, "openai");
    assertEquals(result.dimensions, 5);
    assertExists(result.usage);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embed() with Gemini", async () => {
  const mockEmbedding = [0.1, 0.2, 0.3];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createGeminiResponse(mockEmbedding))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "gemini",
      fallback: "none",
      model: "text-embedding-004",
      geminiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const result = await service.embed("test text");

    assertEquals(result.embedding, mockEmbedding);
    assertEquals(result.provider, "gemini");
    assertEquals(result.dimensions, 3);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embed() with fallback on error", async () => {
  const mockEmbedding = [0.1, 0.2, 0.3];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([
      Promise.resolve(createErrorResponse(500, "OpenAI error")),
      Promise.resolve(createGeminiResponse(mockEmbedding)),
    ])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "openai",
      fallback: "gemini",
      model: "text-embedding-3-small",
      openaiApiKey: "test-key",
      geminiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const result = await service.embed("test text");

    assertEquals(result.embedding, mockEmbedding);
    assertEquals(result.provider, "gemini");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embed() throws when no fallback", async () => {
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createErrorResponse(500, "OpenAI error"))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "openai",
      fallback: "none",
      model: "text-embedding-3-small",
      openaiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    await assertRejects(
      () => service.embed("test text"),
      Error,
      "OpenAI embedding failed"
    );
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embedBatch() with OpenAI", async () => {
  const mockEmbeddings = [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
    [0.7, 0.8, 0.9],
  ];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createOpenAIBatchResponse(mockEmbeddings))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "openai",
      fallback: "none",
      model: "text-embedding-3-small",
      openaiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const results = await service.embedBatch(["text1", "text2", "text3"]);

    assertEquals(results.length, 3);
    assertEquals(results[0].embedding, mockEmbeddings[0]);
    assertEquals(results[1].embedding, mockEmbeddings[1]);
    assertEquals(results[2].embedding, mockEmbeddings[2]);
    assertEquals(results[0].provider, "openai");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embedBatch() with Gemini", async () => {
  const mockEmbeddings = [
    [0.1, 0.2],
    [0.3, 0.4],
  ];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createGeminiBatchResponse(mockEmbeddings))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "gemini",
      fallback: "none",
      model: "text-embedding-004",
      geminiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const results = await service.embedBatch(["text1", "text2"]);

    assertEquals(results.length, 2);
    assertEquals(results[0].embedding, mockEmbeddings[0]);
    assertEquals(results[1].embedding, mockEmbeddings[1]);
    assertEquals(results[0].provider, "gemini");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - embedBatch() empty array", async () => {
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    fallback: "none",
    model: "text-embedding-3-small",
    openaiApiKey: "test-key",
  };

  const service = new EmbeddingService(config);
  const results = await service.embedBatch([]);

  assertEquals(results.length, 0);
});

Deno.test("EmbeddingService - auto provider selects OpenAI first", async () => {
  const mockEmbedding = [0.1, 0.2, 0.3];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createOpenAIResponse(mockEmbedding))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "auto",
      fallback: "none",
      model: "text-embedding-3-small",
      openaiApiKey: "test-key",
      geminiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const result = await service.embed("test text");

    assertEquals(result.provider, "openai");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - auto provider falls back to Gemini", async () => {
  const mockEmbedding = [0.1, 0.2, 0.3];
  const fetchStub: Stub<typeof globalThis, Parameters<typeof fetch>, ReturnType<typeof fetch>> = stub(
    globalThis,
    "fetch",
    returnsNext([Promise.resolve(createGeminiResponse(mockEmbedding))])
  );

  try {
    const config: EmbeddingServiceConfig = {
      provider: "auto",
      fallback: "none",
      model: "text-embedding-004",
      geminiApiKey: "test-key",
    };

    const service = new EmbeddingService(config);
    const result = await service.embed("test text");

    assertEquals(result.provider, "gemini");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("EmbeddingService - throws when no API key for auto", async () => {
  const config: EmbeddingServiceConfig = {
    provider: "auto",
    fallback: "none",
    model: "text-embedding-3-small",
  };

  const service = new EmbeddingService(config);
  await assertRejects(
    () => service.embed("test text"),
    Error,
    "No API key available"
  );
});

Deno.test("EmbeddingService - getExpectedDimensions returns config value", () => {
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    fallback: "none",
    model: "text-embedding-3-small",
    dimensions: 512,
  };

  const service = new EmbeddingService(config);
  assertEquals(service.getExpectedDimensions(), 512);
});

Deno.test("EmbeddingService - getExpectedDimensions returns model default", () => {
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    fallback: "none",
    model: "text-embedding-3-small",
  };

  const service = new EmbeddingService(config);
  assertEquals(service.getExpectedDimensions(), 1536);
});

Deno.test("EmbeddingService - getConfig returns copy", () => {
  const config: EmbeddingServiceConfig = {
    provider: "openai",
    fallback: "gemini",
    model: "text-embedding-3-small",
    openaiApiKey: "test-key",
  };

  const service = new EmbeddingService(config);
  const returnedConfig = service.getConfig();

  assertEquals(returnedConfig.provider, "openai");
  assertEquals(returnedConfig.fallback, "gemini");
});
