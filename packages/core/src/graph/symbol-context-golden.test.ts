/**
 * Golden test — anti-no-op gate for symbol-precise-context (Phase 6).
 *
 * Proves end-to-end that the new `importSymbols` field is actually
 * differentiating, not silently dead weight from a keying mismatch
 * between Slice 1 (the builders write resolved-path keys) and Slice 2
 * (`buildCallChainContext` reads the SAME resolved-path keys).
 *
 * Uses a FAITHFUL — but self-contained, deterministic — mirror of the
 * real `schema.ts` / `loader.ts` / `extractors/types.ts` /
 * `extractors/index.ts` shape: `extractors/types.ts` and
 * `extractors/index.ts` only reference the `SupportedLanguage` TYPE from
 * `schema.ts`, while `loader.ts` references the `MAX_GRAPH_SIZE_BYTES`
 * CONSTANT. A diff touching only `MAX_GRAPH_SIZE_BYTES` must flag
 * `loader.ts` as impacted and must NOT claim `MAX_GRAPH_SIZE_BYTES`
 * impacts `extractors/types.ts`/`extractors/index.ts` — and vice versa
 * for a `SupportedLanguage`-only diff.
 *
 * If this test cannot be made to pass, the keying is wrong (a silent
 * no-op) — per the task spec this is a MERGE BLOCKER, not a flaky test.
 */

import { describe, expect, it } from 'vitest';
import { buildCallChainContext } from '../pipeline/prepare-graph.js';
import type { ReviewInput } from '../types.js';
import { buildGraph } from './builder.js';

// ─── Faithful fixture mirroring the real graph module shape ───────

const SCHEMA_TS = `
export type SupportedLanguage = 'typescript' | 'javascript' | 'go';

export const GRAPH_VERSION = 1;

export const MAX_GRAPH_SIZE_BYTES = 20 * 1024 * 1024;
`;

const LOADER_TS = `
import { MAX_GRAPH_SIZE_BYTES } from './schema.js';

export function checkGraphSize(bytes: number): boolean {
  return bytes <= MAX_GRAPH_SIZE_BYTES;
}
`;

const EXTRACTORS_TYPES_TS = `
import type { SupportedLanguage } from '../schema.js';

export interface Extractor {
  language: SupportedLanguage;
}
`;

const EXTRACTORS_INDEX_TS = `
import type { SupportedLanguage } from '../schema.js';

export function getExtractor(lang: SupportedLanguage): undefined {
  return undefined;
}
`;

function buildFixtureGraph() {
  const files = new Map<string, string>([
    ['src/graph/schema.ts', SCHEMA_TS],
    ['src/graph/loader.ts', LOADER_TS],
    ['src/graph/extractors/types.ts', EXTRACTORS_TYPES_TS],
    ['src/graph/extractors/index.ts', EXTRACTORS_INDEX_TS],
  ]);
  return buildGraph('.', files);
}

function makeInput(): ReviewInput {
  return {
    diff: '',
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-api-key',
    settings: {
      enableSemgrep: false,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'normal',
      enableBlastRadius: true,
    },
  };
}

const NOOP_EMIT = () => {};

// ─── Slice 1: importSymbols keying (write-path proof) ──────────────

describe('golden: symbol-precise-context — Slice 1 keying (write-path proof)', () => {
  it('extractors/types.ts records ONLY SupportedLanguage for schema.ts — NOT MAX_GRAPH_SIZE_BYTES', () => {
    const graph = buildFixtureGraph();
    const typesNode = graph.nodes['src/graph/extractors/types.ts'];
    expect(typesNode?.imports).toContain('src/graph/schema.ts');
    const symbols = typesNode?.importSymbols?.['src/graph/schema.ts'];
    expect(symbols).toEqual(['SupportedLanguage']);
    expect(symbols).not.toContain('MAX_GRAPH_SIZE_BYTES');
  });

  it('extractors/index.ts records ONLY SupportedLanguage for schema.ts — NOT MAX_GRAPH_SIZE_BYTES', () => {
    const graph = buildFixtureGraph();
    const indexNode = graph.nodes['src/graph/extractors/index.ts'];
    const symbols = indexNode?.importSymbols?.['src/graph/schema.ts'];
    expect(symbols).toEqual(['SupportedLanguage']);
    expect(symbols).not.toContain('MAX_GRAPH_SIZE_BYTES');
  });

  it('loader.ts records MAX_GRAPH_SIZE_BYTES for schema.ts', () => {
    const graph = buildFixtureGraph();
    const loaderNode = graph.nodes['src/graph/loader.ts'];
    expect(loaderNode?.imports).toContain('src/graph/schema.ts');
    const symbols = loaderNode?.importSymbols?.['src/graph/schema.ts'];
    expect(symbols).toEqual(['MAX_GRAPH_SIZE_BYTES']);
  });
});

// ─── Slice 2: end-to-end differentiation (read-path proof) ─────────

describe('golden: symbol-precise-context — Slice 2 end-to-end differentiation (THE anti-no-op gate)', () => {
  it('a MAX_GRAPH_SIZE_BYTES-only diff flags loader.ts as impacted and does NOT flag extractors/types.ts or extractors/index.ts', async () => {
    const graph = buildFixtureGraph();

    // Hunk context omits "export" here purely for fixture brevity — the
    // parser handles export-prefixed hunk contexts correctly (see the
    // "changed line" tests in call-chain.test.ts).
    const diff = `
--- a/src/graph/schema.ts
+++ b/src/graph/schema.ts
@@ -5,1 +5,1 @@ const MAX_GRAPH_SIZE_BYTES
-export const MAX_GRAPH_SIZE_BYTES = 20 * 1024 * 1024;
+export const MAX_GRAPH_SIZE_BYTES = 25 * 1024 * 1024;
`;

    const context = await buildCallChainContext({
      input: makeInput(),
      emit: NOOP_EMIT,
      failedSteps: [],
      warnOnlyDegradations: [],
      fileList: ['src/graph/schema.ts'],
      filteredDiff: diff,
      graph,
    });

    expect(context).toContain('## Symbol Impact');

    // loader.ts IS flagged: its used symbol (MAX_GRAPH_SIZE_BYTES) is
    // exactly the one the diff changed.
    const loaderLine = context.split('\n').find((l) => l.includes('src/graph/loader.ts'));
    expect(loaderLine).toBeDefined();
    expect(loaderLine).toContain('changed: MAX_GRAPH_SIZE_BYTES');

    // extractors/types.ts and extractors/index.ts are NOT flagged as
    // impacted: they use SupportedLanguage, which the diff did not touch.
    const typesLine = context.split('\n').find((l) => l.includes('src/graph/extractors/types.ts'));
    const indexLine = context.split('\n').find((l) => l.includes('src/graph/extractors/index.ts'));
    expect(typesLine).toBeDefined();
    expect(indexLine).toBeDefined();
    expect(typesLine).not.toContain('MAX_GRAPH_SIZE_BYTES');
    expect(indexLine).not.toContain('MAX_GRAPH_SIZE_BYTES');
    expect(typesLine).toContain('none of the used symbols');
    expect(indexLine).toContain('none of the used symbols');
  });

  it('the INVERSE case: a SupportedLanguage-only diff flags extractors/types.ts and extractors/index.ts, NOT loader.ts (proves bidirectional differentiation, not a one-way fluke)', async () => {
    const graph = buildFixtureGraph();

    const diff = `
--- a/src/graph/schema.ts
+++ b/src/graph/schema.ts
@@ -1,1 +1,1 @@ SupportedLanguage
-export type SupportedLanguage = 'typescript' | 'javascript' | 'go';
+export type SupportedLanguage = 'typescript' | 'javascript' | 'go' | 'python';
`;

    const context = await buildCallChainContext({
      input: makeInput(),
      emit: NOOP_EMIT,
      failedSteps: [],
      warnOnlyDegradations: [],
      fileList: ['src/graph/schema.ts'],
      filteredDiff: diff,
      graph,
    });

    const loaderLine = context.split('\n').find((l) => l.includes('src/graph/loader.ts'));
    const typesLine = context.split('\n').find((l) => l.includes('src/graph/extractors/types.ts'));
    const indexLine = context.split('\n').find((l) => l.includes('src/graph/extractors/index.ts'));

    expect(typesLine).toContain('changed: SupportedLanguage');
    expect(indexLine).toContain('changed: SupportedLanguage');
    expect(loaderLine).toContain('none of the used symbols');
    expect(loaderLine).not.toContain('changed: SupportedLanguage');
  });
});
