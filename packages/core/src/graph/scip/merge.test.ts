/**
 * Unit tests for mergeScipIndexes() (D4).
 *
 * Pure merge of parsed SCIP `Index.documents` from 2+ indexers into one
 * `Index`, ahead of a single `buildGraphFromScip` call. Kept separate from
 * the dispatcher tests (index-cmd.test.ts), which mock `run`/`toolchainCheck`
 * and only assert the merge is *wired*, not its internal correctness.
 *
 * Signature (nested-marker-detection): `mergeScipIndexes` now takes
 * `Array<{index, pathPrefix}>` — `pathPrefix` is the marker directory's
 * repo-relative path (POSIX, `''` for repo root), joined onto each
 * document's own `relativePath` before the `byPath` insert, so two runs of
 * the same indexer in different subdirectories don't collide on identical
 * bare filenames (e.g. two `main.py`).
 */

import { create } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, MetadataSchema } from '@scip-code/scip';
import { describe, expect, it } from 'vitest';
import { mergeScipIndexes } from './merge.js';

function doc(relativePath: string, language: string) {
  return create(DocumentSchema, { relativePath, language, symbols: [], occurrences: [] });
}

describe('mergeScipIndexes', () => {
  it('passes a single index through unchanged (documents + metadata) with an empty prefix', () => {
    const index = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.go', 'go')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([{ index, pathPrefix: '' }]);

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

    const { index: merged, duplicatePaths } = mergeScipIndexes([
      { index: goIndex, pathPrefix: '' },
      { index: tsIndex, pathPrefix: '' },
    ]);

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

    const { index: merged } = mergeScipIndexes([
      { index: first, pathPrefix: '' },
      { index: second, pathPrefix: '' },
    ]);
    expect(merged.metadata?.projectRoot).toBe('/repo-first');
  });

  it('duplicate document path across indexers at the SAME prefix: warn+last-wins, reports duplicatePaths', () => {
    const first = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('shared/util.go', 'go')],
    });
    const second = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('shared/util.go', 'typescript')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([
      { index: first, pathPrefix: '' },
      { index: second, pathPrefix: '' },
    ]);

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

  // ─── Path-prefix disambiguation (nested marker detection) ─────────

  it('two same-language indexes with the same bare relativePath but distinct prefixes: BOTH present, repo-relative POSIX paths', () => {
    const mlService = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.py', 'python')],
    });
    const aiAssistant = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.py', 'python')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([
      { index: mlService, pathPrefix: 'apps/ml-service' },
      { index: aiAssistant, pathPrefix: 'services/ai-assistant' },
    ]);

    const paths = merged.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['apps/ml-service/main.py', 'services/ai-assistant/main.py']);
    expect(duplicatePaths).toEqual([]);
  });

  it('empty/root prefix leaves relativePath unchanged', () => {
    const rootIndex = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('src/index.ts', 'typescript')],
    });

    const { index: merged } = mergeScipIndexes([{ index: rootIndex, pathPrefix: '' }]);
    expect(merged.documents[0]?.relativePath).toBe('src/index.ts');
  });

  it('"." prefix (relative() of repo root to itself) is treated as root/empty', () => {
    const rootIndex = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('src/index.ts', 'typescript')],
    });

    const { index: merged } = mergeScipIndexes([{ index: rootIndex, pathPrefix: '.' }]);
    expect(merged.documents[0]?.relativePath).toBe('src/index.ts');
  });

  it('same-prefix collision after joining is still reported as a genuine duplicatePath', () => {
    const first = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.py', 'python')],
    });
    const second = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.py', 'python')],
    });

    const { index: merged, duplicatePaths } = mergeScipIndexes([
      { index: first, pathPrefix: 'apps/ml-service' },
      { index: second, pathPrefix: 'apps/ml-service' },
    ]);

    const matches = merged.documents.filter((d) => d.relativePath === 'apps/ml-service/main.py');
    expect(matches).toHaveLength(1);
    expect(duplicatePaths).toEqual(['apps/ml-service/main.py']);
  });

  it('normalizes a Windows-style backslash prefix to POSIX before joining', () => {
    const index = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('main.py', 'python')],
    });

    const { index: merged } = mergeScipIndexes([{ index, pathPrefix: 'apps\\ml-service' }]);

    expect(merged.documents[0]?.relativePath).toBe('apps/ml-service/main.py');
  });

  // ─── Path-escape guard ──────────────────────────────────────────

  it('skips a document whose relativePath escapes the repo-relative root via `..`, and reports it', () => {
    const evilIndex = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('../../evil.go', 'go'), doc('safe.go', 'go')],
    });

    const {
      index: merged,
      duplicatePaths,
      escapedPaths,
    } = mergeScipIndexes([{ index: evilIndex, pathPrefix: 'apps' }]);

    // The escaping document is dropped, not inserted.
    expect(merged.documents).toHaveLength(1);
    expect(merged.documents[0]?.relativePath).toBe('apps/safe.go');
    expect(duplicatePaths).toEqual([]);
    expect(escapedPaths).toEqual(['../evil.go']);
  });

  it('does not flag a normal (non-escaping) document as escaped', () => {
    const index = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: '/repo' }),
      documents: [doc('pkg/util.go', 'go')],
    });

    const { index: merged, escapedPaths } = mergeScipIndexes([
      { index, pathPrefix: 'apps/service' },
    ]);

    expect(merged.documents[0]?.relativePath).toBe('apps/service/pkg/util.go');
    expect(escapedPaths).toEqual([]);
  });
});
