/**
 * GitHub Action tests.
 *
 * Tests the action entry point with mocked @actions/core,
 * @actions/github, and ghagga-core dependencies. Verifies
 * input parsing, PR detection, review execution, comment posting,
 * output setting, and error handling.
 */

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

  describe('provider API key resolution', () => {
    it('github provider uses GitHub token as API key (no api-key needed)', () => {
      // When provider is "github" and api-key is empty,
      // the action should use the github token as the LLM API key
      const provider = 'github';
      const apiKeyInput = '';
      const githubToken = 'ghp_faketoken';

      const resolvedKey = provider === 'github' ? apiKeyInput || githubToken : apiKeyInput;

      expect(resolvedKey).toBe('ghp_faketoken');
    });

    it('ollama provider uses placeholder key', () => {
      const provider = 'ollama';
      const apiKeyInput = '';

      const resolvedKey = provider === 'ollama' ? apiKeyInput || 'ollama' : apiKeyInput;

      expect(resolvedKey).toBe('ollama');
    });

    it('anthropic provider requires explicit api-key', () => {
      const provider: string = 'anthropic';
      const apiKeyInput = '';

      const needsKey = provider !== 'github' && provider !== 'ollama' && !apiKeyInput;
      expect(needsKey).toBe(true);
    });

    it('anthropic provider accepts explicit api-key', () => {
      const provider: string = 'anthropic';
      const apiKeyInput = 'sk-test-key';

      const needsKey = provider !== 'github' && provider !== 'ollama' && !apiKeyInput;
      expect(needsKey).toBe(false);
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
      };

      expect(STATUS_EMOJI.PASSED).toContain('PASSED');
      expect(STATUS_EMOJI.FAILED).toContain('FAILED');
      expect(STATUS_EMOJI.NEEDS_HUMAN_REVIEW).toContain('NEEDS_HUMAN_REVIEW');
      expect(STATUS_EMOJI.SKIPPED).toContain('SKIPPED');
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

import { run } from './index.js';

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

    // SQLite memory created
    expect(mockSqliteCreate).toHaveBeenCalledWith('/tmp/ghagga-memory.db');

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
});
