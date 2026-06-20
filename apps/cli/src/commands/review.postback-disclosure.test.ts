/**
 * SECURITY HYGIENE — before the CLI posts a review back to a forge (`--pr` GitHub
 * PR / `--mr` GitLab MR), it discloses the DESTINATION HOST on stderr so the user
 * sees where their token is going BEFORE the network POST fires.
 *
 * Rationale: the GitLab API base is derived from the git remote host, so a
 * poisoned `origin` could exfiltrate GITLAB_TOKEN. Disclosing the REAL resolved
 * host makes that visible.
 *
 * These tests assert:
 *   - the disclosure line is emitted to STDERR (console.error), NOT stdout
 *     (stdout is reserved for SARIF / JSON / markdown output)
 *   - the host is correct for --pr (api.github.com) and --mr (gitlab.com)
 *   - a self-hosted GitLab remote discloses THAT host (real resolution, not a
 *     mock) — this is the poisoned-origin-visible case
 *
 * For the GitLab path we deliberately use the REAL parseGitLabRemote +
 * resolveGitLabApiBase (only the network seams are mocked) so the host shown is
 * the genuinely-resolved destination.
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

// Token + post-back seams (network) are mocked; remote-parse + api-base are REAL.
vi.mock('../lib/pr-token.js', () => ({ resolvePrToken: vi.fn() }));
vi.mock('../lib/gitlab-token.js', () => ({ resolveMrToken: vi.fn() }));
vi.mock('../lib/pr-postback.js', () => ({ postSummaryComment: vi.fn() }));
vi.mock('../lib/github-api.js', () => ({
  parseGitHubRemote: vi.fn().mockReturnValue({ owner: 'acme', repo: 'ci' }),
  createComment: vi.fn(),
  createIssue: vi.fn(),
  ensureLabel: vi.fn(),
  formatIssueBody: vi.fn(),
}));
// NOTE: gitlab-api.js (parseGitLabRemote) and the resolveGitLabApiBase host
// derivation are NOT mocked — we want the REAL resolved host disclosed.
vi.mock('../lib/cli-gitlab-client-port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cli-gitlab-client-port.js')>();
  return {
    ...actual,
    createCliGitLabClientPort: vi.fn(),
    resolveGitLabProjectId: vi.fn().mockResolvedValue('12345'),
  };
});
vi.mock('ghagga-forge', () => ({
  GitHubForgeAdapter: class {},
  GitLabForgeAdapter: class {},
  StaticTokenProvider: class {
    async getToken() {
      return 'tok';
    }
  },
}));
vi.mock('../lib/cli-github-client-port.js', () => ({ createCliGitHubClientPort: vi.fn() }));

import { execSync } from 'node:child_process';
import { reviewPipeline } from 'ghagga-core';
import { resolveMrToken } from '../lib/gitlab-token.js';
import { postSummaryComment } from '../lib/pr-postback.js';
import { resolvePrToken } from '../lib/pr-token.js';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);
const mockResolvePrToken = vi.mocked(resolvePrToken);
const mockResolveMrToken = vi.mocked(resolveMrToken);
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

describe('reviewCommand — forge post-back DESTINATION HOST disclosure (stderr)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let errorSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReviewPipeline.mockResolvedValue(passedResult());
    mockPostSummaryComment.mockResolvedValue({ createdNativeId: 77, deletedNativeIds: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** All console.error lines as one blob for substring assertions. */
  function stderrBlob(): string {
    return errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }
  function stdoutBlob(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  it('--pr discloses api.github.com on stderr (not stdout), before the POST', async () => {
    mockResolvePrToken.mockReturnValue('ghp');
    mockExecSync.mockReturnValue('git@github.com:acme/ci.git' as never);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ pr: 3, outputFormat: 'sarif' }));

    expect(stderrBlob()).toContain('→ Posting PR #3 review to api.github.com');
    // MUST NOT pollute stdout (SARIF lives there).
    expect(stdoutBlob()).not.toContain('Posting PR');
    expect(stdoutBlob()).not.toContain('api.github.com');
  });

  it('--mr discloses the gitlab.com host on stderr (not stdout)', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    mockExecSync.mockReturnValue('git@gitlab.com:acme/widgets.git' as never);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    expect(stderrBlob()).toContain('→ Posting MR #7 review to gitlab.com');
    expect(stdoutBlob()).not.toContain('Posting MR');
    expect(stdoutBlob()).not.toContain('gitlab.com');
  });

  it('--mr on a SELF-HOSTED GitLab discloses THAT host (poisoned-origin visible)', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    // The git remote points at a self-managed/poisoned host — the disclosure must
    // surface the REAL resolved API host, not a hardcoded gitlab.com.
    mockExecSync.mockReturnValue('git@gitlab.internal.example:team/app.git' as never);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 42, outputFormat: 'sarif' }));

    expect(stderrBlob()).toContain('→ Posting MR #42 review to gitlab.internal.example');
    expect(stdoutBlob()).not.toContain('gitlab.internal.example');
  });

  it('the disclosure is emitted BEFORE the post (host shown even when the post throws)', async () => {
    mockResolveMrToken.mockReturnValue('glpat');
    mockExecSync.mockReturnValue('git@gitlab.com:acme/widgets.git' as never);
    mockPostSummaryComment.mockRejectedValue(new Error('GitLab 500'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ mr: 7, outputFormat: 'sarif' }));

    // Disclosure present even though the post failed afterwards.
    expect(stderrBlob()).toContain('→ Posting MR #7 review to gitlab.com');
  });
});
