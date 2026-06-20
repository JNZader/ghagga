/**
 * P4 — `ghagga review --mr N` (GitLab MR) post-back routes through the SHARED
 * composition helper (composeForgePostback → postSummaryComment) and honors the
 * SAME blocking-by-default exit semantics as `--pr` (FIX 3). `--pr-soft-fail`
 * (shared) opts out.
 *
 * We mock the seams reviewCommand composes (pipeline, git, gitlab-token,
 * gitlab-api, gitlab client port, post-back, core formatters) so these tests are
 * deterministic + offline, and assert the resolved process exit code + that the
 * GitLab adapter is the one constructed (shared helper routes --mr to GitLab).
 */

import type { ReviewResult } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../lib/gitlab-token.js', () => ({ resolveMrToken: vi.fn() }));
vi.mock('../lib/pr-postback.js', () => ({ postSummaryComment: vi.fn() }));
vi.mock('../lib/gitlab-api.js', () => ({
  parseGitLabRemote: vi.fn().mockReturnValue({ host: 'gitlab.com', projectPath: 'acme/widgets' }),
  GitLabApiError: class extends Error {},
}));
vi.mock('../lib/cli-gitlab-client-port.js', () => ({
  createCliGitLabClientPort: vi.fn(),
  resolveGitLabApiBase: vi.fn().mockReturnValue('https://gitlab.com/api/v4'),
  resolveGitLabProjectId: vi.fn().mockResolvedValue('12345'),
}));

// Track which adapter the shared helper constructs (routing proof).
const gitlabCtor = vi.fn();
const githubCtor = vi.fn();
vi.mock('ghagga-forge', () => ({
  GitHubForgeAdapter: class {
    constructor(deps: unknown) {
      githubCtor(deps);
    }
  },
  GitLabForgeAdapter: class {
    constructor(deps: unknown) {
      gitlabCtor(deps);
    }
  },
  StaticTokenProvider: class {
    async getToken() {
      return 'glpat';
    }
  },
}));
vi.mock('../lib/cli-github-client-port.js', () => ({ createCliGitHubClientPort: vi.fn() }));

import { execSync } from 'node:child_process';
import { reviewPipeline } from 'ghagga-core';
import { resolveGitLabProjectId } from '../lib/cli-gitlab-client-port.js';
import { resolveMrToken } from '../lib/gitlab-token.js';
import { postSummaryComment } from '../lib/pr-postback.js';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);
const mockResolveMrToken = vi.mocked(resolveMrToken);
const mockPostSummaryComment = vi.mocked(postSummaryComment);
const mockResolveProjectId = vi.mocked(resolveGitLabProjectId);

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

describe('reviewCommand — --mr post-back (P4, shared composition helper)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let exitSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let errorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExecSync.mockReturnValue('git@gitlab.com:acme/widgets.git' as never);
    mockReviewPipeline.mockResolvedValue(passedResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--mr success → posts via the GitLab adapter through the SHARED helper, exit 0', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 77, deletedNativeIds: [] });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    // Routing proof: GitLab adapter constructed, NOT GitHub; ref via numeric id.
    expect(gitlabCtor).toHaveBeenCalledOnce();
    expect(githubCtor).not.toHaveBeenCalled();
    expect(gitlabCtor).toHaveBeenCalledWith(expect.objectContaining({ projectId: '12345' }));
    expect(mockResolveProjectId).toHaveBeenCalledWith(
      'acme/widgets',
      'glpat',
      'https://gitlab.com/api/v4',
    );
    // Post routed through the shared forge-neutral postSummaryComment.
    expect(mockPostSummaryComment).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--mr + post-back throws → exit NON-ZERO (1) even when review PASSED', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    mockPostSummaryComment.mockRejectedValue(new Error('GitLab 500'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--mr + missing token → exit NON-ZERO (1) with a GitLab-specific message', async () => {
    mockResolveMrToken.mockReturnValue(null);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--mr requires a GitLab token'));
  });

  it('--mr + --pr-soft-fail + throws → WARNS and exits 0', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    mockPostSummaryComment.mockRejectedValue(new Error('GitLab 500'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, prSoftFail: true, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('both --pr AND --mr → defensive guard exits 1 BEFORE the pipeline runs (FIX D)', async () => {
    mockResolveMrToken.mockReturnValue('glpat');

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 3, mr: 7, outputFormat: 'sarif' }));

    // The guard fires FIRST: the first recorded exit is the guard's non-zero exit
    // (in production process.exit terminates here; the test mock lets it fall
    // through, so we assert on the FIRST exit call specifically).
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
  });

  it('does NOT mask a review-found-issues exit: --mr success + FAILED review → exit 1', async () => {
    mockReviewPipeline.mockResolvedValue({ ...passedResult(), status: 'FAILED' } as ReviewResult);
    mockResolveMrToken.mockReturnValue('glpat');
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 77, deletedNativeIds: [] });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
