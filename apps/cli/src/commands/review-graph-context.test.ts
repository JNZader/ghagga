/**
 * Unit tests for the graph-neighborhood context CLI seam
 * (graph-context-retrieval T3.4): `resolveGraphContextEnabled`, the
 * default-on mirror of `resolveBlastRadiusEnabled`.
 *
 * Same guarantees as review-blast-radius.test.ts: a REAL temp dir
 * (mkdtempSync) — NOT a mocked `node:fs` — so the repoPath-relative
 * existence resolution is genuinely exercised (CRITICAL-2 regression
 * guard).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGraphContextEnabled } from './review.js';

describe('resolveGraphContextEnabled', () => {
  let repoPath: string;
  let otherCwd: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'ghagga-graph-context-repo-'));
    otherCwd = mkdtempSync(join(tmpdir(), 'ghagga-graph-context-cwd-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  function withGraph(): void {
    mkdirSync(join(repoPath, '.ghagga'), { recursive: true });
    writeFileSync(join(repoPath, '.ghagga', 'graph.json'), '{}');
  }

  it('auto-enables when .ghagga/graph.json exists under repoPath', () => {
    withGraph();
    expect(resolveGraphContextEnabled(repoPath, {}, {})).toBe(true);
  });

  it('stays off when no graph.json exists', () => {
    expect(resolveGraphContextEnabled(repoPath, {}, {})).toBe(false);
  });

  it('resolves against repoPath, NOT process.cwd() (CRITICAL-2 mirror)', () => {
    withGraph();
    const originalCwd = process.cwd();
    try {
      process.chdir(otherCwd);
      expect(resolveGraphContextEnabled(repoPath, {}, {})).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('--no-graph-context (graphContext: false) wins over an existing graph', () => {
    withGraph();
    expect(resolveGraphContextEnabled(repoPath, { graphContext: false }, {})).toBe(false);
  });

  it('.ghagga.json enableGraphContext: false wins over an existing graph', () => {
    withGraph();
    expect(resolveGraphContextEnabled(repoPath, {}, { enableGraphContext: false })).toBe(false);
  });

  it('.ghagga.json enableGraphContext: true wins even without a graph', () => {
    expect(resolveGraphContextEnabled(repoPath, {}, { enableGraphContext: true })).toBe(true);
  });

  it('explicit --no-graph-context overrides .ghagga.json enableGraphContext: true', () => {
    expect(
      resolveGraphContextEnabled(repoPath, { graphContext: false }, { enableGraphContext: true }),
    ).toBe(false);
  });
});
