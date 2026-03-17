/**
 * Unit tests for graph loaders.
 *
 * Tests GitHubApiGraphLoader with mocked fetch, NullGraphLoader,
 * and PreloadedGraphLoader.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiGraphLoader, NullGraphLoader, PreloadedGraphLoader } from './loader.js';
import type { DependencyGraph, GraphMetadata } from './schema.js';
import { GRAPH_VERSION } from './schema.js';

// ─── Test Fixtures ──────────────────────────────────────────────

const VALID_GRAPH: DependencyGraph = {
  version: GRAPH_VERSION,
  rootDir: '.',
  nodes: {
    'src/index.ts': {
      hash: 'abc123',
      language: 'typescript',
      imports: [],
      exports: ['main'],
      calls: [],
      isTest: false,
    },
  },
};

const VALID_METADATA: GraphMetadata = {
  lastIndexedCommit: 'abc123def456',
  lastIndexedAt: new Date().toISOString(),
  schemaVersion: GRAPH_VERSION,
  fileCount: 1,
  languages: ['typescript'],
  indexDurationMs: 500,
};

// ─── GitHubApiGraphLoader ───────────────────────────────────────

describe('GitHubApiGraphLoader', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('load()', () => {
    it('returns DependencyGraph on 200 with valid JSON', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(VALID_GRAPH), { status: 200 }),
      );

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(GRAPH_VERSION);
      expect(result?.nodes['src/index.ts']).toBeDefined();
    });

    it('sends correct URL and headers', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(VALID_GRAPH), { status: 200 }),
      );

      const loader = new GitHubApiGraphLoader('myorg', 'myrepo', 'gh_token123');
      await loader.load();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/myorg/myrepo/contents/.ghagga/graph.json?ref=ghagga/graph',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer gh_token123',
            Accept: 'application/vnd.github.raw',
          }),
        }),
      );
    });

    it('returns null on 404', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Not Found', { status: 404 }));

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('returns null on 500', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network timeout'));

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('returns null on invalid JSON response', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('not json {{{', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      );

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('returns null when graph has wrong version', async () => {
      const badGraph = { ...VALID_GRAPH, version: 999 };
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(badGraph), { status: 200 }),
      );

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.load();

      expect(result).toBeNull();
    });
  });

  describe('loadMetadata()', () => {
    it('returns GraphMetadata on 200 with valid JSON', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(VALID_METADATA), { status: 200 }),
      );

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.loadMetadata();

      expect(result).not.toBeNull();
      expect(result?.lastIndexedCommit).toBe('abc123def456');
    });

    it('returns null on 404', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response('Not Found', { status: 404 }));

      const loader = new GitHubApiGraphLoader('owner', 'repo', 'token');
      const result = await loader.loadMetadata();

      expect(result).toBeNull();
    });
  });
});

// ─── NullGraphLoader ────────────────────────────────────────────

describe('NullGraphLoader', () => {
  it('load() always returns null', async () => {
    const loader = new NullGraphLoader();
    expect(await loader.load()).toBeNull();
  });

  it('loadMetadata() always returns null', async () => {
    const loader = new NullGraphLoader();
    expect(await loader.loadMetadata()).toBeNull();
  });
});

// ─── PreloadedGraphLoader ───────────────────────────────────────

describe('PreloadedGraphLoader', () => {
  it('load() returns the preloaded graph', async () => {
    const loader = new PreloadedGraphLoader(VALID_GRAPH);
    const result = await loader.load();

    expect(result).toBe(VALID_GRAPH);
  });

  it('loadMetadata() returns the preloaded metadata', async () => {
    const loader = new PreloadedGraphLoader(VALID_GRAPH, VALID_METADATA);
    const result = await loader.loadMetadata();

    expect(result).toBe(VALID_METADATA);
  });

  it('loadMetadata() returns null when no metadata provided', async () => {
    const loader = new PreloadedGraphLoader(VALID_GRAPH);
    const result = await loader.loadMetadata();

    expect(result).toBeNull();
  });
});
