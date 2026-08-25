/**
 * Issue-Analysis Queue — unit tests for the triage worker.
 *
 * The `processIssueAnalysis` function is the internal handler passed to BullMQ's
 * Worker. We capture it via the Worker mock and invoke it directly with crafted
 * JobData. Everything external — BullMQ/Redis, the GitHub client, the DB, the
 * memory storage, and the LLM `generateFn` — is MOCKED. No real network, Redis,
 * Postgres, or LLM calls happen here.
 *
 * Coverage:
 *   - happy path: an ANALYSIS draft is persisted and NO comment is posted
 *   - dedup hit: a DUPLICATE draft is produced (kind=DUPLICATE)
 *   - low/zero-confidence gate: draft is HELD (DRAFT), never auto-concluded as a
 *     confident answer, and nothing is posted
 *   - the issue is saved to memory under ISSUE_TRIAGE_OBSERVATION_TYPE (so future
 *     dedup can find it)
 *   - the one-open-draft conflict (saveIssueDraft → undefined) is handled
 *     gracefully (no throw)
 *   - NO GitHub post method is EVER called (the worker is a draft gate)
 */

import { readFileSync } from 'node:fs';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted logger mock ────────────────────────────────────────

const { mockRootChildFn } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const mockRootChildFn = vi.fn().mockReturnValue(mockLogger);
  return { mockLogger, mockRootChildFn };
});

// ─── Capture the Worker processor ───────────────────────────────

let capturedProcessor: ((job: Job) => Promise<unknown>) | undefined;

vi.mock('bullmq', () => {
  class QueueMock {
    add = vi.fn().mockResolvedValue({});
  }
  class WorkerMock {
    on = vi.fn();
    constructor(_name: string, processor: unknown) {
      capturedProcessor = processor as typeof capturedProcessor;
    }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => {
  class RedisMock {}
  return { default: RedisMock };
});

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: (...args: unknown[]) => mockRootChildFn(...args),
  },
}));

// ─── ghagga-core mocks (agent + dedup + provider resolution) ────

const mockRunIssueTriage = vi.fn();
const mockFindIssueDuplicates = vi.fn();
const mockResolvePrimaryProvider = vi.fn();
const mockResolveGenerateTextFns = vi.fn();
const mockFormatMemoryContext = vi.fn();

vi.mock('ghagga-core', () => ({
  runIssueTriage: (...args: unknown[]) => mockRunIssueTriage(...args),
  findIssueDuplicates: (...args: unknown[]) => mockFindIssueDuplicates(...args),
  resolvePrimaryProvider: (...args: unknown[]) => mockResolvePrimaryProvider(...args),
  resolveGenerateTextFns: (...args: unknown[]) => mockResolveGenerateTextFns(...args),
  formatMemoryContext: (...args: unknown[]) => mockFormatMemoryContext(...args),
  ISSUE_TRIAGE_OBSERVATION_TYPE: 'issue-triage',
}));

// ─── ghagga-db mocks ────────────────────────────────────────────

const mockDecrypt = vi.fn((v: string) => `decrypted-${v}`);
const mockSaveIssueDraft = vi.fn().mockResolvedValue({ id: 99 });
const mockCreateDatabaseFromEnv = vi.fn(() => ({}));
const mockGetRepositoryById = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();
const mockGetOpenIssueDraft = vi.fn();

vi.mock('ghagga-db', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  saveIssueDraft: (...args: unknown[]) => mockSaveIssueDraft(...args),
  createDatabaseFromEnv: () => mockCreateDatabaseFromEnv(),
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
  getOpenIssueDraft: (...args: unknown[]) => mockGetOpenIssueDraft(...args),
}));

// ─── ./review.js mock — reuse the worker's SSRF + normalize helpers ──
// The worker imports `revalidateGatewayChain` + `normalizeLegacyProvider` from
// the review queue. We mock that module so (a) importing it never spins up the
// real review Queue/Worker/Redis, and (b) we can ASSERT the SSRF re-validation
// helper actually runs on the triage path and control what it returns.
const mockRevalidateGatewayChain = vi.fn();
const mockNormalizeLegacyProvider = vi.fn();

vi.mock('./review.js', () => ({
  // Default: pass the chain through unchanged (no SSRF drop). Tests override.
  revalidateGatewayChain: (...args: unknown[]) => mockRevalidateGatewayChain(...args),
  // Mirror the real 3-variant normalize closely enough for the worker's needs.
  normalizeLegacyProvider: (...args: unknown[]) => mockNormalizeLegacyProvider(...args),
}));

// ─── GitHub client mock — EVERY method is a spy so we can prove no post ──

const mockPostComment = vi.fn().mockResolvedValue({ id: 1 });
const mockAddCommentReaction = vi.fn().mockResolvedValue(undefined);
const mockGetInstallationToken = vi.fn().mockResolvedValue('ghp_mock');

vi.mock('../github/client.js', () => ({
  postComment: (...args: unknown[]) => mockPostComment(...args),
  addCommentReaction: (...args: unknown[]) => mockAddCommentReaction(...args),
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
}));

// ─── Code-in-evidence mock — isolate the worker's FOLD from the helper ──
// The helper (collectIssueCodeEvidence) is tested standalone in
// issue-code-evidence.test.ts. Here we mock it to assert the worker folds its
// return into memoryContext and hands it to runIssueTriage. Default '' →
// text-only (existing tests see no behavior change).
const mockCollectCodeEvidence = vi.fn();
vi.mock('./issue-code-evidence.js', () => ({
  collectIssueCodeEvidence: (...args: unknown[]) => mockCollectCodeEvidence(...args),
}));

// ─── PostgresMemoryStorage mock — captures saveObservation calls ─

const mockSaveObservation = vi.fn().mockResolvedValue({ id: 7 });
const mockSearchObservations = vi.fn().mockResolvedValue([]);
const mockPostgresMemoryStorage = vi.hoisted(() => vi.fn());
vi.mock('../memory/postgres.js', () => ({
  PostgresMemoryStorage: mockPostgresMemoryStorage,
}));

// ─── Import module & trigger Worker constructor to capture processor ──

import {
  createIssueAnalysisWorker,
  ISSUE_TRIAGE_CONFIDENCE_THRESHOLD,
  type IssueAnalysisJobData,
} from './issue-analysis.js';

createIssueAnalysisWorker(1);

// ─── Helpers ────────────────────────────────────────────────────

function makeJobData(overrides: Partial<IssueAnalysisJobData> = {}): IssueAnalysisJobData {
  return {
    reviewId: 'triage-001',
    installationId: 12345,
    repositoryId: 1,
    repoFullName: 'acme/my-app',
    issueNumber: 42,
    issueTitle: 'App crashes on startup',
    issueBody: 'When I run the app with no TIMEOUT set it crashes immediately.',
    labels: ['needs-triage'],
    triggerCommentId: 555,
    ...overrides,
  };
}

function makeFakeJob(data: IssueAnalysisJobData): Job<IssueAnalysisJobData> {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<IssueAnalysisJobData>;
}

function fullTriageResult(overrides: Record<string, unknown> = {}) {
  return {
    classification: 'bug',
    rootCauseHypotheses: [],
    plan: '- [ ] fix it',
    filesToTouch: ['src/retry.ts'],
    sources: [{ title: 'memory#1', type: 'observation', ref: '1' }],
    report: '## Triage: bug\nRoot cause is a missing default.',
    confidence: 0.82,
    tokensUsed: 42,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_APP_ID = 'test-app-id';
  process.env.GITHUB_PRIVATE_KEY = 'test-private-key';

  // Default provider resolution → a single gateway fn.
  mockResolvePrimaryProvider.mockReturnValue({
    provider: 'gateway',
    model: 'test-model',
    apiKey: 'k',
  });
  mockResolveGenerateTextFns.mockReturnValue([vi.fn()]);
  mockFormatMemoryContext.mockReturnValue('formatted memory context');

  // Default repo settings: a usable provider chain so AI is enabled.
  mockGetRepositoryById.mockResolvedValue({
    id: 1,
    encryptedApiKey: null,
    llmProvider: 'gateway',
    llmModel: 'legacy-model',
  });
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [{ provider: 'gateway', model: 'test-model', encryptedApiKey: null }],
  });

  // No open draft by default (Stage-0 pre-check passes through).
  mockGetOpenIssueDraft.mockResolvedValue(undefined);

  // SSRF re-validation: pass the chain through unchanged by default.
  mockRevalidateGatewayChain.mockImplementation(async (chain: unknown[]) => chain);
  // normalizeLegacyProvider: identity for the 3 valid variants, gateway otherwise.
  mockNormalizeLegacyProvider.mockImplementation((raw: string) =>
    raw === 'cli-bridge' || raw === 'ollama' || raw === 'gateway' ? raw : 'gateway',
  );

  // PostgresMemoryStorage instances expose search + save. Use a function
  // expression (NOT an arrow) so it is constructable via `new`.
  mockPostgresMemoryStorage.mockImplementation(function MockStorage(this: Record<string, unknown>) {
    this.searchObservations = mockSearchObservations;
    this.saveObservation = mockSaveObservation;
  });

  // No dedup hit by default.
  mockFindIssueDuplicates.mockResolvedValue({
    query: 'app crash',
    matches: [],
    isDuplicate: false,
  });
  mockRunIssueTriage.mockResolvedValue(fullTriageResult());
  mockSaveIssueDraft.mockResolvedValue({ id: 99 });
  // Default: no code evidence → text-only triage (existing tests unaffected).
  mockCollectCodeEvidence.mockResolvedValue('');
});

// ─── Tests ──────────────────────────────────────────────────────

describe('processIssueAnalysis — happy path (ANALYSIS draft)', () => {
  it('persists an ANALYSIS draft and posts NOTHING', async () => {
    expect(capturedProcessor).toBeDefined();
    const job = makeFakeJob(makeJobData());

    const result = await capturedProcessor?.(job);

    // Draft persisted as DRAFT / ANALYSIS.
    expect(mockSaveIssueDraft).toHaveBeenCalledTimes(1);
    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.status).toBe('DRAFT');
    expect(draft.draftKind).toBe('ANALYSIS');
    expect(draft.repositoryId).toBe(1);
    expect(draft.issueNumber).toBe(42);
    expect(draft.body).toContain('Root cause');
    expect(draft.tokensUsed).toBe(42);

    // NEVER posts.
    expect(mockPostComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });

  it('runs the agent with an injected generateFn (resolved, not hardwired)', async () => {
    const job = makeFakeJob(makeJobData());
    await capturedProcessor?.(job);

    expect(mockResolvePrimaryProvider).toHaveBeenCalled();
    expect(mockResolveGenerateTextFns).toHaveBeenCalled();
    expect(mockRunIssueTriage).toHaveBeenCalledTimes(1);
    const input = mockRunIssueTriage.mock.calls[0]?.[0];
    expect(typeof input.generateFn).toBe('function');
    expect(input.issueTitle).toBe('App crashes on startup');
  });
});

describe('processIssueAnalysis — code-in-evidence fold', () => {
  it('passes the code helper output to runIssueTriage via its own sourceCode input', async () => {
    mockCollectCodeEvidence.mockResolvedValue('## RELEVANT SOURCE CODE\n### src/x.ts\nCODE_MARKER');
    const job = makeFakeJob(makeJobData());

    await capturedProcessor?.(job);

    // The helper was called with the worker's identity + an issueText carrying the title.
    expect(mockCollectCodeEvidence).toHaveBeenCalledTimes(1);
    const helperArgs = mockCollectCodeEvidence.mock.calls[0]?.[0];
    expect(helperArgs.installationId).toBe(makeJobData().installationId);
    expect(helperArgs.repoFullName).toBe(makeJobData().repoFullName);
    expect(helperArgs.issueText).toContain('App crashes on startup');

    // The fetched code reaches the agent via sourceCode (its own fenced input),
    // NOT folded into the memory channel.
    const triageInput = mockRunIssueTriage.mock.calls[0]?.[0];
    expect(triageInput.sourceCode).toContain('CODE_MARKER');
    expect(triageInput.memoryContext ?? '').not.toContain('CODE_MARKER');
  });

  it('preserves the null memoryContext contract when there is neither memory nor code', async () => {
    mockCollectCodeEvidence.mockResolvedValue(''); // no code
    // no dedup matches (default) → no memory context either
    const job = makeFakeJob(makeJobData());

    await capturedProcessor?.(job);

    const triageInput = mockRunIssueTriage.mock.calls[0]?.[0];
    // memoryContext is pure dedup context (buildMemoryContextFromDedup → null on
    // no matches) — code no longer folds into it. Null, never the string ''.
    expect(triageInput.memoryContext).toBeNull();
  });

  it('never lets a code-helper throw block triage (degrades to text-only)', async () => {
    mockCollectCodeEvidence.mockRejectedValue(new Error('helper boom'));
    const job = makeFakeJob(makeJobData());

    const result = await capturedProcessor?.(job);

    // Triage still ran and a draft still persisted — the throw was swallowed.
    expect(mockRunIssueTriage).toHaveBeenCalledTimes(1);
    expect(mockSaveIssueDraft).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });
});

describe('processIssueAnalysis — dedup hit (DUPLICATE draft)', () => {
  it('produces a DUPLICATE draft and does NOT call the LLM agent', async () => {
    mockFindIssueDuplicates.mockResolvedValue({
      query: 'app crash startup',
      matches: [{ observationId: 1234, title: 'prior crash bug', score: 0.9 }],
      isDuplicate: true,
    });

    const job = makeFakeJob(makeJobData());
    await capturedProcessor?.(job);

    expect(mockSaveIssueDraft).toHaveBeenCalledTimes(1);
    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.draftKind).toBe('DUPLICATE');
    expect(draft.status).toBe('DRAFT');
    expect(draft.dedupMatches).toEqual([
      { observationId: 1234, title: 'prior crash bug', score: 0.9 },
    ]);
    // Duplicate short-circuits before the expensive LLM analysis.
    expect(mockRunIssueTriage).not.toHaveBeenCalled();
    expect(mockPostComment).not.toHaveBeenCalled();
  });
});

describe('processIssueAnalysis — confidence gate', () => {
  it('holds a below-threshold draft as DRAFT and never auto-posts', async () => {
    mockRunIssueTriage.mockResolvedValue(fullTriageResult({ confidence: 0.1 }));

    const job = makeFakeJob(makeJobData());
    await capturedProcessor?.(job);

    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.status).toBe('DRAFT');
    // Below threshold must surface as NEEDS_INFO (held for human), not a
    // confident ANALYSIS conclusion.
    expect(draft.draftKind).toBe('NEEDS_INFO');
    expect(mockPostComment).not.toHaveBeenCalled();
  });

  it('treats confidence===0 (unparseable) as fail-safe, not a confident answer', async () => {
    // 0 means "no parseable confidence" (DEFAULT_CONFIDENCE) — it must NOT be
    // treated as a genuine, confident ANALYSIS. It routes to the held path.
    mockRunIssueTriage.mockResolvedValue(fullTriageResult({ confidence: 0 }));

    const job = makeFakeJob(makeJobData());
    await capturedProcessor?.(job);

    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.status).toBe('DRAFT');
    expect(draft.draftKind).toBe('NEEDS_INFO');
    expect(mockPostComment).not.toHaveBeenCalled();
  });

  it('exposes a sane, conservative default threshold', () => {
    expect(ISSUE_TRIAGE_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(ISSUE_TRIAGE_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('processIssueAnalysis — memory save (future dedup)', () => {
  it('persists the analysed issue under ISSUE_TRIAGE_OBSERVATION_TYPE', async () => {
    const job = makeFakeJob(makeJobData());
    await capturedProcessor?.(job);

    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
    const obs = mockSaveObservation.mock.calls[0]?.[0];
    // CRITICAL carry-forward: dedup filters by this exact type. If the save
    // path uses any other type, future dedup finds nothing.
    expect(obs.type).toBe('issue-triage');
    expect(obs.title).toContain('App crashes on startup');
  });
});

describe('processIssueAnalysis — one-open-draft conflict', () => {
  it('handles saveIssueDraft returning undefined (existing open DRAFT) without throwing', async () => {
    mockSaveIssueDraft.mockResolvedValue(undefined);

    const job = makeFakeJob(makeJobData());
    const result = await capturedProcessor?.(job);

    expect(result).toMatchObject({ success: true });
    expect(mockPostComment).not.toHaveBeenCalled();
  });
});

describe('processIssueAnalysis — never posts (hard gate)', () => {
  it('never calls any GitHub comment-posting method across paths', async () => {
    // happy path
    await capturedProcessor?.(makeFakeJob(makeJobData()));
    // dedup path
    mockFindIssueDuplicates.mockResolvedValueOnce({
      query: 'q',
      matches: [{ observationId: 1, title: 't', score: 0.99 }],
      isDuplicate: true,
    });
    await capturedProcessor?.(makeFakeJob(makeJobData({ issueNumber: 43 })));
    // low-confidence path
    mockRunIssueTriage.mockResolvedValueOnce(fullTriageResult({ confidence: 0 }));
    await capturedProcessor?.(makeFakeJob(makeJobData({ issueNumber: 44 })));

    expect(mockPostComment).not.toHaveBeenCalled();
    expect(mockAddCommentReaction).not.toHaveBeenCalled();
  });

  // The behavioral assertions above only prove "no post" on the SUCCESS paths.
  // Cover the EXCEPTION paths too so the guarantee is not a vacuous pass: even
  // when the agent or the persist throws, nothing is ever posted.
  it('never posts when runIssueTriage throws', async () => {
    mockRunIssueTriage.mockRejectedValueOnce(new Error('LLM exploded'));

    await expect(capturedProcessor?.(makeFakeJob(makeJobData()))).rejects.toThrow('LLM exploded');

    expect(mockPostComment).not.toHaveBeenCalled();
    expect(mockAddCommentReaction).not.toHaveBeenCalled();
  });

  it('never posts when saveIssueDraft throws (transient DB error → BullMQ retry)', async () => {
    mockSaveIssueDraft.mockRejectedValueOnce(new Error('connection reset'));

    // Re-thrown so BullMQ retries — the Stage-0 pre-check makes the retry
    // idempotent. Still NEVER posts.
    await expect(capturedProcessor?.(makeFakeJob(makeJobData()))).rejects.toThrow(
      'connection reset',
    );

    expect(mockPostComment).not.toHaveBeenCalled();
    expect(mockAddCommentReaction).not.toHaveBeenCalled();
  });

  // STRUCTURAL guard: the never-post guarantee is enforced by the source itself
  // not importing any GitHub posting client — not merely by behavior. If a future
  // edit pulls `postComment`/`deleteComment`/`addCommentReaction` from the github
  // client into this module, this test fails.
  it('module source imports NO github posting client', () => {
    const src = readFileSync(new URL('./issue-analysis.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*github\/client[^'"]*['"]/);
    expect(src).not.toMatch(/\bpostComment\b/);
    expect(src).not.toMatch(/\bdeleteComment\b/);
    expect(src).not.toMatch(/\baddCommentReaction\b/);
  });
});

// ─── Stage 0: existing-open-draft pre-check ─────────────────────

describe('processIssueAnalysis — existing-open-draft pre-check', () => {
  it('skips early when an open DRAFT already exists (no dedup, no LLM, no memory)', async () => {
    mockGetOpenIssueDraft.mockResolvedValueOnce({ id: 7, draftKind: 'ANALYSIS' });

    const result = await capturedProcessor?.(makeFakeJob(makeJobData()));

    expect(result).toMatchObject({ success: true, skipped: 'draft-pending' });
    // No expensive work happened.
    expect(mockFindIssueDuplicates).not.toHaveBeenCalled();
    expect(mockRunIssueTriage).not.toHaveBeenCalled();
    expect(mockSaveObservation).not.toHaveBeenCalled();
    // No new draft is inserted.
    expect(mockSaveIssueDraft).not.toHaveBeenCalled();
    expect(mockPostComment).not.toHaveBeenCalled();
  });

  it('proceeds normally when no open DRAFT exists', async () => {
    mockGetOpenIssueDraft.mockResolvedValueOnce(undefined);

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    expect(mockRunIssueTriage).toHaveBeenCalledTimes(1);
    expect(mockSaveIssueDraft).toHaveBeenCalledTimes(1);
  });

  it('continues (does not block) when the pre-check read fails', async () => {
    mockGetOpenIssueDraft.mockRejectedValueOnce(new Error('db read failed'));

    const result = await capturedProcessor?.(makeFakeJob(makeJobData()));

    // Falls through to normal triage; the insert conflict remains the guard.
    expect(result).toMatchObject({ success: true });
    expect(mockRunIssueTriage).toHaveBeenCalledTimes(1);
  });
});

// ─── SSRF re-validation on the triage path ──────────────────────

describe('processIssueAnalysis — SSRF re-validation (DNS-rebinding TOCTOU)', () => {
  it('runs revalidateGatewayChain on the provider chain before analysis', async () => {
    mockGetEffectiveRepoSettings.mockResolvedValueOnce({
      providerChain: [
        { provider: 'gateway', model: 'm', encryptedApiKey: null, gatewayUrl: 'https://ok/' },
      ],
    });

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    expect(mockRevalidateGatewayChain).toHaveBeenCalledTimes(1);
    const passedChain = mockRevalidateGatewayChain.mock.calls[0]?.[0];
    expect(passedChain).toEqual([
      { provider: 'gateway', model: 'm', encryptedApiKey: null, gatewayUrl: 'https://ok/' },
    ]);
  });

  it('drops a rebound gateway entry: SSRF re-validation empties the chain → NEEDS_INFO', async () => {
    mockGetEffectiveRepoSettings.mockResolvedValueOnce({
      providerChain: [
        {
          provider: 'gateway',
          model: 'm',
          encryptedApiKey: null,
          gatewayUrl: 'http://169.254.169.254/',
        },
      ],
    });
    // No legacy key either → no usable backend after SSRF drop.
    mockGetRepositoryById.mockResolvedValueOnce({
      id: 1,
      encryptedApiKey: null,
      llmProvider: 'gateway',
      llmModel: null,
    });
    // SSRF re-validation drops the rebound entry.
    mockRevalidateGatewayChain.mockResolvedValueOnce([]);

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    // No LLM call (no usable backend), held as NEEDS_INFO, never posts.
    expect(mockRunIssueTriage).not.toHaveBeenCalled();
    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.draftKind).toBe('NEEDS_INFO');
    expect(mockPostComment).not.toHaveBeenCalled();
  });
});

// ─── Legacy single-key credential fallback ──────────────────────

describe('processIssueAnalysis — legacy single-key fallback', () => {
  it('analyses via legacy llmProvider/llmModel + encryptedApiKey when no chain exists', async () => {
    // No v3 chain.
    mockGetEffectiveRepoSettings.mockResolvedValueOnce({ providerChain: [] });
    // But a legacy single key is present.
    mockGetRepositoryById.mockResolvedValueOnce({
      id: 1,
      encryptedApiKey: 'enc-legacy',
      llmProvider: 'gateway',
      llmModel: 'legacy-model',
    });

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    // The legacy key is decrypted and analysis runs (not degraded to NEEDS_INFO).
    expect(mockDecrypt).toHaveBeenCalledWith('enc-legacy');
    expect(mockRunIssueTriage).toHaveBeenCalledTimes(1);
    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.draftKind).toBe('ANALYSIS');
  });
});

// ─── Observation content: comments + labels folded in ───────────

describe('processIssueAnalysis — observation content (dedup coverage)', () => {
  it('includes labels and capped comments in the saved observation', async () => {
    const job = makeFakeJob(
      makeJobData({
        labels: ['needs-triage', 'area/auth'],
        comments: [
          { author: 'alice', body: 'I see a NullPointer on login' },
          { author: 'bob', body: 'reproduces only with SSO enabled' },
        ],
      }),
    );

    await capturedProcessor?.(job);

    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
    const obs = mockSaveObservation.mock.calls[0]?.[0];
    expect(obs.content).toContain('Labels: needs-triage, area/auth');
    expect(obs.content).toContain('alice: I see a NullPointer on login');
    expect(obs.content).toContain('bob: reproduces only with SSO enabled');
  });
});

// ─── Stage ordering: memory saved ONLY after a successful persist ──

describe('processIssueAnalysis — memory save ordering', () => {
  it('does NOT save the observation when the draft insert conflicts (no phantom)', async () => {
    // onConflictDoNothing → undefined (an open DRAFT raced past the pre-check).
    mockSaveIssueDraft.mockResolvedValueOnce(undefined);

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    // No phantom observation when nothing persisted.
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });

  it('saves the observation AFTER the draft insert (ordering)', async () => {
    const order: string[] = [];
    mockSaveIssueDraft.mockImplementationOnce(async () => {
      order.push('persist');
      return { id: 99 };
    });
    mockSaveObservation.mockImplementationOnce(async () => {
      order.push('memory');
      return { id: 7 };
    });

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    expect(order).toEqual(['persist', 'memory']);
  });
});

// ─── dedupMatches stripped to the DB shape ──────────────────────

describe('processIssueAnalysis — dedupMatches persistence shape', () => {
  it('strips relevanceScore before persisting dedupMatches', async () => {
    mockFindIssueDuplicates.mockResolvedValueOnce({
      query: 'q',
      // A weak (non-duplicate) match carrying the observability-only relevanceScore.
      matches: [{ observationId: 5, title: 'prior', score: 0.3, relevanceScore: 0.99 }],
      isDuplicate: false,
    });

    await capturedProcessor?.(makeFakeJob(makeJobData()));

    const draft = mockSaveIssueDraft.mock.calls[0]?.[1];
    expect(draft.dedupMatches).toEqual([{ observationId: 5, title: 'prior', score: 0.3 }]);
    // relevanceScore must NOT leak into the persisted jsonb.
    expect(draft.dedupMatches[0]).not.toHaveProperty('relevanceScore');
  });
});
