/**
 * FIX 3 (P3 4vr) — `--pr` post-back failure must be BLOCKING by default.
 *
 * `--pr` is an explicitly-requested side-effect. In CI (Jenkins) a post-back
 * that throws — or a missing token — must FAIL the job (non-zero exit), not
 * silently exit 0. `--pr-soft-fail` restores the old non-blocking behavior.
 *
 * We mock the seams reviewCommand composes (pipeline, git, token, post-back,
 * core formatters) so these tests are deterministic and offline, and assert the
 * resolved process exit code.
 */

import type { ReviewResult } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ghagga-core: only what review.ts touches on the --pr path ──
vi.mock('ghagga-core', () => ({
  reviewPipeline: vi.fn(),
  buildSarif: vi.fn().mockReturnValue({ version: '2.1.0', runs: [] }),
  formatReviewComment: vi.fn().mockReturnValue('<!-- ghagga-review -->\nbody'),
  formatBoxSummary: vi.fn().mockReturnValue([]),
  REVIEW_COMMENT_MARKER: '<!-- ghagga-review -->',
  DEFAULT_SETTINGS: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: true,
    enableMemory: true,
    customRules: [],
    ignorePatterns: [],
    reviewLevel: 'normal',
    enabledTools: [],
    disabledTools: [],
  },
  DEFAULT_MODELS: { gateway: 'auto', 'cli-bridge': 'auto', ollama: 'llama3' },
  initializeDefaultTools: vi.fn(),
  toolRegistry: { getAll: vi.fn().mockReturnValue([]) },
  EngramMemoryStorage: { create: vi.fn() },
  SqliteMemoryStorage: { create: vi.fn() },
  formatReviewResult: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), existsSync: vi.fn().mockReturnValue(false) }));

// PR-token + remote-parse + post-back seams.
vi.mock('../lib/pr-token.js', () => ({ resolvePrToken: vi.fn() }));
vi.mock('../lib/pr-postback.js', () => ({ postSummaryComment: vi.fn() }));
vi.mock('../lib/github-api.js', () => ({
  parseGitHubRemote: vi.fn().mockReturnValue({ owner: 'acme', repo: 'ci' }),
  createComment: vi.fn(),
  createIssue: vi.fn(),
  ensureLabel: vi.fn(),
  formatIssueBody: vi.fn(),
}));
// The forge adapter + client port are constructed but never exercised (post-back
// is mocked); stub them so construction is cheap.
vi.mock('ghagga-forge', () => ({
  GitHubForgeAdapter: class {},
  StaticTokenProvider: class {
    async getToken() {
      return 'tok';
    }
  },
}));
vi.mock('../lib/cli-github-client-port.js', () => ({ createCliGitHubClientPort: vi.fn() }));

import { execSync } from 'node:child_process';
import { reviewPipeline } from 'ghagga-core';
import { postSummaryComment } from '../lib/pr-postback.js';
import { resolvePrToken } from '../lib/pr-token.js';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);
const mockResolvePrToken = vi.mocked(resolvePrToken);
const mockPostSummaryComment = vi.mocked(postSummaryComment);

function defaultOptions(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    mode: 'simple',
    provider: 'gateway',
    model: 'm',
    apiKey: 'k',
    semgrep: true,
    trivy: true,
    cpd: true,
    memory: false,
    verbose: false,
    disableTools: [],
    enableTools: [],
    ...overrides,
  };
}

function passedResult(): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'ok',
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
      model: 'm',
      tokensUsed: 1,
      executionTimeMs: 1,
      toolsRun: [],
      toolsSkipped: [],
      fileList: [],
    },
  } as ReviewResult;
}

describe('reviewCommand — --pr post-back exit semantics (FIX 3)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let exitSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let errorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(passedResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--pr + post-back throws → exits NON-ZERO (1) even when review PASSED', async () => {
    mockResolvePrToken.mockReturnValue('gh-token');
    mockPostSummaryComment.mockRejectedValue(new Error('GitHub 500'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--pr + missing token → exits NON-ZERO (1) with a clear message', async () => {
    mockResolvePrToken.mockReturnValue(undefined as unknown as string);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--pr requires a GitHub token'));
  });

  it('--pr-soft-fail + post-back throws → WARNS and exits 0 (review PASSED)', async () => {
    mockResolvePrToken.mockReturnValue('gh-token');
    mockPostSummaryComment.mockRejectedValue(new Error('GitHub 500'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, prSoftFail: true, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--pr success → exits 0 when review PASSED', async () => {
    mockResolvePrToken.mockReturnValue('gh-token');
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 7, deletedNativeIds: [] });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does NOT mask a review-found-issues exit: --pr success + FAILED review → exit 1', async () => {
    mockReviewPipeline.mockResolvedValue({ ...passedResult(), status: 'FAILED' } as ReviewResult);
    mockResolvePrToken.mockReturnValue('gh-token');
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 7, deletedNativeIds: [] });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
