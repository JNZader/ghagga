/**
 * Unit tests for graph loaders.
 *
 * Tests GitHubApiGraphLoader with mocked fetch, NullGraphLoader,
 * PreloadedGraphLoader, and FilesystemGraphLoader.
 *
 * FilesystemGraphLoader is tested against a REAL temp dir (mkdtempSync) —
 * NOT mocked fs — so its actual statSync/readFileSync path is exercised
 * (hardened pattern: a mock must never paper over production read/parse
 * behavior).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FilesystemGraphLoader,
  GitHubApiGraphLoader,
  NullGraphLoader,
  PreloadedGraphLoader,
} from './loader.js';
import type { DependencyGraph, GraphMetadata } from './schema.js';
import { GRAPH_VERSION, MAX_GRAPH_SIZE_BYTES } from './schema.js';

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

// ─── FilesystemGraphLoader ──────────────────────────────────────

describe('FilesystemGraphLoader', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ghagga-fs-graph-loader-'));
    mkdirSync(join(repoRoot, '.ghagga'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeGraphFile(content: string): void {
    writeFileSync(join(repoRoot, '.ghagga', 'graph.json'), content);
  }

  function writeMetadataFile(content: string): void {
    writeFileSync(join(repoRoot, '.ghagga', 'metadata.json'), content);
  }

  describe('load()', () => {
    it('returns the DependencyGraph when graph.json is valid', async () => {
      writeGraphFile(JSON.stringify(VALID_GRAPH));

      const loader = new FilesystemGraphLoader(repoRoot);
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(GRAPH_VERSION);
      expect(result?.nodes['src/index.ts']).toBeDefined();
    });

    it('returns null when graph.json is absent (no callbacks fired)', async () => {
      const onOversize = vi.fn();
      const onMalformed = vi.fn();

      const loader = new FilesystemGraphLoader(repoRoot, { onOversize, onMalformed });
      const result = await loader.load();

      expect(result).toBeNull();
      expect(onOversize).not.toHaveBeenCalled();
      expect(onMalformed).not.toHaveBeenCalled();
    });

    it('returns null and calls onMalformed when graph.json fails JSON.parse', async () => {
      writeGraphFile('not json {{{');
      const onMalformed = vi.fn();

      const loader = new FilesystemGraphLoader(repoRoot, { onMalformed });
      const result = await loader.load();

      expect(result).toBeNull();
      expect(onMalformed).toHaveBeenCalledTimes(1);
      expect(onMalformed).toHaveBeenCalledWith(expect.any(String));
    });

    it('returns null and calls onMalformed when graph.json fails validateGraph (wrong version)', async () => {
      writeGraphFile(JSON.stringify({ ...VALID_GRAPH, version: 999 }));
      const onMalformed = vi.fn();

      const loader = new FilesystemGraphLoader(repoRoot, { onMalformed });
      const result = await loader.load();

      expect(result).toBeNull();
      expect(onMalformed).toHaveBeenCalledTimes(1);
    });

    it('returns null and calls onOversize (distinct from onMalformed) when graph.json exceeds MAX_GRAPH_SIZE_BYTES', async () => {
      // Write a well-formed-but-oversized graph.json by padding a string field.
      const bigGraph = {
        ...VALID_GRAPH,
        rootDir: '.'.padEnd(MAX_GRAPH_SIZE_BYTES + 1024, 'x'),
      };
      writeGraphFile(JSON.stringify(bigGraph));
      const onOversize = vi.fn();
      const onMalformed = vi.fn();

      const loader = new FilesystemGraphLoader(repoRoot, { onOversize, onMalformed });
      const result = await loader.load();

      expect(result).toBeNull();
      expect(onOversize).toHaveBeenCalledTimes(1);
      expect(onOversize).toHaveBeenCalledWith(expect.any(Number), MAX_GRAPH_SIZE_BYTES);
      expect(onMalformed).not.toHaveBeenCalled();
    });

    it('does not throw when no callbacks are supplied (malformed graph)', async () => {
      writeGraphFile('not json {{{');
      const loader = new FilesystemGraphLoader(repoRoot);
      await expect(loader.load()).resolves.toBeNull();
    });
  });

  describe('loadMetadata()', () => {
    it('returns GraphMetadata when metadata.json is valid', async () => {
      writeMetadataFile(JSON.stringify(VALID_METADATA));

      const loader = new FilesystemGraphLoader(repoRoot);
      const result = await loader.loadMetadata();

      expect(result).not.toBeNull();
      expect(result?.lastIndexedCommit).toBe('abc123def456');
    });

    it('returns null when metadata.json is absent', async () => {
      const loader = new FilesystemGraphLoader(repoRoot);
      const result = await loader.loadMetadata();

      expect(result).toBeNull();
    });

    it('returns null when metadata.json is malformed (no throw)', async () => {
      writeMetadataFile('not json {{{');

      const loader = new FilesystemGraphLoader(repoRoot);
      await expect(loader.loadMetadata()).resolves.toBeNull();
    });

    it('returns null when metadata.json fails validateMetadata', async () => {
      writeMetadataFile(JSON.stringify({ foo: 'bar' }));

      const loader = new FilesystemGraphLoader(repoRoot);
      const result = await loader.loadMetadata();

      expect(result).toBeNull();
    });
  });
});
