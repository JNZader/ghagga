/**
 * Unit tests for dependency graph schema, constants, and validation.
 */

import { describe, expect, it } from 'vitest';
import type { DependencyGraph, GraphMetadata } from './schema.js';
import {
  EXCLUDED_DIRS,
  GRAPH_STALE_DAYS,
  GRAPH_VERSION,
  isGraphStale,
  isTestFile,
  LANGUAGE_EXTENSIONS,
  MAX_BLAST_RADIUS_FILES,
  MAX_GRAPH_SIZE_BYTES,
  TEST_FILE_PATTERNS,
  validateGraph,
  validateMetadata,
} from './schema.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeValidGraph(overrides: Partial<DependencyGraph> = {}): DependencyGraph {
  return {
    version: GRAPH_VERSION,
    rootDir: '.',
    nodes: {
      'src/index.ts': {
        hash: 'abc123',
        language: 'typescript',
        imports: ['./utils.ts'],
        exports: ['main'],
        calls: [{ target: './utils.ts', symbol: 'helper' }],
        isTest: false,
      },
    },
    ...overrides,
  };
}

function makeValidMetadata(overrides: Partial<GraphMetadata> = {}): GraphMetadata {
  return {
    lastIndexedCommit: 'abc123def456',
    lastIndexedAt: new Date().toISOString(),
    schemaVersion: GRAPH_VERSION,
    fileCount: 10,
    languages: ['typescript', 'javascript'],
    indexDurationMs: 1500,
    ...overrides,
  };
}

// ─── isTestFile ─────────────────────────────────────────────────

describe('isTestFile', () => {
  it('detects TypeScript .test.ts files', () => {
    expect(isTestFile('src/utils.test.ts')).toBe(true);
  });

  it('detects TypeScript .spec.ts files', () => {
    expect(isTestFile('src/utils.spec.ts')).toBe(true);
  });

  it('detects JavaScript .test.js files', () => {
    expect(isTestFile('lib/helper.test.js')).toBe(true);
  });

  it('detects JavaScript .spec.jsx files', () => {
    expect(isTestFile('components/Button.spec.jsx')).toBe(true);
  });

  it('detects TSX test files', () => {
    expect(isTestFile('components/App.test.tsx')).toBe(true);
  });

  it('detects Python test files (test_ prefix)', () => {
    expect(isTestFile('tests/test_utils.py')).toBe(true);
  });

  it('detects Go test files (_test.go suffix)', () => {
    expect(isTestFile('pkg/handler_test.go')).toBe(true);
  });

  it('detects Java test files (Test.java suffix)', () => {
    expect(isTestFile('src/test/UserServiceTest.java')).toBe(true);
  });

  it('detects Rust test files (_test.rs suffix)', () => {
    expect(isTestFile('src/parser_test.rs')).toBe(true);
  });

  it('returns false for regular source files', () => {
    expect(isTestFile('src/index.ts')).toBe(false);
    expect(isTestFile('src/utils.ts')).toBe(false);
    expect(isTestFile('main.go')).toBe(false);
    expect(isTestFile('app.py')).toBe(false);
    expect(isTestFile('Service.java')).toBe(false);
  });

  it('returns false for files that contain "test" but not in the pattern', () => {
    expect(isTestFile('src/testUtils.ts')).toBe(false);
    expect(isTestFile('src/test-helpers.ts')).toBe(false);
  });
});

// ─── validateGraph ──────────────────────────────────────────────

describe('validateGraph', () => {
  it('returns a valid DependencyGraph for correct input', () => {
    const graph = makeValidGraph();
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(GRAPH_VERSION);
    expect(result?.rootDir).toBe('.');
    expect(Object.keys(result?.nodes ?? {})).toHaveLength(1);
  });

  it('returns null for null input', () => {
    expect(validateGraph(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(validateGraph(undefined)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(validateGraph('not an object')).toBeNull();
    expect(validateGraph(42)).toBeNull();
    expect(validateGraph(true)).toBeNull();
  });

  it('returns null when version is missing', () => {
    const { version: _, ...rest } = makeValidGraph();
    expect(validateGraph(rest)).toBeNull();
  });

  it('returns null when version does not match GRAPH_VERSION', () => {
    expect(validateGraph(makeValidGraph({ version: 999 }))).toBeNull();
  });

  it('returns null when rootDir is missing', () => {
    const { rootDir: _, ...rest } = makeValidGraph();
    expect(validateGraph(rest)).toBeNull();
  });

  it('returns null when nodes is missing', () => {
    const { nodes: _, ...rest } = makeValidGraph();
    expect(validateGraph(rest)).toBeNull();
  });

  it('returns null when a node has missing fields', () => {
    const graph = makeValidGraph({
      nodes: {
        'bad.ts': {
          hash: 'abc',
          language: 'typescript',
          imports: [],
          // missing exports, calls, isTest
        } as any,
      },
    });
    expect(validateGraph(graph)).toBeNull();
  });

  it('accepts a graph with empty nodes', () => {
    const graph = makeValidGraph({ nodes: {} });
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(Object.keys(result?.nodes ?? {})).toHaveLength(0);
  });

  // ─── importSymbols (additive/optional) ─────────────────────────

  it('accepts a node WITH importSymbols (well-formed Record<string, string[]>)', () => {
    const graph = makeValidGraph({
      nodes: {
        'src/index.ts': {
          hash: 'abc123',
          language: 'typescript',
          imports: ['src/schema.ts'],
          importSymbols: { 'src/schema.ts': ['X', 'Y'] },
          exports: ['main'],
          calls: [],
          isTest: false,
        },
      },
    });
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(result?.nodes['src/index.ts']?.importSymbols).toEqual({
      'src/schema.ts': ['X', 'Y'],
    });
  });

  it('accepts a node WITHOUT importSymbols (absence is always valid)', () => {
    const graph = makeValidGraph(); // makeValidGraph() nodes have no importSymbols
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(result?.nodes['src/index.ts']?.importSymbols).toBeUndefined();
  });

  it('rejects a node where importSymbols is present but not an object', () => {
    const graph = makeValidGraph({
      nodes: {
        'bad.ts': {
          hash: 'abc',
          language: 'typescript',
          imports: [],
          importSymbols: 'not-an-object' as any,
          exports: [],
          calls: [],
          isTest: false,
        },
      },
    });
    expect(validateGraph(graph)).toBeNull();
  });

  it('rejects a node where an importSymbols value is not an array', () => {
    const graph = makeValidGraph({
      nodes: {
        'bad.ts': {
          hash: 'abc',
          language: 'typescript',
          imports: ['other.ts'],
          importSymbols: { 'other.ts': 'X' } as any,
          exports: [],
          calls: [],
          isTest: false,
        },
      },
    });
    expect(validateGraph(graph)).toBeNull();
  });

  // ─── reExportedSymbols / reExportsAll (additive/optional, D3) ───

  it('accepts a node WITH reExportedSymbols and reExportsAll', () => {
    const graph = makeValidGraph({
      nodes: {
        'src/index.ts': {
          hash: 'abc123',
          language: 'typescript',
          imports: ['src/b.ts', 'src/c.ts'],
          exports: [],
          reExportedSymbols: ['X'],
          reExportsAll: ['src/c.ts'],
          calls: [],
          isTest: false,
        },
      },
    });
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(result?.nodes['src/index.ts']?.reExportedSymbols).toEqual(['X']);
    expect(result?.nodes['src/index.ts']?.reExportsAll).toEqual(['src/c.ts']);
  });

  it('accepts a node WITHOUT reExportedSymbols/reExportsAll (absence is always valid — old graphs)', () => {
    const graph = makeValidGraph(); // makeValidGraph() nodes have neither field
    const result = validateGraph(graph);
    expect(result).not.toBeNull();
    expect(result?.nodes['src/index.ts']?.reExportedSymbols).toBeUndefined();
    expect(result?.nodes['src/index.ts']?.reExportsAll).toBeUndefined();
  });

  it('rejects a node where reExportedSymbols is present but not an array', () => {
    const graph = makeValidGraph({
      nodes: {
        'bad.ts': {
          hash: 'abc',
          language: 'typescript',
          imports: [],
          exports: [],
          reExportedSymbols: 'not-an-array' as any,
          calls: [],
          isTest: false,
        },
      },
    });
    expect(validateGraph(graph)).toBeNull();
  });

  it('rejects a node where reExportsAll is present but not an array', () => {
    const graph = makeValidGraph({
      nodes: {
        'bad.ts': {
          hash: 'abc',
          language: 'typescript',
          imports: [],
          exports: [],
          reExportsAll: 'not-an-array' as any,
          calls: [],
          isTest: false,
        },
      },
    });
    expect(validateGraph(graph)).toBeNull();
  });
});

// ─── validateMetadata ───────────────────────────────────────────

describe('validateMetadata', () => {
  it('returns valid GraphMetadata for correct input', () => {
    const meta = makeValidMetadata();
    const result = validateMetadata(meta);
    expect(result).not.toBeNull();
    expect(result?.lastIndexedCommit).toBe('abc123def456');
  });

  it('returns null for null input', () => {
    expect(validateMetadata(null)).toBeNull();
  });

  it('returns null when lastIndexedCommit is missing', () => {
    const { lastIndexedCommit: _, ...rest } = makeValidMetadata();
    expect(validateMetadata(rest)).toBeNull();
  });

  it('returns null when lastIndexedAt is missing', () => {
    const { lastIndexedAt: _, ...rest } = makeValidMetadata();
    expect(validateMetadata(rest)).toBeNull();
  });

  it('returns null when schemaVersion is not a number', () => {
    expect(validateMetadata({ ...makeValidMetadata(), schemaVersion: 'bad' })).toBeNull();
  });

  it('returns null when languages is not an array', () => {
    expect(validateMetadata({ ...makeValidMetadata(), languages: 'ts' })).toBeNull();
  });
});

// ─── isGraphStale ───────────────────────────────────────────────

describe('isGraphStale', () => {
  it('returns false for metadata indexed today', () => {
    const meta = makeValidMetadata({ lastIndexedAt: new Date().toISOString() });
    expect(isGraphStale(meta)).toBe(false);
  });

  it('returns false for metadata indexed 6 days ago', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const meta = makeValidMetadata({ lastIndexedAt: sixDaysAgo.toISOString() });
    expect(isGraphStale(meta)).toBe(false);
  });

  it('returns true for metadata indexed 8 days ago', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const meta = makeValidMetadata({ lastIndexedAt: eightDaysAgo.toISOString() });
    expect(isGraphStale(meta)).toBe(true);
  });

  it('returns true for metadata indexed 30 days ago', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const meta = makeValidMetadata({ lastIndexedAt: thirtyDaysAgo.toISOString() });
    expect(isGraphStale(meta)).toBe(true);
  });
});

// ─── Constants ──────────────────────────────────────────────────

describe('constants', () => {
  it('GRAPH_VERSION is 1', () => {
    expect(GRAPH_VERSION).toBe(1);
  });

  it('MAX_GRAPH_SIZE_BYTES is 20 MB', () => {
    expect(MAX_GRAPH_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });

  it('MAX_BLAST_RADIUS_FILES is 50', () => {
    expect(MAX_BLAST_RADIUS_FILES).toBe(50);
  });

  it('GRAPH_STALE_DAYS is 7', () => {
    expect(GRAPH_STALE_DAYS).toBe(7);
  });

  it('LANGUAGE_EXTENSIONS covers all 9 supported languages', () => {
    const languages = new Set(Object.values(LANGUAGE_EXTENSIONS));
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('java');
    expect(languages).toContain('rust');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('csharp');
    expect(languages).toContain('php');
    expect(languages.size).toBe(9);
  });

  it('EXCLUDED_DIRS includes standard build/dependency directories', () => {
    expect(EXCLUDED_DIRS.has('node_modules')).toBe(true);
    expect(EXCLUDED_DIRS.has('vendor')).toBe(true);
    expect(EXCLUDED_DIRS.has('.git')).toBe(true);
    expect(EXCLUDED_DIRS.has('dist')).toBe(true);
    expect(EXCLUDED_DIRS.has('build')).toBe(true);
  });

  it('EXCLUDED_DIRS includes nested-marker-detection additions (.worktrees, .ghagga, .tools)', () => {
    expect(EXCLUDED_DIRS.has('.worktrees')).toBe(true);
    expect(EXCLUDED_DIRS.has('.ghagga')).toBe(true);
    expect(EXCLUDED_DIRS.has('.tools')).toBe(true);
  });

  it('TEST_FILE_PATTERNS has patterns for all 6 languages', () => {
    // Each language has at least one test pattern
    expect(TEST_FILE_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });
});

// ─── Union Coverage (D3) ──────────────────────────────────────────

describe('SupportedLanguage union coverage', () => {
  it('SupportedLanguage = RegexSupportedLanguage ∪ SCIP_ONLY_LANGUAGES (runtime assertion)', async () => {
    // Runtime proxy for the compile-time union equality: every member of
    // RegexSupportedLanguage plus SCIP_ONLY_LANGUAGES must cover exactly the
    // same set as the languages actually usable across the codebase (spot
    // checked via LANGUAGE_EXTENSIONS + SCIP_ONLY_LANGUAGES export).
    const { SCIP_ONLY_LANGUAGES, REGEX_SUPPORTED_LANGUAGES } = await import('./schema.js');
    const union = new Set<string>([...REGEX_SUPPORTED_LANGUAGES, ...SCIP_ONLY_LANGUAGES]);
    const allLanguages = new Set(Object.values(LANGUAGE_EXTENSIONS));
    expect(union).toEqual(allLanguages);
  });

  it('SCIP_ONLY_LANGUAGES contains kotlin, csharp, php', async () => {
    const { SCIP_ONLY_LANGUAGES } = await import('./schema.js');
    expect(new Set(SCIP_ONLY_LANGUAGES)).toEqual(new Set(['kotlin', 'csharp', 'php']));
  });
});
