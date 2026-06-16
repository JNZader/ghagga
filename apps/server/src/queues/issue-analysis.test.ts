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

import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted logger mock ────────────────────────────────────────

const { mockLogger, mockRootChildFn } = vi.hoisted(() => {
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

vi.mock('ghagga-db', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  saveIssueDraft: (...args: unknown[]) => mockSaveIssueDraft(...args),
  createDatabaseFromEnv: () => mockCreateDatabaseFromEnv(),
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
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
  mockGetRepositoryById.mockResolvedValue({ id: 1, encryptedApiKey: null });
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [{ provider: 'gateway', model: 'test-model', encryptedApiKey: null }],
  });

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
});
