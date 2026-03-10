import type { ReviewResult } from 'ghagga-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createComment,
  createIssue,
  ensureLabel,
  formatIssueBody,
  GitHubApiError,
  parseGitHubRemote,
} from './github-api.js';

// ─── Mocks ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(message),
    json: () => Promise.resolve({ message }),
  } as Response;
}

/** Minimal ReviewResult for formatting tests. */
function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'All good',
    findings: [
      {
        severity: 'medium',
        category: 'style',
        file: 'src/index.ts',
        line: 10,
        message: 'Use const',
        source: 'ai',
      },
      {
        severity: 'high',
        category: 'security',
        file: 'src/auth.ts',
        message: 'Unsafe input',
        source: 'semgrep',
      },
    ],
    staticAnalysis: {
      semgrep: { status: 'success', findings: [], executionTimeMs: 100 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'github',
      model: 'gpt-4o-mini',
      tokensUsed: 500,
      executionTimeMs: 3200,
      toolsRun: ['semgrep'],
      toolsSkipped: ['trivy', 'cpd'],
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('parseGitHubRemote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('parses SSH URL (git@host:owner/repo.git)', () => {
    expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('parses SSH protocol URL (ssh://git@github.com/owner/repo.git)', () => {
    expect(parseGitHubRemote('ssh://git@github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('parses URL without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/acme/widgets')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('throws on non-GitHub URL', () => {
    expect(() => parseGitHubRemote('https://gitlab.com/acme/widgets.git')).toThrow(
      'Not a GitHub remote URL',
    );
  });
});

describe('createIssue', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseOpts = {
    token: 'ghp_test123',
    owner: 'acme',
    repo: 'widgets',
    title: 'Test Issue',
    body: 'Issue body',
    labels: ['ghagga-review'],
  };

  it('returns url and number on 201', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, { html_url: 'https://github.com/acme/widgets/issues/42', number: 42 }),
    );

    const result = await createIssue(baseOpts);

    expect(result).toEqual({ url: 'https://github.com/acme/widgets/issues/42', number: 42 });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/issues',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws GitHubApiError on 401', async () => {
    mockFetch.mockResolvedValue(errorResponse(401, 'Bad credentials'));

    await expect(createIssue(baseOpts)).rejects.toThrow(GitHubApiError);
    await expect(createIssue(baseOpts)).rejects.toThrow(/Authentication failed/);
  });

  it('throws GitHubApiError on 410 (issues disabled)', async () => {
    mockFetch.mockResolvedValue(errorResponse(410, 'Issues are disabled'));

    await expect(createIssue(baseOpts)).rejects.toThrow(GitHubApiError);
    await expect(createIssue(baseOpts)).rejects.toThrow(/Issues are disabled/);
  });

  it('throws GitHubApiError on 429 (rate limit)', async () => {
    mockFetch.mockResolvedValue(errorResponse(429, 'Rate limit'));

    await expect(createIssue(baseOpts)).rejects.toThrow(GitHubApiError);
    await expect(createIssue(baseOpts)).rejects.toThrow(/rate limit/);
  });
});

describe('createComment', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseOpts = {
    token: 'ghp_test123',
    owner: 'acme',
    repo: 'widgets',
    issueNumber: 42,
    body: 'Comment body',
  };

  it('returns url on 201', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-1',
      }),
    );

    const result = await createComment(baseOpts);

    expect(result).toEqual({
      url: 'https://github.com/acme/widgets/issues/42#issuecomment-1',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/issues/42/comments',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws GitHubApiError on 404 (issue not found)', async () => {
    mockFetch.mockResolvedValue(errorResponse(404, 'Not Found'));

    await expect(createComment(baseOpts)).rejects.toThrow(GitHubApiError);
    await expect(createComment(baseOpts)).rejects.toThrow(/not found/);
  });
});

describe('ensureLabel', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseOpts = {
    token: 'ghp_test123',
    owner: 'acme',
    repo: 'widgets',
    name: 'ghagga-review',
    color: '0ea5e9',
    description: 'Automated review by GHAGGA',
  };

  it('succeeds on 201 (label created)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { name: 'ghagga-review' }));

    await expect(ensureLabel(baseOpts)).resolves.toBeUndefined();
  });

  it('silently ignores 422 (label already exists)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(422, 'Validation Failed'));

    await expect(ensureLabel(baseOpts)).resolves.toBeUndefined();
  });

  it('silently ignores 403 (insufficient permissions)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

    await expect(ensureLabel(baseOpts)).resolves.toBeUndefined();
  });
});

describe('formatIssueBody', () => {
  it('contains <details> tag for collapsible section', () => {
    const body = formatIssueBody(makeResult(), '2.5.0');
    expect(body).toContain('<details>');
    expect(body).toContain('</details>');
  });

  it('contains finding counts by severity', () => {
    const body = formatIssueBody(makeResult(), '2.5.0');
    expect(body).toContain('medium: 1');
    expect(body).toContain('high: 1');
    expect(body).toContain('2 total');
  });

  it('contains GHAGGA version in footer', () => {
    const body = formatIssueBody(makeResult(), '2.5.0');
    expect(body).toContain('v2.5.0');
    expect(body).toContain('GHAGGA');
  });

  it('shows "none" when there are zero findings', () => {
    const body = formatIssueBody(makeResult({ findings: [] }), '2.5.0');
    expect(body).toContain('0 total');
    expect(body).toContain('none');
  });
});
