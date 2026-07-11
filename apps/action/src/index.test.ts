/**
 * GitHub Action tests.
 *
 * Tests the action entry point with mocked @actions/core,
 * @actions/github, and ghagga-core dependencies. Verifies
 * input parsing, PR detection, review execution, comment posting,
 * output setting, and error handling.
 */

import * as github from '@actions/github';
import type { ReviewResult, ReviewStatus } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock all external dependencies ─────────────────────────────

const mockGetInput = vi.fn();
const mockSetOutput = vi.fn();
const mockSetFailed = vi.fn();
const mockInfo = vi.fn();
const mockWarning = vi.fn();

vi.mock('@actions/core', () => ({
  getInput: (...args: unknown[]) => mockGetInput(...args),
  setOutput: (...args: unknown[]) => mockSetOutput(...args),
  setFailed: (...args: unknown[]) => mockSetFailed(...args),
  info: (...args: unknown[]) => mockInfo(...args),
  warning: (...args: unknown[]) => mockWarning(...args),
}));

const mockCreateComment = vi.fn().mockResolvedValue({});
const mockUpdateComment = vi.fn().mockResolvedValue({});
const mockListComments = vi.fn().mockResolvedValue({ data: [] });
const mockPullsGet = vi.fn();

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    runId: 12345,
    runAttempt: 1,
    payload: {
      pull_request: { number: 42 },
    },
  },
  getOctokit: () => ({
    rest: {
      pulls: { get: mockPullsGet },
      issues: {
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
        listComments: mockListComments,
      },
    },
  }),
}));

const mockRestoreCache = vi.fn();
const mockSaveCache = vi.fn();

vi.mock('@actions/cache', () => ({
  restoreCache: (...args: unknown[]) => mockRestoreCache(...args),
  saveCache: (...args: unknown[]) => mockSaveCache(...args),
}));

// ─── Mock node:fs so path isolation is observable without touching disk ──

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockRenameSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

// Stable RUNNER_TEMP so cache/staging paths are deterministic in assertions.
const TEST_RUNNER_TEMP = '/runner/tmp';
// Cache staging file is per-repo and stable across runs.
const EXPECTED_CACHE_FILE = `${TEST_RUNNER_TEMP}/ghagga-memory-cache/test-owner-test-repo.db`;
// Prefix of the isolated, per-run working directory (unique suffix appended).
const EXPECTED_WORKING_PREFIX = `${TEST_RUNNER_TEMP}/ghagga-memory-test-owner-test-repo-`;

const mockReviewPipeline = vi.fn();
const mockSqliteCreate = vi.fn();

vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
    SqliteMemoryStorage: {
      create: (...args: unknown[]) => mockSqliteCreate(...args),
    },
  };
});

const mockRunLocalAnalysis = vi.fn();

vi.mock('./tools/index.js', () => ({
  runLocalAnalysis: (...args: unknown[]) => mockRunLocalAnalysis(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Code looks good.',
    findings: [],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'gpt-4o-mini',
      tokensUsed: 100,
      executionTimeMs: 500,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('GitHub Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default input values — github provider (free, no api-key needed)
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        provider: 'github',
        model: '',
        mode: 'simple',
        'api-key': '',
        'github-token': 'ghp_faketoken',
        'enable-semgrep': 'true',
        'enable-trivy': 'true',
        'enable-cpd': 'true',
      };
      return inputs[name] ?? '';
    });

    // Default: GITHUB_TOKEN is available
    process.env.GITHUB_TOKEN = 'ghp_faketoken';

    // Default: PR returns a diff
    mockPullsGet.mockResolvedValue({
      data: 'diff --git a/file.ts b/file.ts\n+const x = 1;',
    });

    // Default: review passes
    mockReviewPipeline.mockResolvedValue(makeResult());
  });

  it('exports a runnable module', async () => {
    const mod = await import('./index.js');
    expect(mod).toBeDefined();
  });

  describe('input parsing', () => {
    it('reads provider with default "github"', () => {
      expect(mockGetInput('provider')).toBe('github');
    });

    it('reads mode with default "simple"', () => {
      expect(mockGetInput('mode')).toBe('simple');
    });

    it('reads enable-semgrep/trivy/cpd toggles', () => {
      expect(mockGetInput('enable-semgrep')).toBe('true');
      expect(mockGetInput('enable-trivy')).toBe('true');
      expect(mockGetInput('enable-cpd')).toBe('true');
    });

    it('api-key is optional (not required for github provider)', () => {
      expect(mockGetInput('api-key')).toBe('');
    });

    it('github-token input is available', () => {
      expect(mockGetInput('github-token')).toBe('ghp_faketoken');
    });
  });

  describe('action.yml contract', () => {
    it('defines expected inputs: provider, model, mode, api-key, github-token', () => {
      const expectedInputs = ['provider', 'model', 'mode', 'api-key', 'github-token'];
      for (const input of expectedInputs) {
        expect(typeof mockGetInput(input)).toBe('string');
      }
    });

    it('defines expected outputs: status, findings-count', () => {
      mockSetOutput('status', 'PASSED');
      mockSetOutput('findings-count', 0);
      expect(mockSetOutput).toHaveBeenCalledWith('status', 'PASSED');
      expect(mockSetOutput).toHaveBeenCalledWith('findings-count', 0);
    });
  });

  describe('review result handling', () => {
    it('maps PASSED status to success (no setFailed call)', () => {
      const result = makeResult({ status: 'PASSED' });
      expect(result.status).toBe('PASSED');
    });

    it('maps FAILED status to action failure', () => {
      const result = makeResult({ status: 'FAILED' });
      expect(result.status).toBe('FAILED');
    });

    it('counts findings correctly', () => {
      const result = makeResult({
        findings: [
          { severity: 'high', category: 'security', file: 'a.ts', message: 'bad', source: 'ai' },
          { severity: 'medium', category: 'style', file: 'b.ts', message: 'meh', source: 'ai' },
        ],
      });
      expect(result.findings.length).toBe(2);
    });
  });

  describe('comment formatting', () => {
    it('STATUS_EMOJI maps all valid statuses', () => {
      const STATUS_EMOJI: Record<ReviewStatus, string> = {
        PASSED: '\u2705 PASSED',
        FAILED: '\u274c FAILED',
        NEEDS_HUMAN_REVIEW: '\u26a0\ufe0f NEEDS_HUMAN_REVIEW',
        SKIPPED: '\u23ed\ufe0f SKIPPED',
        PARTIAL: '\u26a1 PARTIAL',
      };

      expect(STATUS_EMOJI.PASSED).toContain('PASSED');
      expect(STATUS_EMOJI.FAILED).toContain('FAILED');
      expect(STATUS_EMOJI.NEEDS_HUMAN_REVIEW).toContain('NEEDS_HUMAN_REVIEW');
      expect(STATUS_EMOJI.SKIPPED).toContain('SKIPPED');
      expect(STATUS_EMOJI.PARTIAL).toContain('PARTIAL');
    });

    it('SEVERITY_EMOJI maps all valid severities', () => {
      const SEVERITY_EMOJI: Record<string, string> = {
        critical: '\ud83d\udd34',
        high: '\ud83d\udfe0',
        medium: '\ud83d\udfe1',
        low: '\ud83d\udfe2',
        info: '\ud83d\udfe3',
      };

      expect(Object.keys(SEVERITY_EMOJI)).toHaveLength(5);
      expect(SEVERITY_EMOJI.critical).toBeDefined();
      expect(SEVERITY_EMOJI.info).toBeDefined();
    });

    it('formatted comment includes the GHAGGA branding', () => {
      const comment = '## \ud83e\udd16 GHAGGA Code Review\n\nPowered by GHAGGA';
      expect(comment).toContain('GHAGGA');
    });

    it('pipe characters in finding messages are escaped for table', () => {
      const message = 'Use a | b instead of c | d';
      const escaped = message.replace(/\|/g, '\\|');
      expect(escaped).toBe('Use a \\| b instead of c \\| d');
      expect(escaped.split('\\|').length).toBe(3);
    });
  });

  describe('error handling', () => {
    it('setFailed is called when an error occurs', () => {
      mockSetFailed('GHAGGA review failed: some error');
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('GHAGGA review failed'));
    });

    it('handles missing PR context gracefully', () => {
      mockSetFailed(
        'This action must be triggered by a pull_request event. ' +
          'Add `on: pull_request` to your workflow.',
      );
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('pull_request event'));
    });

    it('handles missing GitHub token', () => {
      delete process.env.GITHUB_TOKEN;
      mockSetFailed('GitHub token is required to fetch PR diffs and post comments.');
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('GitHub token'));
    });
  });

  describe('diff handling', () => {
    it('skips review when PR has no diff', () => {
      mockSetOutput('status', 'SKIPPED');
      mockSetOutput('findings-count', 0);
      expect(mockSetOutput).toHaveBeenCalledWith('status', 'SKIPPED');
      expect(mockSetOutput).toHaveBeenCalledWith('findings-count', 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration tests — invoke run() directly (enabled by T2.5 guard)
// ═══════════════════════════════════════════════════════════════

import { resolveMemoryPaths, run } from './index.js';

const defaultStaticAnalysis = {
  semgrep: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
  trivy: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
  cpd: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
};

describe('run() — integration', () => {
  const mockMemoryStorage = {
    searchObservations: vi.fn().mockResolvedValue([]),
    saveObservation: vi.fn().mockResolvedValue({}),
    createSession: vi.fn().mockResolvedValue({ id: 1 }),
    endSession: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default inputs: github provider, memory enabled
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        provider: 'github',
        model: '',
        mode: 'simple',
        'api-key': '',
        'github-token': 'ghp_faketoken',
        'enable-semgrep': 'true',
        'enable-trivy': 'true',
        'enable-cpd': 'true',
        'enable-memory': 'true',
      };
      return inputs[name] ?? '';
    });

    process.env.GITHUB_TOKEN = 'ghp_faketoken';

    mockPullsGet.mockResolvedValue({
      data: 'diff --git a/file.ts b/file.ts\n+const x = 1;',
    });

    mockRunLocalAnalysis.mockResolvedValue(defaultStaticAnalysis);
    mockReviewPipeline.mockResolvedValue(makeResult());
    mockSqliteCreate.mockResolvedValue(mockMemoryStorage);
    mockRestoreCache.mockResolvedValue(undefined);
    mockSaveCache.mockResolvedValue(undefined);

    // Deterministic isolated-path resolution.
    process.env.RUNNER_TEMP = TEST_RUNNER_TEMP;
    delete process.env.GITHUB_JOB;
    delete process.env.GITHUB_REPOSITORY_ID;

    // fs defaults: directories/files "exist" so restore-copy and save-copy run.
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
    mockCopyFileSync.mockReturnValue(undefined);
    mockRenameSync.mockReturnValue(undefined);

    // A clean close by default (per-test overrides where needed).
    mockMemoryStorage.close.mockResolvedValue(undefined);
  });

  it('happy path: calls reviewPipeline, posts comment, sets outputs', async () => {
    await run();

    expect(mockRunLocalAnalysis).toHaveBeenCalled();
    // The action remaps the legacy 'github' input via resolveActionProvider() → 'gateway'.
    expect(mockReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.stringContaining('diff --git'),
        mode: 'simple',
        provider: 'gateway',
      }),
    );
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
      }),
    );
    expect(mockSetOutput).toHaveBeenCalledWith('status', 'PASSED');
    expect(mockSetOutput).toHaveBeenCalledWith('findings-count', 0);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('empty diff: sets output status=SKIPPED without calling reviewPipeline', async () => {
    mockPullsGet.mockResolvedValue({ data: '' });

    await run();

    expect(mockReviewPipeline).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith('status', 'SKIPPED');
    expect(mockSetOutput).toHaveBeenCalledWith('findings-count', 0);
  });

  it('FAILED review: calls setFailed with "critical issues"', async () => {
    mockReviewPipeline.mockResolvedValue(
      makeResult({
        status: 'FAILED',
        findings: [
          { severity: 'high', category: 'security', file: 'a.ts', message: 'bad', source: 'ai' },
        ],
      }),
    );

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('critical issues'));
  });

  it('pipeline error: calls setFailed with "GHAGGA review failed"', async () => {
    mockReviewPipeline.mockRejectedValue(new Error('API timeout'));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('GHAGGA review failed: API timeout'),
    );
  });

  it('missing github token: calls setFailed', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'github-token') return '';
      return '';
    });
    delete process.env.GITHUB_TOKEN;

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('GitHub token is required'));
  });

  it('memory lifecycle: restoreCache → create SQLite → reviewPipeline → close → saveCache', async () => {
    await run();

    // Cache restored first
    expect(mockRestoreCache).toHaveBeenCalled();

    // SQLite memory created on an ISOLATED per-run path (not the shared /tmp
    // file). No embedding-provider input is set in this suite's default
    // inputs, so the second arg is an empty options object (none-default
    // parity, task 5.3/5.4).
    expect(mockSqliteCreate).toHaveBeenCalledWith(
      expect.stringContaining(EXPECTED_WORKING_PREFIX),
      {},
    );
    expect(mockSqliteCreate).toHaveBeenCalledWith(expect.stringContaining('/memory.db'), {});
    expect(mockSqliteCreate).not.toHaveBeenCalledWith('/tmp/ghagga-memory.db', {});

    // Memory passed to pipeline
    expect(mockReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryStorage: mockMemoryStorage,
      }),
    );

    // After pipeline: close, then save cache
    expect(mockMemoryStorage.close).toHaveBeenCalled();
    expect(mockSaveCache).toHaveBeenCalled();
  });

  it('memory cache: restores with prefix fallback and bare base key (old-format caches)', async () => {
    await run();

    expect(mockRestoreCache).toHaveBeenCalledWith(
      [EXPECTED_CACHE_FILE],
      'ghagga-memory-test-owner-test-repo-12345-1',
      ['ghagga-memory-test-owner-test-repo-', 'ghagga-memory-test-owner-test-repo'],
    );
  });

  it('memory cache: saves with an attempt-unique key (Actions caches are write-once)', async () => {
    await run();

    expect(mockSaveCache).toHaveBeenCalledWith(
      [EXPECTED_CACHE_FILE],
      'ghagga-memory-test-owner-test-repo-12345-1',
    );
    // The save key must differ from the immutable base key
    expect(mockSaveCache).not.toHaveBeenCalledWith(
      [EXPECTED_CACHE_FILE],
      'ghagga-memory-test-owner-test-repo',
    );
  });

  it('memory cache: save key includes BOTH runId and runAttempt so re-runs can save', async () => {
    // runId is stable across re-runs of the same workflow run — only the
    // attempt number changes. A key without runAttempt would collide with
    // the write-once cache entry from the first attempt.
    const mutableContext = github.context as unknown as { runAttempt: number };
    mutableContext.runAttempt = 2;

    try {
      await run();

      expect(mockSaveCache).toHaveBeenCalledWith(
        [EXPECTED_CACHE_FILE],
        'ghagga-memory-test-owner-test-repo-12345-2',
      );
    } finally {
      mutableContext.runAttempt = 1;
    }
  });

  // ─── ACTION-MEM-001: per-run isolation of the SQLite database ─────────

  it('isolation: opens SQLite on a per-run path, never the shared /tmp file', async () => {
    await run();

    const dbPath = mockSqliteCreate.mock.calls[0]?.[0] as string;
    expect(dbPath).toBeDefined();
    expect(dbPath).not.toBe('/tmp/ghagga-memory.db');
    expect(dbPath.startsWith(EXPECTED_WORKING_PREFIX)).toBe(true);
    expect(dbPath.endsWith('/memory.db')).toBe(true);
    // A private per-run directory is created before the DB is opened.
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(EXPECTED_WORKING_PREFIX),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
  });

  it('cache miss: removes any residual working file so the DB starts empty', async () => {
    // Repo A may have left a file at the working destination on a persistent
    // runner. A cache miss for THIS run must guarantee an empty database.
    mockRestoreCache.mockResolvedValue(undefined);

    await run();

    const dbPath = mockSqliteCreate.mock.calls[0]?.[0] as string;
    expect(mockRmSync).toHaveBeenCalledWith(dbPath, { force: true });
    // The residual file is removed BEFORE the fresh DB is opened.
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockSqliteCreate).toHaveBeenCalledWith(dbPath, {});
  });

  it('failed restore: does not open a residual file (clears the destination)', async () => {
    mockRestoreCache.mockRejectedValue(new Error('cache service unavailable'));

    await run();

    const dbPath = mockSqliteCreate.mock.calls[0]?.[0] as string;
    // Restore failed → not marked restored → residual destination cleared.
    expect(mockRmSync).toHaveBeenCalledWith(dbPath, { force: true });
    // No stale bytes copied into the working path from a hit branch.
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(
      EXPECTED_CACHE_FILE,
      expect.stringContaining('memory.restore.db'),
    );
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to restore memory cache'),
    );
  });

  it('cache hit: materializes the DB via staging file + atomic rename', async () => {
    mockRestoreCache.mockResolvedValue('ghagga-memory-test-owner-test-repo-12340-1');
    mockExistsSync.mockReturnValue(true);

    await run();

    const dbPath = mockSqliteCreate.mock.calls[0]?.[0] as string;
    const stagingPath = dbPath.replace('/memory.db', '/memory.restore.db');
    // Restore lands in the stable cache file, copied to staging, then renamed
    // atomically into the isolated working path.
    expect(mockCopyFileSync).toHaveBeenCalledWith(EXPECTED_CACHE_FILE, stagingPath);
    expect(mockRenameSync).toHaveBeenCalledWith(stagingPath, dbPath);
  });

  // ─── ACTION-LIFE-002: close in finally, cache only after a clean close ─

  it('lifecycle: close runs in finally even when comment publication throws', async () => {
    // A comment failure must NOT lose the memory snapshot nor the outputs.
    mockListComments.mockRejectedValue(new Error('secondary rate limit'));

    await run();

    expect(mockMemoryStorage.close).toHaveBeenCalled();
    expect(mockSaveCache).toHaveBeenCalled();
    // Review outputs are still published (decoupled from the comment).
    expect(mockSetOutput).toHaveBeenCalledWith('status', 'PASSED');
    // A comment failure is non-fatal.
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish review comment'),
    );
  });

  it('lifecycle: close runs in finally even when the pipeline throws', async () => {
    mockReviewPipeline.mockRejectedValue(new Error('provider down'));

    await run();

    expect(mockMemoryStorage.close).toHaveBeenCalled();
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('GHAGGA review failed: provider down'),
    );
  });

  it('lifecycle: cache is saved ONLY after a clean close', async () => {
    const order: string[] = [];
    mockMemoryStorage.close.mockImplementation(async () => {
      order.push('close');
    });
    mockSaveCache.mockImplementation(async () => {
      order.push('save');
    });

    await run();

    expect(order).toEqual(['close', 'save']);
    // Snapshot copied from the closed working DB into the cache file first.
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/memory.db'),
      EXPECTED_CACHE_FILE,
    );
  });

  it('lifecycle: a failed close does NOT save a stale cache snapshot', async () => {
    mockMemoryStorage.close.mockRejectedValue(new Error('disk I/O error'));

    await run();

    expect(mockMemoryStorage.close).toHaveBeenCalled();
    expect(mockSaveCache).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close memory storage'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Embedding provider wiring (design D7 — Action-never-local, task 5.3/5.4)
// ═══════════════════════════════════════════════════════════════

describe('run() — embedding provider wiring', () => {
  const mockMemoryStorage = {
    searchObservations: vi.fn().mockResolvedValue([]),
    saveObservation: vi.fn().mockResolvedValue({}),
    createSession: vi.fn().mockResolvedValue({ id: 1 }),
    endSession: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  /** Base inputs shared by every test in this block, overridable per-test. */
  function stubInputs(overrides: Record<string, string> = {}) {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        provider: 'github',
        model: '',
        mode: 'simple',
        'api-key': '',
        'github-token': 'ghp_faketoken',
        'enable-semgrep': 'true',
        'enable-trivy': 'true',
        'enable-cpd': 'true',
        'enable-memory': 'true',
        ...overrides,
      };
      return inputs[name] ?? '';
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stubInputs();

    process.env.GITHUB_TOKEN = 'ghp_faketoken';
    mockPullsGet.mockResolvedValue({
      data: 'diff --git a/file.ts b/file.ts\n+const x = 1;',
    });
    mockRunLocalAnalysis.mockResolvedValue(defaultStaticAnalysis);
    mockReviewPipeline.mockResolvedValue(makeResult());
    mockSqliteCreate.mockResolvedValue(mockMemoryStorage);
    mockRestoreCache.mockResolvedValue(undefined);
    mockSaveCache.mockResolvedValue(undefined);

    process.env.RUNNER_TEMP = TEST_RUNNER_TEMP;
    delete process.env.GITHUB_JOB;
    delete process.env.GITHUB_REPOSITORY_ID;

    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
    mockCopyFileSync.mockReturnValue(undefined);
    mockRenameSync.mockReturnValue(undefined);
    mockMemoryStorage.close.mockResolvedValue(undefined);
  });

  it('resolves to no provider (empty options) when unconfigured', async () => {
    await run();

    const [, options] = mockSqliteCreate.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).toEqual({});
    expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('embedding-provider'));
  });

  it('threads a concrete openai-compatible provider + model + candidateK when configured', async () => {
    stubInputs({
      'embedding-provider': 'openai-compatible',
      'embedding-model': 'text-embedding-3-small',
      'embedding-base-url': 'https://api.openai.com/v1',
      'embedding-dimension': '1536',
      'embedding-candidate-k': '50',
    });

    await run();

    const [, options] = mockSqliteCreate.mock.calls[0] as [
      string,
      {
        embeddingProvider?: { dimension: number };
        embeddingModel?: string;
        embeddingCandidateK?: number;
      },
    ];
    expect(options.embeddingProvider).toBeDefined();
    expect(options.embeddingProvider?.dimension).toBe(1536);
    expect(options.embeddingModel).toBe('text-embedding-3-small');
    expect(options.embeddingCandidateK).toBe(50);
  });

  it('coerces embedding-provider "local" to none with a warning — never attempts the excluded import', async () => {
    stubInputs({ 'embedding-provider': 'local' });

    await run();

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('embedding-provider "local" is not available'),
    );
    const [, options] = mockSqliteCreate.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════
// resolveMemoryPaths — per-run/per-process isolation (ACTION-MEM-001)
// ═══════════════════════════════════════════════════════════════

describe('resolveMemoryPaths', () => {
  const baseParams = {
    repoFullName: 'test-owner/test-repo',
    repoId: '123',
    runId: 12345,
    runAttempt: 1,
    jobId: 'review',
  };

  beforeEach(() => {
    process.env.RUNNER_TEMP = TEST_RUNNER_TEMP;
  });

  it('roots the working DB under RUNNER_TEMP, scoped by repo', () => {
    const paths = resolveMemoryPaths(baseParams);
    expect(paths.workingDbPath.startsWith(EXPECTED_WORKING_PREFIX)).toBe(true);
    expect(paths.workingDbPath.endsWith('/memory.db')).toBe(true);
    expect(paths.cacheFilePath).toBe(EXPECTED_CACHE_FILE);
  });

  it('two concurrent jobs never resolve to the same working destination', () => {
    // Same repo, run, attempt and job — only the random/pid suffix differs.
    const a = resolveMemoryPaths(baseParams);
    const b = resolveMemoryPaths(baseParams);
    expect(a.workingDbPath).not.toBe(b.workingDbPath);
    expect(a.perRunDir).not.toBe(b.perRunDir);
    // The shared cache staging file is stable across both (cross-run continuity).
    expect(a.cacheFilePath).toBe(b.cacheFilePath);
  });

  it('repo A and repo B resolve to different working paths (no cross-repo leak)', () => {
    const a = resolveMemoryPaths({ ...baseParams, repoFullName: 'org/repo-a' });
    const b = resolveMemoryPaths({ ...baseParams, repoFullName: 'org/repo-b' });
    expect(a.workingDbPath).not.toBe(b.workingDbPath);
    expect(a.cacheFilePath).not.toBe(b.cacheFilePath);
  });

  it('falls back to os.tmpdir() when RUNNER_TEMP is unset', () => {
    delete process.env.RUNNER_TEMP;
    const paths = resolveMemoryPaths(baseParams);
    expect(paths.workingDbPath).toContain('ghagga-memory-test-owner-test-repo-');
    process.env.RUNNER_TEMP = TEST_RUNNER_TEMP;
  });
});
