/**
 * Graph Loaders
 *
 * Implementations of the GraphLoader interface for different environments:
 * - GitHubApiGraphLoader: fetches from ghagga/graph orphan branch via GitHub API
 * - NullGraphLoader: always returns null (used when blast-radius is disabled)
 * - PreloadedGraphLoader: wraps an already-fetched graph (used by SaaS for early fetch)
 */

import {
  type DependencyGraph,
  type GraphLoader,
  type GraphMetadata,
  validateGraph,
  validateMetadata,
} from './schema.js';

// ─── GitHub API Graph Loader ────────────────────────────────────

/**
 * Fetches the dependency graph from a GitHub repository's ghagga/graph orphan branch.
 *
 * Uses the GitHub Contents API with `Accept: application/vnd.github.raw` to get
 * the raw JSON without base64 encoding.
 */
export class GitHubApiGraphLoader implements GraphLoader {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
  ) {}

  async load(): Promise<DependencyGraph | null> {
    try {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/.ghagga/graph.json?ref=ghagga/graph`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (response.status === 404) return null;
      if (!response.ok) return null;

      const json: unknown = await response.json();
      return validateGraph(json);
    } catch {
      // Network error, timeout, parse error — all return null
      return null;
    }
  }

  async loadMetadata(): Promise<GraphMetadata | null> {
    try {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/.ghagga/metadata.json?ref=ghagga/graph`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (response.status === 404) return null;
      if (!response.ok) return null;

      const json: unknown = await response.json();
      return validateMetadata(json);
    } catch {
      return null;
    }
  }
}

// ─── Null Graph Loader ──────────────────────────────────────────

/**
 * A no-op loader that always returns null.
 * Used when blast-radius is disabled or no graph source is available.
 */
export class NullGraphLoader implements GraphLoader {
  async load(): Promise<DependencyGraph | null> {
    return null;
  }

  async loadMetadata(): Promise<GraphMetadata | null> {
    return null;
  }
}

// ─── Preloaded Graph Loader ─────────────────────────────────────

/**
 * A loader that wraps a pre-fetched graph and optional metadata.
 * Used by the SaaS server when the graph is fetched early (before pipeline).
 */
export class PreloadedGraphLoader implements GraphLoader {
  constructor(
    private readonly graph: DependencyGraph,
    private readonly metadata?: GraphMetadata | null,
  ) {}

  async load(): Promise<DependencyGraph | null> {
    return this.graph;
  }

  async loadMetadata(): Promise<GraphMetadata | null> {
    return this.metadata ?? null;
  }
}
