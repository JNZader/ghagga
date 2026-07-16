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
import { ISSUE_TRIAGE_OBSERVATION_TYPE, SqliteMemoryStorage } from 'ghagga-core';
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

  it('extracts the route from rawDescription when description is stripped of the widget trailer', async () => {
    // Mirrors the GitLab adapter: description has the `---` trailer (incl. the
    // `Ruta:` line) stripped for the LLM, while rawDescription retains it. The
    // route MUST still be found — this is the bug the rawDescription field fixes.
    forge.getIssue = vi.fn(async (iid: string) => ({
      ...makeIssueWithRoute(iid),
      description: 'Algo se rompió.',
      rawDescription: 'Algo se rompió.\n\n---\n- Ruta: `/app/energia`',
    }));

    const draft = await triageIssue(options, '42');

    expect(mockedReproduce).toHaveBeenCalledTimes(1);
    const [, , , reproOptionsArg] = mockedReproduce.mock.calls.at(0) ?? [];
    expect(reproOptionsArg).toMatchObject({ route: '/app/energia' });
    // The LLM still receives the STRIPPED body as reproduce()'s body context.
    const [issueArg] = mockedReproduce.mock.calls.at(0) ?? [];
    expect(issueArg).toMatchObject({ body: 'Algo se rompió.' });
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

describe('triageIssue memory-backed dedup', () => {
  // Distinctive, high-overlap issue text so findIssueDuplicates clears its
  // conservative keyword-overlap threshold (≥ 2 terms, ≥ 0.6 overlap).
  const DUP_TITLE = 'Login button throws TypeError on Safari during checkout';
  const DUP_BODY =
    'The login button throws a TypeError on Safari during the checkout payment step.';
  const PROJECT = 'acme-widgets'; // repoSlug('acme/widgets')

  let dir: string;
  let queuePath: string;
  let storage: SqliteMemoryStorage;
  let forge: ForgeAdapter & { postComment: ReturnType<typeof vi.fn> };
  let analysisSpy: ReturnType<typeof scriptedGenerateFn>;
  let rerankSpy: GenerateTextFn;
  let options: EngineOptions;

  function makeDupIssue(iid: string, title = DUP_TITLE, body = DUP_BODY): ForgeIssue {
    return {
      iid,
      title,
      description: body,
      labels: [],
      url: `https://example.test/issues/${iid}`,
      comments: [],
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-engine-dedup-'));
    queuePath = join(dir, 'queue.json');
    // Real in-memory SQLite store (never flushed to disk — no close() needed).
    storage = await SqliteMemoryStorage.create(join(dir, 'memory.db'));
    forge = {
      listIssues: vi.fn(async () => [makeDupIssue('42')]),
      getIssue: vi.fn(async (iid: string) => makeDupIssue(iid)),
      postComment: vi.fn(async () => undefined),
    };
    analysisSpy = scriptedGenerateFn(TRIAGE_RESPONSE, 'Estamos revisando tu consulta.');
    rerankSpy = vi.fn(async () => ({
      text: '1',
      tokensUsed: 0,
      provider: 'cli-bridge' as const,
      model: 'r',
    }));
    options = {
      config: makeConfig(),
      forge,
      rerankGenerateFn: rerankSpy,
      analysisGenerateFn: analysisSpy,
      memory: storage,
      queuePath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) dedup HIT → DUPLICATE draft citing matches, and the analysis LLM is NOT called', async () => {
    // Pre-store a prior issue observation that the new issue duplicates. Stored
    // under the STABLE id (repoSlug#iid); the human title lives in the content
    // (first line) where it drives keyword overlap.
    await storage.saveObservation({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
      title: `${PROJECT}#7`,
      content: `${DUP_TITLE}\n${DUP_BODY}`,
    });

    const draft = await triageIssue(options, '42');

    expect(draft.kind).toBe('DUPLICATE');
    expect(draft.dedupMatches?.length).toBeGreaterThan(0);
    expect(draft.dedupMatches?.[0]?.title).toBe(`${PROJECT}#7`);
    // Short-circuit BEFORE any LLM: neither analysis nor locate-rerank ran.
    expect(analysisSpy).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();
    // Never posts.
    expect(forge.postComment).not.toHaveBeenCalled();
    // The duplicate path saves NOTHING (the issue dupes an already-stored obs).
    const stored = await storage.listObservations({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    expect(stored).toHaveLength(1);
  });

  it('(b) dedup MISS → normal ANALYSIS triage, and the issue is persisted to memory', async () => {
    const draft = await triageIssue(options, '42');

    expect(draft.kind).toBe('ANALYSIS');
    expect(draft.dedupMatches).toBeUndefined();
    expect(analysisSpy).toHaveBeenCalled();

    const stored = await storage.listObservations({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe(`${PROJECT}#42`);
    // Human title folded into content (first line) preserves keyword signal.
    expect(stored[0]?.content).toContain(DUP_TITLE);
    expect(stored[0]?.content).toContain('Classification:');
  });

  it('(c) a second, near-identical issue is detected as a duplicate after the first was stored', async () => {
    // First triage: MISS → stores the observation.
    forge.getIssue = vi.fn(async (iid: string) => makeDupIssue(iid));
    const first = await triageIssue(options, '7');
    expect(first.kind).toBe('ANALYSIS');

    // Second, DIFFERENT issue with the same text → should now dedup-HIT.
    const second = await triageIssue(options, '8');
    expect(second.kind).toBe('DUPLICATE');
    expect(second.dedupMatches?.[0]?.title).toBe(`${PROJECT}#7`);
  });

  it('(d) re-triaging the SAME issue never self-flags as a duplicate (self-match guard)', async () => {
    const first = await triageIssue(options, '7');
    expect(first.kind).toBe('ANALYSIS');

    // Re-triage #7 (its own observation is now in memory). It must NOT match
    // itself; the prior non-REJECTED draft also means it is not re-stored.
    const again = await triageIssue(options, '7');
    expect(again.kind).toBe('ANALYSIS');
    const stored = await storage.listObservations({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    expect(stored).toHaveLength(1);
  });

  it('(d2) re-triaging after the issue TITLE was edited still self-excludes (no self-duplicate, ANALYSIS not clobbered)', async () => {
    // First triage: MISS → stores the observation under the STABLE id (repoSlug#iid).
    const first = await triageIssue(options, '7');
    expect(first.kind).toBe('ANALYSIS');

    // A maintainer EDITS the issue title between triages. Body keywords are
    // unchanged, so the issue overlaps its OWN stored observation strongly —
    // the guard must exclude it by the stable id, not the (now-changed) title.
    const EDITED_TITLE = `${DUP_TITLE} (edited after maintainer triage)`;
    forge.getIssue = vi.fn(async (iid: string) => makeDupIssue(iid, EDITED_TITLE));

    const again = await triageIssue(options, '7');
    // Must NOT be flagged as a duplicate of itself; the ANALYSIS draft stands.
    expect(again.kind).toBe('ANALYSIS');
    expect(again.dedupMatches).toBeUndefined();

    // Prior non-REJECTED draft ⇒ not re-stored; identity is the stable id.
    const stored = await storage.listObservations({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe(`${PROJECT}#7`);
  });

  it('(e) dedup disabled in config → no dedup, no persistence, even with a store wired', async () => {
    options.config = { ...options.config, dedup: { enabled: false } };
    await storage.saveObservation({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
      title: `Issue #7: ${DUP_TITLE}`,
      content: DUP_BODY,
    });

    const draft = await triageIssue(options, '42');

    // Would have been a DUPLICATE if dedup ran — instead a normal analysis.
    expect(draft.kind).toBe('ANALYSIS');
    expect(analysisSpy).toHaveBeenCalled();
    // Nothing new persisted (still just the pre-seeded observation).
    const stored = await storage.listObservations({
      project: PROJECT,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    });
    expect(stored).toHaveLength(1);
  });
});
