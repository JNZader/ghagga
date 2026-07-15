import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerateTextFn } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageConfig } from '../config/schema.js';
import { locate } from './locate.js';

function mockGenerateFn(text: string): GenerateTextFn {
  return vi.fn().mockResolvedValue({ text, tokensUsed: 0, provider: 'mock', model: 'mock' });
}

const baseConfig: Omit<TriageConfig, 'codeRoot' | 'moduleMap'> = {
  forge: 'gitlab',
  repo: 'acme/widgets',
  synonyms: { umbral: ['threshold', 'limit'] },
  stopwords: ['el', 'de', 'con', 'un', 'una', 'la', 'y', 'a', 'en'],
  language: 'go',
  graphExpand: false,
  models: { rerank: 'x', analysis: 'y' },
};

describe('locate (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'triage-locate-'));
    mkdirSync(path.join(root, 'internal', 'alerts'), { recursive: true });
    mkdirSync(path.join(root, 'internal', 'billing'), { recursive: true });
    writeFileSync(
      path.join(root, 'internal', 'alerts', 'threshold.go'),
      'package alerts\n\nfunc CheckThreshold() bool { return true }\n',
    );
    writeFileSync(
      path.join(root, 'internal', 'alerts', 'notify.go'),
      'package alerts\n\nfunc Notify() {}\n',
    );
    writeFileSync(
      path.join(root, 'internal', 'billing', 'invoice.go'),
      'package billing\n\nfunc Invoice() {}\n',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('4.1: a Spanish synonym issue resolves the reranked seed to the correct module dir', async () => {
    const config: TriageConfig = {
      ...baseConfig,
      codeRoot: root,
      moduleMap: { alertas: ['internal/alerts'], billing: ['internal/billing'] },
    };
    const issue = {
      title: 'el umbral de alerta no anda',
      body: 'cambié el umbral y sigue sin funcionar',
      labels: ['módulo::alertas'],
    };
    // Rerank mock picks candidate #1 (whichever ranks first — filename-boosted threshold.go).
    const rerankFn = mockGenerateFn('1');

    const result = await locate(issue, config, rerankFn);

    expect(result.keywords).toContain('umbral');
    expect(result.keywords).toContain('threshold');
    expect(result.candidates[0]).toBe('internal/alerts/threshold.go');
    expect(result.seeds).toContain('internal/alerts/threshold.go');
    expect(result.contextFiles).toContain('internal/alerts/threshold.go');
    // dir-sibling expand should also pull in notify.go (same dir), not billing.
    expect(result.contextFiles).toContain('internal/alerts/notify.go');
    expect(result.contextFiles).not.toContain('internal/billing/invoice.go');
  });

  it('4.3: Go project expansion always uses dir-sibling, never the dependency graph', async () => {
    const config: TriageConfig = {
      ...baseConfig,
      codeRoot: root,
      moduleMap: { alertas: ['internal/alerts'] },
      graphExpand: true, // explicitly opted in — must still be ignored for Go
      language: 'go',
    };
    const issue = { title: 'threshold', body: 'threshold broken', labels: ['módulo::alertas'] };
    const rerankFn = mockGenerateFn('1');

    const result = await locate(issue, config, rerankFn);

    // Regardless of graphExpand=true, Go stays dir-sibling: same-dir file included,
    // and no graph-only cross-package resolution is attempted/asserted here since
    // Go imports never resolve (task 4.5) — dir-sibling is the only source.
    expect(result.contextFiles).toContain('internal/alerts/notify.go');
  });

  it('falls back to top-3 candidates when rerank returns unparseable text', async () => {
    const config: TriageConfig = {
      ...baseConfig,
      codeRoot: root,
      moduleMap: { alertas: ['internal/alerts'] },
    };
    const issue = { title: 'umbral', body: 'el umbral', labels: ['módulo::alertas'] };
    const rerankFn = mockGenerateFn('no puedo responder');

    const result = await locate(issue, config, rerankFn);

    expect(result.seeds.length).toBeGreaterThan(0);
    expect(result.seeds.length).toBeLessThanOrEqual(3);
  });

  it('returns empty candidates/seeds when no files match any keyword', async () => {
    const config: TriageConfig = {
      ...baseConfig,
      codeRoot: root,
      moduleMap: { alertas: ['internal/alerts'] },
    };
    const issue = { title: 'zzzznomatch', body: 'zzzznomatch', labels: ['módulo::alertas'] };
    const rerankFn = mockGenerateFn('1');

    const result = await locate(issue, config, rerankFn);

    expect(result.candidates).toEqual([]);
    expect(result.seeds).toEqual([]);
    expect(result.contextFiles).toEqual([]);
  });
});
