/**
 * SCIP-barrel fixture + displayName invariant tests (design v3 D8/D9,
 * scip-symbol-exclusion Phase 6).
 *
 * D8: `reExportsAll` is populated ONLY by the regex builder, never SCIP —
 * on the SCIP path the universal precondition is vacuous (always passes)
 * but SAFE, because scip-typescript's checker already resolves a
 * barrel-mediated import straight through to the true definition (see
 * `barrel-spike.test.ts`, PR #325 empirical spike): `consumer.ts`'s
 * `imports` contains `impl.ts` directly, and `importSymbols['impl.ts']`
 * carries the SAME raw SCIP symbol ID as `impl.ts`'s `symbolRanges` key
 * for `greet`. This test locks that invariant against the new narrowing
 * path: when `greet` actually changes in `impl.ts`, `consumer.ts` MUST
 * stay included — never wrongly excluded via a vacuous/stale barrel edge.
 *
 * D9: the SAME symbol's displayName MUST be identical at the def-site
 * (`symbolRanges[B]` key) and the use-site (`importSymbols[A][B]` value) —
 * this is what makes exact-set-intersection name-matching sound BY
 * CONSTRUCTION. A future indexer drift that breaks this would silently
 * turn every intersection into a false "no overlap" (wrongly excluded).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChangedSymbolsResult } from './changed-symbols.js';
import { narrowBySymbols } from './narrow-symbols.js';
import { buildGraphFromScip, parseScipIndex } from './scip/builder.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');

function loadFixtureIndex(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('narrowBySymbols — SCIP barrel fixture (D8 invariant lock)', () => {
  it('consumer.ts (imports greet via a direct SCIP-resolved edge to impl.ts) stays INCLUDED when greet changes', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    const graph = buildGraphFromScip(index);

    const implNode = graph.nodes['impl.ts'];
    const consumerNode = graph.nodes['consumer.ts'];
    expect(implNode).toBeDefined();
    expect(consumerNode).toBeDefined();

    const greetSymbolId = Object.keys(implNode?.symbolRanges ?? {}).find((k) =>
      k.includes('greet'),
    );
    expect(greetSymbolId).toBeDefined();

    const changedByFile = new Map<string, ChangedSymbolsResult>([
      [
        'impl.ts',
        {
          changedSymbols: new Set([greetSymbolId as string]),
          hasUnattributedChanges: false,
        },
      ],
    ]);

    const excluded = narrowBySymbols(
      ['consumer.ts', 'index.ts'],
      changedByFile,
      graph,
      'scip',
      new Set(['consumer.ts', 'index.ts', 'impl.ts']),
      new Set(['impl.ts']),
    );

    expect(excluded.has('consumer.ts')).toBe(false);
  });

  it('D9: displayName is IDENTICAL at def-site (symbolRanges key) and use-site (importSymbols value)', () => {
    const index = loadFixtureIndex('scip-ts-barrel-sample');
    const graph = buildGraphFromScip(index);

    const implNode = graph.nodes['impl.ts'];
    const consumerNode = graph.nodes['consumer.ts'];

    const useSiteNames = consumerNode?.importSymbols?.['impl.ts'] ?? [];
    expect(useSiteNames.length).toBeGreaterThan(0);

    for (const name of useSiteNames) {
      expect(Object.keys(implNode?.symbolRanges ?? {})).toContain(name);
    }
  });
});
