/**
 * FIX 4 (4vr backlog-cleanup) — CLI `--pr` flow: when the numeric repo-id
 * resolution (`GET /repos/{owner}/{repo}`) fails with a NETWORK error, the
 * post-back must DEGRADE gracefully:
 *   - it does NOT crash,
 *   - it warns (non-silent),
 *   - it proceeds with a PATH-SHAPED, opaque `RepoRef.nativeId` (`owner/repo`).
 *
 * This locks in the safe-degradation documented by the RepoRef.nativeId contract
 * (opaque identity string, MAY be path-shaped). We mock the seams reviewCommand
 * composes so the test is deterministic + offline, and capture the `RepoRef`
 * handed to the post-back to assert the fallback nativeId.
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

vi.mock('../lib/pr-token.js', () => ({ resolvePrToken: vi.fn() }));
// Capture the RepoRef the post-back receives so we can assert the fallback id.
vi.mock('../lib/pr-postback.js', () => ({ postSummaryComment: vi.fn() }));
vi.mock('../lib/github-api.js', () => ({
  parseGitHubRemote: vi.fn().mockReturnValue({ owner: 'acme', repo: 'ci' }),
  createComment: vi.fn(),
  createIssue: vi.fn(),
  ensureLabel: vi.fn(),
  formatIssueBody: vi.fn(),
}));
vi.mock('ghagga-forge', () => ({
  GitHubForgeAdapter: class {},
  StaticTokenProvider: class {
    async getToken() {
      return 'tok';
    }
  },
}));
// THE SEAM UNDER TEST: resolveGitHubRepoId throws (network failure).
vi.mock('../lib/cli-github-client-port.js', () => ({
  createCliGitHubClientPort: vi.fn(),
  resolveGitHubRepoId: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { reviewPipeline } from 'ghagga-core';
import { resolveGitHubRepoId } from '../lib/cli-github-client-port.js';
import { postSummaryComment } from '../lib/pr-postback.js';
import { resolvePrToken } from '../lib/pr-token.js';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);
const mockResolvePrToken = vi.mocked(resolvePrToken);
const mockResolveGitHubRepoId = vi.mocked(resolveGitHubRepoId);
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

describe('reviewCommand — --pr nativeId NETWORK-FAILURE fallback (FIX 4)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let exitSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let warnSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExecSync.mockReturnValue('git@github.com:acme/ci.git' as never);
    mockReviewPipeline.mockResolvedValue(passedResult());
    mockResolvePrToken.mockReturnValue('gh-token');
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 7, deletedNativeIds: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /repos throws → post-back proceeds with path-shaped nativeId + warn, exit 0', async () => {
    mockResolveGitHubRepoId.mockRejectedValue(new Error('ECONNRESET'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 42, outputFormat: 'sarif' }));

    // Graceful: the post-back still ran (no crash) and the job did not fail.
    expect(mockPostSummaryComment).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // The RepoRef carried the OPAQUE path-shaped fallback, NOT the numeric id.
    const ref = mockPostSummaryComment.mock.calls[0]?.[1] as {
      repo: { kind: string; nativeId: string; path?: string };
      iid: number;
    };
    expect(ref.repo).toEqual({ kind: 'github', nativeId: 'acme/ci', path: 'acme/ci' });
    expect(ref.iid).toBe(42);

    // The degradation was surfaced (non-silent).
    const warnText = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warnText).toContain('Could not resolve numeric GitHub repo id');
    expect(warnText).toContain('falling back to the owner/repo path');
  });
});
