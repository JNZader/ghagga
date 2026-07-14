/**
 * Engine facade tests — the CLI/web-facing surface wiring
 * forge -> locate -> triage -> queue together.
 *
 * SECURITY: `triageIssue`/`triageNew` NEVER call `forge.postComment` — only
 * `approveIssue` does (verified explicitly below).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateTextFn } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageConfig } from './config/schema.js';
import {
  approveIssue,
  type EngineOptions,
  editDraft,
  listQueue,
  rejectIssue,
  showDraft,
  triageIssue,
  triageNew,
} from './engine.js';
import type { ForgeAdapter, ForgeIssue } from './forge/port.js';
import { loadQueue, saveQueue } from './queue/store.js';
import { reproduce } from './reproduce/index.js';
import type { ReproEvidence } from './types/evidence.js';

vi.mock('./reproduce/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reproduce/index.js')>();
  return { ...actual, reproduce: vi.fn() };
});

function makeConfig(): TriageConfig {
  return {
    forge: 'gitlab',
    repo: 'acme/widgets',
    codeRoot: '/tmp/does-not-exist-ghagga-triage',
    language: 'go',
    graphExpand: false,
    models: { rerank: 'x', analysis: 'y' },
    clientReplyPolicy: { language: 'es' },
  };
}

function makeIssue(iid: string): ForgeIssue {
  return {
    iid,
    title: `Issue ${iid}`,
    description: 'Something is broken.',
    labels: [],
    url: `https://example.test/issues/${iid}`,
    comments: [],
  };
}

const TRIAGE_RESPONSE = [
  'CLASSIFICATION: bug',
  'CONFIDENCE: 0.6',
  '',
  'PLAN:',
  '- [ ] investigate',
  '',
  'FILES_TO_TOUCH:',
  '',
  'SOURCES:',
  '- issue text | issue | #0',
  '',
  'REPORT:',
  '## Triage: bug',
  'Root cause unclear.',
].join('\n');

function scriptedGenerateFn(...responses: string[]): GenerateTextFn {
  let i = 0;
  return vi.fn(async () => {
    const text = responses[Math.min(i, responses.length - 1)] ?? '';
    i += 1;
    return { text, tokensUsed: 1, provider: 'cli-bridge', model: 'test' };
  });
}

describe('engine facade', () => {
  let dir: string;
  let queuePath: string;
  let forge: ForgeAdapter & { postComment: ReturnType<typeof vi.fn> };
  let options: EngineOptions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-engine-'));
    queuePath = join(dir, 'queue.json');
    forge = {
      listIssues: vi.fn(async () => [makeIssue('1'), makeIssue('2')]),
      getIssue: vi.fn(async (iid: string) => makeIssue(iid)),
      postComment: vi.fn(async () => undefined),
    };
    options = {
      config: makeConfig(),
      forge,
      rerankGenerateFn: vi.fn(async () => ({
        text: '1',
        tokensUsed: 0,
        provider: 'cli-bridge',
        model: 'r',
      })),
      analysisGenerateFn: scriptedGenerateFn(TRIAGE_RESPONSE, 'Estamos revisando tu consulta.'),
      queuePath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('triageIssue fetches the issue, runs the pipeline, and persists a PENDING_APPROVAL draft', async () => {
    const draft = await triageIssue(options, '42');

    expect(forge.getIssue).toHaveBeenCalledWith('42');
    expect(draft.status).toBe('PENDING_APPROVAL');
    expect(draft.report).toContain('Root cause');
    expect(draft.clientReply).toBe('Estamos revisando tu consulta.');
    expect(forge.postComment).not.toHaveBeenCalled();

    const persisted = loadQueue(queuePath);
    expect(persisted['42']).toEqual(draft);
  });

  it('triageNew triages every listed issue not already queued (skips REJECTED-not, includes fresh)', async () => {
    saveQueue(queuePath, {
      '1': {
        id: 'acme/widgets#1',
        issueIid: '1',
        repo: 'acme/widgets',
        status: 'PENDING_APPROVAL',
        report: 'already queued',
        clientReply: 'already queued reply',
        reproductionEvidence: null,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    });

    const drafts = await triageNew(options);

    // issue #1 already queued (PENDING_APPROVAL) -> skipped; issue #2 -> triaged
    expect(drafts.map((d) => d.issueIid)).toEqual(['2']);
    expect(forge.getIssue).toHaveBeenCalledWith('2');
    expect(forge.getIssue).not.toHaveBeenCalledWith('1');
  });

  it('triageNew re-triages an issue whose previous draft was REJECTED', async () => {
    saveQueue(queuePath, {
      '1': {
        id: 'acme/widgets#1',
        issueIid: '1',
        repo: 'acme/widgets',
        status: 'REJECTED',
        report: 'r',
        clientReply: 'c',
        reproductionEvidence: null,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    });

    const drafts = await triageNew(options);

    expect(drafts.map((d) => d.issueIid).sort()).toEqual(['1', '2']);
  });

  it('listQueue / showDraft read the persisted queue', async () => {
    await triageIssue(options, '42');

    expect(Object.keys(listQueue(options))).toEqual(['42']);
    expect(showDraft(options, '42').status).toBe('PENDING_APPROVAL');
    expect(() => showDraft(options, '999')).toThrowError(/No draft queued/);
  });

  it('editDraft updates and persists the clientReply', async () => {
    await triageIssue(options, '42');

    const updated = editDraft(options, '42', 'edited by human');

    expect(updated.clientReply).toBe('edited by human');
    expect(loadQueue(queuePath)['42']?.clientReply).toBe('edited by human');
  });

  it('approveIssue is the ONLY function that posts to the forge, exactly once', async () => {
    await triageIssue(options, '42');

    const result = await approveIssue(options, '42');

    expect(forge.postComment).toHaveBeenCalledTimes(1);
    expect(result.posted).toBe(true);
    expect(loadQueue(queuePath)['42']?.status).toBe('POSTED');
  });

  it('approveIssue is idempotent — approving twice posts only once', async () => {
    await triageIssue(options, '42');
    await approveIssue(options, '42');
    const second = await approveIssue(options, '42');

    expect(forge.postComment).toHaveBeenCalledTimes(1);
    expect(second.posted).toBe(false);
  });

  it('rejectIssue never posts', async () => {
    await triageIssue(options, '42');

    const rejected = rejectIssue(options, '42');

    expect(rejected.status).toBe('REJECTED');
    expect(forge.postComment).not.toHaveBeenCalled();
  });
});

describe('triageIssue auto-reproduction wiring', () => {
  let dir: string;
  let queuePath: string;
  let forge: ForgeAdapter & { postComment: ReturnType<typeof vi.fn> };
  let options: EngineOptions;
  const mockedReproduce = vi.mocked(reproduce);

  const FAKE_EVIDENCE: ReproEvidence = {
    reproduced: true,
    steps: ['navigated to /app/alertas', 'error captured after action — bug REPRODUCED'],
    consoleErrors: ['TypeError: x is not a function'],
    netFails: [],
    uiErrors: [],
  };

  function makeConfigWithApp(): TriageConfig {
    return {
      forge: 'gitlab',
      repo: 'acme/widgets',
      codeRoot: '/tmp/does-not-exist-ghagga-triage',
      language: 'go',
      graphExpand: false,
      models: { rerank: 'x', analysis: 'y' },
      clientReplyPolicy: { language: 'es' },
      app: { baseURL: 'https://app.example.test', loginRecipe: { kind: 'none' } },
    };
  }

  function makeIssueWithRoute(iid: string): ForgeIssue {
    return {
      iid,
      title: `Issue ${iid}`,
      description: 'Algo se rompió.\n\nMódulo: Alertas · Ruta: /app/alertas',
      labels: [],
      url: `https://example.test/issues/${iid}`,
      comments: [],
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-engine-repro-'));
    queuePath = join(dir, 'queue.json');
    mockedReproduce.mockReset();
    mockedReproduce.mockResolvedValue(FAKE_EVIDENCE);
    forge = {
      listIssues: vi.fn(async () => [makeIssueWithRoute('1')]),
      getIssue: vi.fn(async (iid: string) => makeIssueWithRoute(iid)),
      postComment: vi.fn(async () => undefined),
    };
    options = {
      config: makeConfigWithApp(),
      forge,
      rerankGenerateFn: vi.fn(async () => ({
        text: '1',
        tokensUsed: 0,
        provider: 'cli-bridge',
        model: 'r',
      })),
      analysisGenerateFn: scriptedGenerateFn(TRIAGE_RESPONSE, 'Estamos revisando tu consulta.'),
      reproduceGenerateFn: vi.fn(async () => ({
        text: '{"action":"done"}',
        tokensUsed: 0,
        provider: 'cli-bridge',
        model: 'repro',
      })),
      queuePath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls reproduce() with the extracted route and threads its evidence into the draft', async () => {
    const draft = await triageIssue(options, '42');

    expect(mockedReproduce).toHaveBeenCalledTimes(1);
    const call = mockedReproduce.mock.calls.at(0);
    expect(call).toBeDefined();
    const [issueArg, configArg, generateFnArg, reproOptionsArg] = call ?? [];
    expect(issueArg).toMatchObject({ title: 'Issue 42' });
    expect(configArg).toBe(options.config);
    expect(generateFnArg).toBe(options.reproduceGenerateFn);
    expect(reproOptionsArg).toMatchObject({ route: '/app/alertas' });

    expect(draft.reproductionEvidence).toEqual(FAKE_EVIDENCE);
  });

  it('skips reproduce() when config.app is not set (regression: current behavior preserved)', async () => {
    options.config = { ...options.config, app: undefined };

    const draft = await triageIssue(options, '42');

    expect(mockedReproduce).not.toHaveBeenCalled();
    expect(draft.reproductionEvidence).toBeNull();
  });

  it('skips reproduce() when no route can be extracted from the issue body', async () => {
    forge.getIssue = vi.fn(async (iid: string) => ({
      ...makeIssueWithRoute(iid),
      description: 'No widget metadata in this body at all.',
    }));

    const draft = await triageIssue(options, '42');

    expect(mockedReproduce).not.toHaveBeenCalled();
    expect(draft.reproductionEvidence).toBeNull();
  });

  it('skips reproduce() when no reproduceGenerateFn is provided', async () => {
    options.reproduceGenerateFn = undefined;

    const draft = await triageIssue(options, '42');

    expect(mockedReproduce).not.toHaveBeenCalled();
    expect(draft.reproductionEvidence).toBeNull();
  });

  it('proceeds with the triage (no throw) when reproduce() rejects — evidence is absent, not fatal', async () => {
    mockedReproduce.mockRejectedValueOnce(new Error('chromium launch failed'));

    const draft = await triageIssue(options, '42');

    expect(draft.status).toBe('PENDING_APPROVAL');
    expect(draft.reproductionEvidence).toBeNull();
    expect(forge.postComment).not.toHaveBeenCalled();
  });

  it('an explicitly-passed reproEvidence argument wins over auto-reproduction', async () => {
    const explicit: ReproEvidence = {
      reproduced: false,
      steps: ['manual step'],
      consoleErrors: [],
      netFails: [],
      uiErrors: [],
    };

    const draft = await triageIssue(options, '42', explicit);

    expect(mockedReproduce).not.toHaveBeenCalled();
    expect(draft.reproductionEvidence).toEqual(explicit);
  });

  it('an explicit null reproEvidence argument also wins over auto-reproduction', async () => {
    const draft = await triageIssue(options, '42', null);

    expect(mockedReproduce).not.toHaveBeenCalled();
    expect(draft.reproductionEvidence).toBeNull();
  });
});
