/**
 * D5 spike — empirical verdict for whether scip-typescript is immune to
 * the barrel-mediated blast-radius false-negative that the regex extractor
 * had (see extractors/typescript.ts, D1/D2).
 *
 * Fixture (test/fixtures/scip-ts-barrel-sample/): `impl.ts` defines
 * `greet`; `index.ts` re-exports it (`export { greet } from './impl'`);
 * `consumer.ts` imports `greet` via the barrel (`import { greet } from
 * './index'`) — never directly from `impl.ts`.
 *
 * Captured with `scip-typescript index --cwd . --infer-tsconfig --output
 * index.scip` (scip-typescript 0.4.0) and committed as a real `index.scip`,
 * same pattern as the other scip/*-sample fixtures (mature-langs.test.ts).
 *
 * VERDICT (recorded 2026-07-15): scip-typescript is IMMUNE. `consumer.ts`'s
 * `node.imports` resolves BOTH to `index.ts` (the module specifier) AND
 * directly to `impl.ts` (the true defining symbol — TypeScript's checker
 * resolves the re-exported `greet` reference straight through the barrel
 * to its original declaration). Because the edge to `impl.ts` already
 * exists, `buildReverseIndex`/`computeBlastRadius` already flag
 * `consumer.ts` when `impl.ts` changes, with ZERO barrel-specific guard
 * needed in the SCIP path. This is the opposite of the regex extractor,
 * which (pre-fix) produced no edge at all for the re-export line.
 *
 * No follow-up ticket filed — BL-SCIP-BARREL-GUARD is NOT needed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');

function loadFixtureIndex(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('buildGraphFromScip — barrel re-export spike (D5 verdict)', () => {
  it('parses the real scip-typescript barrel fixture into an Index with 3 documents', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    expect(index.documents).toHaveLength(3);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['consumer.ts', 'impl.ts', 'index.ts']);
  });

  it('VERDICT: consumer.ts resolves directly to impl.ts (the true definition), not just index.ts — SCIP is immune', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    const graph = buildGraphFromScip(index);

    const consumerNode = graph.nodes['consumer.ts'];
    expect(consumerNode).toBeDefined();
    expect(consumerNode?.language).toBe('typescript');

    // The empirical finding: scip-typescript's checker resolves the
    // re-exported `greet` reference through the barrel to its ORIGINAL
    // declaration in impl.ts, so the edge exists independent of the
    // barrel. blast-radius therefore already sees consumer.ts as a
    // dependent of impl.ts with no extra guard required.
    expect(consumerNode?.imports).toContain('impl.ts');
  });

  it('also records the module-specifier edge to the barrel itself (index.ts)', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    const graph = buildGraphFromScip(index);

    const consumerNode = graph.nodes['consumer.ts'];
    expect(consumerNode?.imports).toContain('index.ts');
  });

  it('index.ts (the barrel) itself has an edge to impl.ts', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    const graph = buildGraphFromScip(index);

    const indexNode = graph.nodes['index.ts'];
    expect(indexNode).toBeDefined();
    expect(indexNode?.imports).toContain('impl.ts');
  });
});
