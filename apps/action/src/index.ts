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

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as github from '@actions/github';
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  LLMProvider,
  MemoryStorage,
  ReviewMode,
} from 'ghagga-core';
import {
  createEmbeddingProvider,
  DEFAULT_MODELS,
  DEFAULT_SETTINGS,
  formatReviewComment,
  REVIEW_COMMENT_MARKER,
  resolveEmbeddingConfig,
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

// ─── Embedding provider (Action-never-local, design D7 / task 5.3) ──
//
// The Action bundle excludes the local Transformers.js provider entirely
// (ncc externals, PR7) — it can only ever resolve `none` or the
// OpenAI-compatible HTTP provider. If a workflow author sets
// `embedding-provider: local` anyway, coerce to `none` with a warning
// instead of letting the (excluded) import ever get attempted.
/** `core.getInput` returns `''` for an unset input; the resolver expects `undefined` for "not set" (an empty string would fail Zod's `min(1)` instead of triggering the default). */
function actionInputOrUndefined(name: string): string | undefined {
  const value = core.getInput(name);
  return value === '' ? undefined : value;
}

function resolveActionEmbeddingConfig(): EmbeddingConfig {
  const rawProvider = actionInputOrUndefined('embedding-provider');
  if (rawProvider === 'local') {
    core.warning(
      '[ghagga] embedding-provider "local" is not available in the GitHub Action ' +
        '(no bundled local model) — falling back to "none". Use "openai-compatible" ' +
        'with embedding-base-url/embedding-api-key for semantic search in Actions.',
    );
  }
  return resolveEmbeddingConfig({
    EMBEDDING_PROVIDER: rawProvider === 'local' ? 'none' : rawProvider,
    EMBEDDING_MODEL: actionInputOrUndefined('embedding-model'),
    EMBEDDING_BASE_URL: actionInputOrUndefined('embedding-base-url'),
    EMBEDDING_API_KEY: actionInputOrUndefined('embedding-api-key'),
    EMBEDDING_DIMENSION: actionInputOrUndefined('embedding-dimension'),
    EMBEDDING_CANDIDATE_K: actionInputOrUndefined('embedding-candidate-k'),
  });
}

/** Build the provider from the Action's resolved config — never `local`. */
function resolveActionEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | undefined {
  return createEmbeddingProvider(config) ?? undefined;
}

// ─── Memory path isolation ──────────────────────────────────────

interface MemoryPaths {
  /** Private per-run directory (mode 0700). Holds the working DB + staging file. */
  perRunDir: string;
  /** Isolated live SQLite database for this run. Never shared across runs/jobs. */
  workingDbPath: string;
  /** Staging path inside perRunDir used to atomically materialize the DB. */
  stagingDbPath: string;
  /** Directory holding the stable cache staging file. */
  cacheDir: string;
  /** Stable per-repo path used for cache restore/save I/O (continuity across runs). */
  cacheFilePath: string;
}

/** Replace path-hostile characters so identifiers are safe as path segments. */
function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Build filesystem paths for the review memory database.
 *
 * The live SQLite file lives in a private, per-run directory so that two runs
 * — even concurrent jobs of the same repository on a persistent self-hosted
 * runner — never open the same physical file. `runId`/`runAttempt`/`jobId`
 * scope the CI run; `process.pid` + a random suffix guarantee uniqueness even
 * when those collide.
 *
 * `@actions/cache` restores an archive to the exact absolute path it was saved
 * from, so cross-run continuity requires a path that does NOT vary per run.
 * `cacheFilePath` provides that stable, per-repo staging path; the working DB
 * stays isolated and the cache file is only touched briefly for copy in/out.
 */
function resolveMemoryPaths(params: {
  repoFullName: string;
  repoId: string;
  runId: string | number;
  runAttempt: string | number;
  jobId: string;
}): MemoryPaths {
  const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
  const repoSlug = sanitizeForPath(params.repoFullName);
  const uniqueSuffix = [
    sanitizeForPath(params.repoId || 'noid'),
    sanitizeForPath(String(params.runId)),
    sanitizeForPath(String(params.runAttempt)),
    sanitizeForPath(params.jobId || 'nojob'),
    String(process.pid),
    randomBytes(4).toString('hex'),
  ].join('-');
  const perRunDir = join(runnerTemp, `ghagga-memory-${repoSlug}-${uniqueSuffix}`);
  const cacheDir = join(runnerTemp, 'ghagga-memory-cache');
  return {
    perRunDir,
    workingDbPath: join(perRunDir, 'memory.db'),
    stagingDbPath: join(perRunDir, 'memory.restore.db'),
    cacheDir,
    cacheFilePath: join(cacheDir, `${repoSlug}.db`),
  };
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
    // GitHub Actions caches are immutable (write-once per key), so saving with
    // a fixed key only works on the very first run. runId alone is NOT unique
    // either: it stays the same across re-runs of a workflow run, so a re-run
    // would hit the already-written key and the save would fail. Include
    // runAttempt to make the key unique per attempt, and restore via prefix
    // fallback to pick up the most recent snapshot.
    //
    // The physical database file is isolated per run (see resolveMemoryPaths):
    // a shared /tmp/ghagga-memory.db would leak memory between repositories and
    // corrupt under concurrency on persistent self-hosted runners.
    const runAttempt = context.runAttempt ?? Number(process.env.GITHUB_RUN_ATTEMPT ?? '1');
    const memoryPaths = resolveMemoryPaths({
      repoFullName,
      repoId: String(context.payload.repository?.id ?? process.env.GITHUB_REPOSITORY_ID ?? ''),
      runId: context.runId,
      runAttempt,
      jobId: process.env.GITHUB_JOB ?? '',
    });
    const memoryCacheBaseKey = `ghagga-memory-${repoFullName.replace('/', '-')}`;
    const memoryCacheSaveKey = `${memoryCacheBaseKey}-${context.runId}-${runAttempt}`;
    let memoryStorage: MemoryStorage | undefined;

    if (enableMemory) {
      // Create the private per-run directory (owner-only) and the cache staging
      // directory. Non-fatal: memory is a best-effort enhancement.
      try {
        mkdirSync(memoryPaths.perRunDir, { recursive: true, mode: 0o700 });
        mkdirSync(memoryPaths.cacheDir, { recursive: true });
      } catch (error) {
        core.warning(
          `[ghagga] Failed to prepare memory directory (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Restore cached database into the stable staging path, then atomically
      // move it into the isolated working path. Fallbacks: newest run-suffixed
      // key first, then the bare base key (old-format caches from existing
      // users). On a miss OR any failure we do NOT mark the DB as restored, so
      // the step below guarantees the working destination starts empty — we
      // never open a residual file left by another repository's previous run.
      let restored = false;
      try {
        const hitKey = await cache.restoreCache([memoryPaths.cacheFilePath], memoryCacheSaveKey, [
          `${memoryCacheBaseKey}-`,
          memoryCacheBaseKey,
        ]);
        if (hitKey && existsSync(memoryPaths.cacheFilePath)) {
          copyFileSync(memoryPaths.cacheFilePath, memoryPaths.stagingDbPath);
          renameSync(memoryPaths.stagingDbPath, memoryPaths.workingDbPath);
          restored = true;
          core.info(`🧠 Memory cache hit (key: ${hitKey})`);
        } else {
          core.info('🧠 Memory cache miss — starting with fresh database');
        }
      } catch (error) {
        core.warning(
          `[ghagga] Failed to restore memory cache (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!restored) {
        // No trusted snapshot for this repo/run: remove any residual file so
        // the new database starts empty and isolated.
        try {
          rmSync(memoryPaths.workingDbPath, { force: true });
          rmSync(memoryPaths.stagingDbPath, { force: true });
        } catch (error) {
          core.warning(
            `[ghagga] Failed to clear residual memory file (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Create SQLite memory storage on the isolated working path. Provider
      // resolution never selects `local` here (task 5.3, design D7) — the
      // Action bundle excludes the local dependency tree entirely.
      try {
        const embeddingConfig = resolveActionEmbeddingConfig();
        const embeddingProvider = resolveActionEmbeddingProvider(embeddingConfig);
        memoryStorage = await SqliteMemoryStorage.create(memoryPaths.workingDbPath, {
          ...(embeddingProvider
            ? {
                embeddingProvider,
                embeddingModel: embeddingConfig.model,
                embeddingCandidateK: embeddingConfig.candidateK,
              }
            : {}),
        });
        core.info('🧠 Memory storage initialized');
      } catch (error) {
        core.warning(
          `[ghagga] Failed to initialize memory (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
        memoryStorage = undefined;
      }
    }

    // Steps 6-7: Run the pipeline and publish the comment. The memory snapshot
    // lifecycle is wrapped in try/finally so SQLite is ALWAYS closed — and the
    // cache saved only after a clean close — even if the pipeline or the
    // comment publication throws. Comment publication is further decoupled from
    // the review result: a failure to post/update the comment must not discard
    // the memory snapshot nor the computed review outputs.
    let result: Awaited<ReturnType<typeof reviewPipeline>> | undefined;
    try {
      // Step 6: Run the review pipeline
      result = await reviewPipeline({
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

      // Step 7: Post or update the review comment (idempotent). Isolated in its
      // own try/catch so a transient GitHub API failure here is non-fatal and
      // does not abort the memory-persistence `finally` below.
      try {
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

        const existingComment = existingComments.find((c) =>
          c.body?.includes(REVIEW_COMMENT_MARKER),
        );

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
      } catch (commentError) {
        core.warning(
          `[ghagga] Failed to publish review comment (non-fatal): ${commentError instanceof Error ? commentError.message : String(commentError)}`,
        );
      }
    } finally {
      // Step 7.5: Close memory and persist to cache. Runs even when the
      // pipeline threw (the error still propagates to the outer catch after).
      if (memoryStorage) {
        let closedCleanly = false;
        try {
          await memoryStorage.close();
          closedCleanly = true;
          core.info('🧠 Memory database persisted to disk');
        } catch (error) {
          core.warning(
            `[ghagga] Failed to close memory storage (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Cache ONLY after a clean close so the archived file is a consistent
        // snapshot, and only if the working DB actually exists on disk.
        if (closedCleanly) {
          try {
            if (existsSync(memoryPaths.workingDbPath)) {
              copyFileSync(memoryPaths.workingDbPath, memoryPaths.cacheFilePath);
              await cache.saveCache([memoryPaths.cacheFilePath], memoryCacheSaveKey);
              core.info('🧠 Memory cache saved');
            }
          } catch (error) {
            core.warning(
              `[ghagga] Failed to save memory cache (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Best-effort cleanup of the private per-run directory so nothing
        // residual survives for a later run on a persistent runner.
        try {
          rmSync(memoryPaths.perRunDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup failures — the directory is per-run and disposable.
        }
      }
    }

    // Step 8: Set outputs. `result` is defined unless the pipeline threw, in
    // which case the exception already propagated to the outer catch below.
    if (result) {
      core.setOutput('status', result.status);
      core.setOutput('findings-count', result.findings.length);

      // Step 9: Fail the action if review status is FAILED
      if (result.status === 'FAILED') {
        core.setFailed(
          `Code review found critical issues. Status: ${result.status} | ` +
            `Findings: ${result.findings.length}`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`GHAGGA review failed: ${message}`);
  }
}

// ─── Execute ────────────────────────────────────────────────────

export { resolveMemoryPaths, run };

// Only auto-run when executed directly (not imported by tests)
if (process.env.NODE_ENV !== 'test') {
  run();
}
