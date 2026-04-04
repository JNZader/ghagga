/**
 * GHAGGA GitHub Action — AI-powered code review for pull requests.
 *
 * Runs the core review pipeline on PR diffs and posts results
 * as comments. Designed to be used in GitHub Actions workflows:
 *
 *   # Free with GitHub Models (default, no API key needed):
 *   - uses: JNZader/ghagga@v2
 *
 *   # With a paid provider:
 *   - uses: JNZader/ghagga@v2
 *     with:
 *       provider: anthropic
 *       api-key: ${{ secrets.ANTHROPIC_API_KEY }}
 *
 *   # With Qwen (Alibaba Cloud DashScope):
 *   - uses: JNZader/ghagga@v2
 *     with:
 *       provider: qwen
 *       api-key: ${{ secrets.DASHSCOPE_API_KEY }}
 */

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import type { LLMProvider, MemoryStorage, ReviewMode } from 'ghagga-core';
import {
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  formatReviewComment,
  REVIEW_COMMENT_MARKER,
  reviewPipeline,
  SqliteMemoryStorage,
} from 'ghagga-core';
import { runLocalAnalysis } from './tools/index.js';

// ─── Main ───────────────────────────────────────────────────────

// ─── Legacy Provider Mapping ────────────────────────────────────

/**
 * Providers that existed before the v3 refactor and must be silently
 * remapped to 'gateway' when passed via the action.yml `provider` input.
 * 'github' is the most common case (it was the default in v1/v2).
 */
const ACTION_LEGACY_PROVIDERS = new Set([
  'github',
  'anthropic',
  'openai',
  'google',
  'groq',
  'openrouter',
  'azure',
  'deepseek',
  'qwen',
  'cerebras',
]);

function resolveActionProvider(raw: string): LLMProvider {
  if (raw === 'cli-bridge' || raw === 'ollama' || raw === 'gateway') {
    return raw as LLMProvider;
  }
  if (ACTION_LEGACY_PROVIDERS.has(raw)) {
    core.warning(
      `[ghagga] Provider "${raw}" is no longer supported directly. ` +
        'Remapping to "gateway". Update your workflow to use provider: gateway ' +
        'and configure credentials in mcp-llm-bridge. ' +
        'See: https://github.com/JNZader/mcp-llm-bridge',
    );
    return 'gateway';
  }
  core.warning(`[ghagga] Unknown provider "${raw}" — defaulting to "gateway".`);
  return 'gateway';
}

// ─── Main ───────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // Step 1: Read action inputs
    const rawProvider = core.getInput('provider') || 'github';
    const provider = resolveActionProvider(rawProvider);
    const modelInput = core.getInput('model');
    const mode = (core.getInput('mode') || 'simple') as ReviewMode;
    const apiKeyInput = core.getInput('api-key');

    // Legacy per-tool boolean flags (backward compat)
    const enableSemgrep = core.getInput('enable-semgrep') !== 'false';
    const enableTrivy = core.getInput('enable-trivy') !== 'false';
    const enableCpd = core.getInput('enable-cpd') !== 'false';
    const enableMemory = core.getInput('enable-memory') !== 'false';

    // New registry-driven tool selection inputs (comma-separated strings)
    const enabledToolsInput = core.getInput('enabled-tools');
    const disabledToolsInput = core.getInput('disabled-tools');
    const enabledTools = enabledToolsInput
      ? enabledToolsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const disabledTools = disabledToolsInput
      ? disabledToolsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Step 2: Resolve GitHub token (for PR diff fetching + GitHub Models API)
    const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';

    if (!githubToken) {
      core.setFailed(
        'GitHub token is required to fetch PR diffs and post comments. ' +
          'The GITHUB_TOKEN is usually available automatically in Actions.',
      );
      return;
    }

    // Step 3: Resolve API key
    let apiKey: string;
    if (provider === 'ollama') {
      apiKey = apiKeyInput || 'ollama';
    } else if (provider === 'gateway') {
      // Gateway token is optional — the gateway itself may handle auth
      apiKey = apiKeyInput || '';
    } else if (provider === 'cli-bridge') {
      // CLI bridge uses whatever credential the tool accepts (optional)
      apiKey = apiKeyInput || '';
    } else {
      // Should not be reached after resolveActionProvider, but guard defensively
      apiKey = apiKeyInput || '';
    }

    // Resolve model: use input, or default based on provider
    const model = modelInput || DEFAULT_MODELS[provider];

    // Step 4: Get PR context
    const { context } = github;
    const pr = context.payload.pull_request;

    if (!pr) {
      core.setFailed(
        'This action must be triggered by a pull_request event. ' +
          'Add `on: pull_request` to your workflow.',
      );
      return;
    }

    const repoFullName = `${context.repo.owner}/${context.repo.repo}`;
    const prNumber = pr.number as number;

    core.info(`🤖 GHAGGA reviewing PR #${prNumber} on ${repoFullName}`);
    core.info(`   Mode: ${mode} | Provider: ${provider} | Model: ${model}`);

    // Step 5: Fetch the PR diff
    const octokit = github.getOctokit(githubToken);

    const diffResponse = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });

    // The diff comes back as a string when requesting diff format
    const diff = diffResponse.data as unknown as string;

    if (!diff || (typeof diff === 'string' && diff.trim().length === 0)) {
      core.info('⏭️  PR has no diff content. Skipping review.');
      core.setOutput('status', 'SKIPPED');
      core.setOutput('findings-count', 0);
      return;
    }

    // Step 5.5: Run local static analysis
    core.info('Running static analysis tools...');
    const repoDir = process.env.GITHUB_WORKSPACE ?? '.';
    const staticAnalysis = await runLocalAnalysis({
      enableSemgrep,
      enableTrivy,
      enableCpd,
      enabledTools,
      disabledTools,
      repoDir,
    });

    // Log a summary of static analysis results (dynamic — all tools)
    const toolSummaries: string[] = [];
    let totalFindings = 0;
    for (const [name, toolResult] of Object.entries(staticAnalysis)) {
      if (toolResult && typeof toolResult === 'object' && 'findings' in toolResult) {
        const count = toolResult.findings.length;
        totalFindings += count;
        if (toolResult.status === 'success' && count > 0) {
          toolSummaries.push(`${name}: ${count}`);
        }
      }
    }
    core.info(
      `Static analysis summary: ${totalFindings} findings` +
        (toolSummaries.length > 0 ? ` (${toolSummaries.join(', ')})` : ''),
    );

    // Step 5.6: Initialize review memory (SQLite + @actions/cache)
    const MEMORY_DB_PATH = '/tmp/ghagga-memory.db';
    const cacheKey = `ghagga-memory-${repoFullName.replace('/', '-')}`;
    let memoryStorage: MemoryStorage | undefined;

    if (enableMemory) {
      // Restore cached database file
      try {
        const hitKey = await cache.restoreCache([MEMORY_DB_PATH], cacheKey, [cacheKey]);
        if (hitKey) {
          core.info(`🧠 Memory cache hit (key: ${hitKey})`);
        } else {
          core.info('🧠 Memory cache miss — starting with fresh database');
        }
      } catch (error) {
        core.warning(
          `[ghagga] Failed to restore memory cache (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Create SQLite memory storage
      try {
        memoryStorage = await SqliteMemoryStorage.create(MEMORY_DB_PATH);
        core.info('🧠 Memory storage initialized');
      } catch (error) {
        core.warning(
          `[ghagga] Failed to initialize memory (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
        memoryStorage = undefined;
      }
    }

    // Step 6: Run the review pipeline
    const result = await reviewPipeline({
      diff: typeof diff === 'string' ? diff : String(diff),
      mode,
      provider,
      model,
      apiKey,
      settings: {
        ...DEFAULT_SETTINGS,
        enableSemgrep,
        enableTrivy,
        enableCpd,
        enableMemory,
        enabledTools,
        disabledTools,
      },
      context: {
        repoFullName,
        prNumber,
        commitMessages: [],
        fileList: [],
      },
      memoryStorage,
      precomputedStaticAnalysis: staticAnalysis,
    });

    // Step 7: Post or update the review comment (idempotent)
    const comment = formatReviewComment(result, {
      fileStats:
        result.metadata.totalAdditions !== undefined
          ? {
              additions: result.metadata.totalAdditions,
              deletions: result.metadata.totalDeletions ?? 0,
            }
          : undefined,
      fileList: result.metadata.fileList,
    });

    // Look for an existing GHAGGA comment to update (idempotent)
    const { data: existingComments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existingComment = existingComments.find((c) => c.body?.includes(REVIEW_COMMENT_MARKER));

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existingComment.id,
        body: comment,
      });
      core.info(`✅ Review updated on PR #${prNumber} (comment ${existingComment.id})`);
    } else {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: comment,
      });
      core.info(`✅ Review posted to PR #${prNumber}`);
    }

    // Step 7.5: Persist memory to cache
    if (memoryStorage) {
      try {
        await memoryStorage.close();
        core.info('🧠 Memory database persisted to disk');
      } catch (error) {
        core.warning(
          `[ghagga] Failed to close memory storage (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        await cache.saveCache([MEMORY_DB_PATH], cacheKey);
        core.info('🧠 Memory cache saved');
      } catch (error) {
        core.warning(
          `[ghagga] Failed to save memory cache (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Step 8: Set outputs
    core.setOutput('status', result.status);
    core.setOutput('findings-count', result.findings.length);

    // Step 9: Fail the action if review status is FAILED
    if (result.status === 'FAILED') {
      core.setFailed(
        `Code review found critical issues. Status: ${result.status} | ` +
          `Findings: ${result.findings.length}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`GHAGGA review failed: ${message}`);
  }
}

// ─── Execute ────────────────────────────────────────────────────

export { run };

// Only auto-run when executed directly (not imported by tests)
if (process.env.NODE_ENV !== 'test') {
  run();
}
