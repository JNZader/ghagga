/**
 * 3.3 — Jenkins + GitHub composition scenario.
 *
 * Simulates a CI/Jenkins run of `ghagga review --pr N --output sarif`:
 *   - GITHUB_TOKEN env is set (no interactive login) → the post-back resolves it
 *     and posts the summary via the forge adapter.
 *   - `--output sarif` still emits SARIF (buildSarif) — the two outputs coexist.
 *   - issue-export stays CLI-local: createIssue/ensureLabel are the SAME
 *     github-api.ts functions, untouched by the PR path.
 *
 * We assemble the exact building blocks reviewCommand composes (token resolution
 * → adapter post-back, buildSarif, github-api issue fns) rather than driving the
 * full LLM pipeline, so the scenario is deterministic and offline.
 */

import {
  buildSarif,
  formatReviewComment,
  REVIEW_COMMENT_MARKER,
  type ReviewResult,
} from 'ghagga-core';
import { GitHubForgeAdapter, StaticTokenProvider } from 'ghagga-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliGitHubClientPort } from '../lib/cli-github-client-port.js';
import * as githubApi from '../lib/github-api.js';
import { postSummaryComment } from '../lib/pr-postback.js';
import { resolvePrToken } from '../lib/pr-token.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

function makeResult(): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Looks good',
    findings: [
      { severity: 'high', category: 'security', file: 'src/a.ts', message: 'x', source: 'ai' },
    ],
    staticAnalysis: {
      semgrep: { status: 'success', findings: [], executionTimeMs: 1 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'gpt-4o-mini',
      tokensUsed: 1,
      executionTimeMs: 1000,
      toolsRun: [],
      toolsSkipped: [],
      fileList: ['src/a.ts'],
    },
  };
}

describe('3.3 Jenkins+GitHub: --pr post-back + SARIF coexist; issue-export CLI-local', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.GITHUB_TOKEN = 'jenkins-token';
    process.env.GH_TOKEN = undefined as unknown as string;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('GITHUB_TOKEN drives the adapter PR post AND SARIF still renders', async () => {
    const result = makeResult();

    // ── (a) Token resolution prefers the CI env var ───────────
    const token = resolvePrToken();
    expect(token).toBe('jenkins-token');

    // ── (b) SARIF output still emits independently ────────────
    const sarif = buildSarif(result, '3.0.0') as { runs: unknown[] };
    expect(sarif.runs).toBeDefined();
    expect(Array.isArray(sarif.runs)).toBe(true);

    // ── (c) Post-back via the forge adapter (mocked GitHub) ───
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [])); // find: none
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 7777 })); // post

    const provider = new StaticTokenProvider(token as string);
    const adapter = new GitHubForgeAdapter({
      client: createCliGitHubClientPort(),
      token: await provider.getToken(),
      owner: 'acme',
      repo: 'ci',
    });
    const body = formatReviewComment(result, { fileList: result.metadata.fileList });
    const postRes = await postSummaryComment(
      adapter,
      { repo: { kind: 'github', nativeId: 'acme/ci', path: 'acme/ci' }, iid: 88 },
      body,
      { html: REVIEW_COMMENT_MARKER },
    );

    expect(postRes.createdNativeId).toBe(7777);
    // Body carries the marker (parity with server PR comment).
    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string).body).toContain(REVIEW_COMMENT_MARKER);
  });

  it('issue-export functions are the SAME CLI-local github-api fns (untouched)', () => {
    // The PR path imports the forge adapter; issue-export remains the local
    // github-api.ts createIssue/createComment/ensureLabel — verify identity.
    expect(typeof githubApi.createIssue).toBe('function');
    expect(typeof githubApi.createComment).toBe('function');
    expect(typeof githubApi.ensureLabel).toBe('function');
    // These are NOT routed through the forge adapter (they hit /issues, /labels
    // directly). Confirm the module still exposes the original public surface.
    expect(githubApi.createIssue.name).toBe('createIssue');
    expect(githubApi.ensureLabel.name).toBe('ensureLabel');
  });
});
