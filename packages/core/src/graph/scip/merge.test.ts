/**
 * Unit tests for mergeScipIndexes() (D4).
 *
 * Pure merge of parsed SCIP `Index.documents` from 2+ indexers into one
 * `Index`, ahead of a single `buildGraphFromScip` call. Kept separate from
 * the dispatcher tests (index-cmd.test.ts), which mock `run`/`toolchainCheck`
 * and only assert the merge is *wired*, not its internal correctness.
 */

import { create } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, MetadataSchema } from '@scip-code/scip';
import { describe, expect, it } from 'vitest';
import { mergeScipIndexes } from './merge.js';

function doc(relativePath: string, language: string) {
  return create(DocumentSchema, { relativePath, language, symbols: [], occurrences: [] });
}

describe('mergeScipIndexes', () => {
  it('passes a single index through unchanged (documents + metadata)', () => {
    const index = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.go', 'go')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([index]);

    expect(merged.documents).toHaveLength(1);
    expect(merged.documents[0]?.relativePath).toBe('main.go');
    expect(merged.metadata?.projectRoot).toBe('/repo');
    expect(duplicatePaths).toEqual([]);
  });

  it('merges two disjoint indexes into one, concatenating documents', () => {
    const goIndex = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.go', 'go'), doc('pkg/greeting.go', 'go')],
    });
    const tsIndex = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('src/index.ts', 'typescript')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([goIndex, tsIndex]);

    const paths = merged.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['main.go', 'pkg/greeting.go', 'src/index.ts']);
    expect(duplicatePaths).toEqual([]);
  });

  it('keeps the first index metadata when merging (documents-only merge)', () => {
    const first = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo-first' }),
      documents: [doc('a.go', 'go')],
    });
    const second = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo-second' }),
      documents: [doc('b.ts', 'typescript')],
    });

    const { index: merged } = mergeScipIndexes([first, second]);
    expect(merged.metadata?.projectRoot).toBe('/repo-first');
  });

  it('duplicate document path across indexers: warn+last-wins, reports duplicatePaths', () => {
    const first = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('shared/util.go', 'go')],
    });
    const second = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('shared/util.go', 'typescript')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([first, second]);

    // Last-registry-order wins: the second index's document for the
    // colliding path replaces the first.
    const matches = merged.documents.filter((d) => d.relativePath === 'shared/util.go');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.language).toBe('typescript');
    expect(duplicatePaths).toEqual(['shared/util.go']);
  });

  it('returns an empty index for zero input indexes', () => {
    const { index: merged, duplicatePaths } = mergeScipIndexes([]);
    expect(merged.documents).toEqual([]);
    expect(duplicatePaths).toEqual([]);
  });
});
