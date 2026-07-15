/**
 * Review command handler.
 *
 * Gets the local git diff, merges configuration from CLI options,
 * environment, and optional .ghagga.json file, then runs the
 * core review pipeline and formats the output.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  DependencyGraph,
  GraphLoader,
  GraphMetadata,
  LLMProvider,
  MemoryStorage,
  ProgressCallback,
  ProgressEvent,
  ProviderChainEntry,
  ReviewMode,
  ReviewResult,
  ReviewSettings,
  ReviewStatus,
  ToolDefinition,
} from 'ghagga-core';
import {
  buildSarif,
  DEFAULT_SETTINGS,
  detectLanguage,
  EngramMemoryStorage,
  FilesystemGraphLoader,
  formatReviewComment,
  GRAPH_VERSION,
  initializeDefaultTools,
  isGraphStale,
  NullGraphLoader,
  PreloadedGraphLoader,
  parseDiffFiles,
  REVIEW_COMMENT_MARKER,
  reviewPipeline,
  SqliteMemoryStorage,
  toolRegistry,
} from 'ghagga-core';
import {
  type ChangeRequestRef,
  GitHubForgeAdapter,
  GitLabForgeAdapter,
  StaticTokenProvider,
} from 'ghagga-forge';
import { createCliGitHubClientPort, resolveGitHubRepoId } from '../lib/cli-github-client-port.js';
import {
  createCliGitLabClientPort,
  resolveGitLabApiBase,
  resolveGitLabProjectId,
} from '../lib/cli-gitlab-client-port.js';
import { getConfigDir, getStoredToken } from '../lib/config.js';
import { resolveCliEmbeddingProvider } from '../lib/embedding.js';
import { composeForgePostback, type ForgeComposition } from '../lib/forge-postback.js';
import { getStagedDiff, resolveProjectId } from '../lib/git.js';
import {
  createComment,
  createIssue,
  ensureLabel,
  formatIssueBody,
  parseGitHubRemote,
} from '../lib/github-api.js';
import { parseGitLabRemote } from '../lib/gitlab-api.js';
import { resolveMrToken } from '../lib/gitlab-token.js';
import { resolvePrToken } from '../lib/pr-token.js';
import { formatBoxSummary, formatMarkdownResult } from '../ui/format.js';
import { resolveStepIcon } from '../ui/theme.js';
import * as tui from '../ui/tui.js';
import { reviewCommitMessage } from './review-commit-msg.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ReviewOptions {
  mode: ReviewMode;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  /** Output format. When set, TUI decorations are suppressed. */
  outputFormat?: 'json' | 'sarif' | 'markdown';
  /** Package version for SARIF output. */
  version?: string;
  semgrep: boolean;
  trivy: boolean;
  cpd: boolean;
  memory: boolean;
  /** Memory backend: 'sqlite' (default) or 'engram' */
  memoryBackend?: 'sqlite' | 'engram';
  config?: string;
  verbose: boolean;
  // Hook-oriented flags (Phase 2: cli-git-hooks)
  staged?: boolean;
  commitMsg?: string;
  exitOnIssues?: boolean;
  quick?: boolean;
  /** Enable AI enhance post-analysis. */
  enhance?: boolean;
  /** Create/update a GitHub issue: "new" or an issue number. */
  issue?: string;
  /** Post the review summary back to a GitHub PR (PR number). */
  pr?: number;
  /** Post the review summary back to a GitLab MR (MR iid). */
  mr?: number;
  /**
   * Make an explicitly-requested `--pr`/`--mr` post-back NON-blocking: a failed
   * post-back (or missing token) is warned and the process still exits on the
   * review's own status. Default false — `--pr`/`--mr` is a requested
   * side-effect, so a failure to perform it is a job failure (non-zero exit) in
   * CI.
   */
  prSoftFail?: boolean;
  // Extensible tool system flags (Phase 7)
  /** Tools to force-disable (repeatable --disable-tool) */
  disableTools: string[];
  /** Tools to force-enable (repeatable --enable-tool) */
  enableTools: string[];
  /** Print all available tools and exit */
  listTools?: boolean;
  /** Comma-separated lens names for fan-out mode (from --lenses flag). */
  lenses?: string;
  /** Path to custom lens definitions directory (from --lens-dir flag). */
  lensDir?: string;
  /**
   * Explicit blast-radius override from `--no-blast-radius`. `false` forces
   * blast-radius off regardless of graph presence / config; `undefined`
   * defers to `.ghagga.json`/auto-detection (see `resolveBlastRadiusEnabled`).
   */
  blastRadius?: boolean;
}

/**
 * A single entry in the `.ghagga.json` `providerChain` array — routes ONE
 * multi-voice reviewer (consensus vote / fan-out lens) to a specific
 * cross-engine target via mcp-llm-bridge. Mirrors `ghagga-core`'s
 * `ProviderChainEntry`, minus `apiKey`: the gateway token is resolved at
 * runtime (CLI `--api-key` / stored login token), never stored in plaintext
 * in the config file.
 */
interface GhaggaConfigProviderChainEntry {
  /** Only 'gateway' entries are meaningful for cross-engine routing. */
  provider: 'gateway';
  /** Model identifier passed to the bridge (e.g. "claude-sonnet-4-6"). */
  model: string;
  /**
   * Bridge-side provider id to route to (e.g. 'cli-claude', 'codex-cli').
   * Short-circuits the bridge's model-based routing.
   */
  targetProvider?: string;
  /** Gateway base URL. Defaults to the first entry's / flat gateway config when omitted. */
  gatewayUrl?: string;
  /** OpenCode model in `provider/model` format (cli-bridge only — unused for gateway). */
  cliModel?: string;
}

interface GhaggaConfig {
  mode?: string;
  provider?: string;
  model?: string;
  enableSemgrep?: boolean;
  enableTrivy?: boolean;
  enableCpd?: boolean;
  customRules?: string[];
  ignorePatterns?: string[];
  reviewLevel?: string;
  // Extensible tool system (Phase 7)
  disabledTools?: string[];
  enabledTools?: string[];
  // Pluggable review lenses (fan-out mode)
  lenses?: string[];
  /**
   * Per-voice cross-engine provider chain (BL-CLI-PROVIDER-CHAIN). When set,
   * consensus (3-vote) and fan-out (N-lens) modes round-robin each voice
   * across these gateway entries instead of hammering a single engine.
   */
  providerChain?: GhaggaConfigProviderChainEntry[];
  /**
   * Enable blast-radius filtering (design v2 D7). `true`/`false` override
   * auto-detection (`.ghagga/graph.json` presence); omit to auto-detect.
   * `--no-blast-radius` (ReviewOptions.blastRadius === false) always wins
   * over this config key.
   */
  enableBlastRadius?: boolean;
}

// ─── Main Command ───────────────────────────────────────────────

export async function reviewCommand(targetPath: string, options: ReviewOptions): Promise<void> {
  const repoPath = resolve(targetPath);

  let memoryStorage: MemoryStorage | undefined;

  try {
    // ── Ensure tool registry is initialized ──────────────────
    initializeDefaultTools();

    // ── Handle --list-tools (exit early, no repo needed) ─────
    if (options.listTools) {
      printToolList(options.outputFormat === 'json' ? 'json' : 'markdown');
      process.exit(0);
    }

    // ── Emit deprecation warnings for old flags ──────────────
    emitDeprecationWarnings(options);

    // ── Validate tool names in --disable-tool / --enable-tool ─
    validateToolNames(options.disableTools, '--disable-tool');
    validateToolNames(options.enableTools, '--enable-tool');

    // ── Mutual exclusivity check: --staged and --commit-msg ──
    if (options.staged && options.commitMsg) {
      tui.log.error('❌ --staged and --commit-msg are mutually exclusive. Use one or the other.');
      process.exit(1);
    }

    // ── Mutual exclusivity check: --pr (GitHub) and --mr (GitLab) ──
    // Defensive guard at the command layer: the CLI index.ts also blocks this, but
    // reviewCommand() must not silently run GitLab and DROP --pr if a caller (or a
    // future entrypoint) reaches it with both set.
    if (options.pr != null && options.mr != null) {
      tui.log.error('❌ --pr and --mr are mutually exclusive. Use one or the other.');
      process.exit(1);
    }

    // ── Commit message review path (bypasses file-based pipeline) ──
    if (options.commitMsg) {
      const commitMsgFile = resolve(options.commitMsg);

      if (!existsSync(commitMsgFile)) {
        tui.log.error(`❌ Commit message file not found: ${commitMsgFile}`);
        process.exit(1);
      }

      const message = readFileSync(commitMsgFile, 'utf-8');

      if (!options.outputFormat) {
        tui.intro('🤖 GHAGGA Commit Message Review');
      }

      const result = await reviewCommitMessage({
        message,
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey,
        quick: options.quick,
      });

      // Output the result based on format
      outputResult(result, options.outputFormat, options.version);

      // Exit code: --exit-on-issues overrides default behavior
      const exitCode = resolveExitCode(result, options.exitOnIssues ?? false);
      if (!options.outputFormat) {
        tui.outro('Commit message review complete');
      }
      process.exit(exitCode);
    }

    // ── Step 1: Get the git diff ─────────────────────────────
    const diff = options.staged ? getStagedDiff(repoPath) : getGitDiff(repoPath);

    if (!diff || diff.trim().length === 0) {
      const msg = options.staged
        ? 'ℹ️  No staged changes found. Stage files with `git add` first.'
        : 'ℹ️  No changes detected. Stage some changes or make commits to review.';
      tui.log.info(msg);
      process.exit(0);
    }

    // Step 2: Load optional config file
    const fileConfig = loadConfigFile(repoPath, options.config);

    // Step 3: Merge settings (CLI options take priority over config file)
    const settings = mergeSettings(options, fileConfig);

    // Step 3.4: Resolve blast-radius auto-ON (design v2 D7) — resolved
    // against repoPath (the review target), not process.cwd() (CRITICAL-2).
    settings.enableBlastRadius = resolveBlastRadiusEnabled(repoPath, options, fileConfig);

    // Step 3.4.5: Wire the local FilesystemGraphLoader + fs fileReader when
    // blast-radius is enabled (design v2 D3/D4), and surface staleness
    // (D2) + partial-language-coverage (D8) as advisory warnings — never
    // blocking. Graph-absent is a silent no-op: applyBlastRadius itself
    // already emits its own "no graph available" pipeline event.
    //
    // The graph is loaded exactly ONCE here (for staleness/coverage). The
    // already-loaded result is then wrapped in a PreloadedGraphLoader (or
    // NullGraphLoader when absent/malformed/oversize) so the pipeline's own
    // `applyBlastRadius` step — which unconditionally calls
    // `graphLoader.load()` — reads it from memory instead of re-reading
    // graph.json (up to 20MB) and re-emitting the oversize/malformed warning
    // a second time (R4-001).
    let graphLoader: GraphLoader | undefined;
    let fileReader: ((filePath: string) => Promise<string | null>) | undefined;

    if (settings.enableBlastRadius) {
      const filesystemGraphLoader = new FilesystemGraphLoader(repoPath, {
        onOversize: (bytes, max) => {
          tui.log.warn(
            `⚠️  Dependency graph exceeds ${max} bytes (actual: ${bytes}) — ignoring, blast-radius disabled for this run.`,
          );
        },
        onMalformed: (reason) => {
          tui.log.warn(`⚠️  Dependency graph is stale/corrupt — ignoring (${reason}).`);
        },
      });
      fileReader = async (filePath: string): Promise<string | null> => {
        try {
          return await readFile(join(repoPath, filePath), 'utf-8');
        } catch {
          return null;
        }
      };

      try {
        const graph = await filesystemGraphLoader.load();
        if (graph) {
          const metadata = await filesystemGraphLoader.loadMetadata();
          let currentHead = '';
          try {
            currentHead = execSync('git rev-parse HEAD', {
              cwd: repoPath,
              encoding: 'utf-8',
            }).trim();
          } catch {
            currentHead = '';
          }

          for (const warning of checkGraphStaleness(metadata, currentHead)) {
            tui.log.warn(`⚠️  ${warning.message}`);
          }

          const changedFiles = parseDiffFiles(diff).map((f) => f.path);
          const uncoveredLanguages = computeUncoveredLanguages(graph, changedFiles);
          if (uncoveredLanguages.length > 0) {
            tui.log.warn(
              `⚠️  Partial graph coverage: no indexed dependents for ${uncoveredLanguages.join(', ')} — ` +
                'blast-radius will show 0 dependents for these files, which may be unreliable rather than accurate.',
            );
          }

          // Hand the pipeline the graph we already loaded — no re-read.
          graphLoader = new PreloadedGraphLoader(graph, metadata);
        } else {
          // Absent/malformed/oversize — filesystemGraphLoader already fired
          // its onOversize/onMalformed warning exactly once above. Hand the
          // pipeline a loader that always resolves to null so it degrades
          // without touching the filesystem again.
          graphLoader = new NullGraphLoader();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tui.log.warn(`⚠️  Blast-radius staleness/coverage check failed (continuing): ${message}`);
        graphLoader = new NullGraphLoader();
      }
    }

    // Step 3.5: Build the per-voice cross-engine provider chain, if configured
    // (BL-CLI-PROVIDER-CHAIN). Undefined when absent — regression-safe, the
    // pipeline falls back to the flat provider/model exactly as before.
    const providerChain = buildProviderChain(fileConfig, options.apiKey);

    // Step 4: Show progress
    if (!options.outputFormat) {
      tui.intro('🤖 GHAGGA Code Review');
      tui.log.message(
        `   Mode: ${options.mode} | Provider: ${options.provider} | Model: ${options.model}`,
      );
      if (options.staged) {
        tui.log.step('   Reviewing staged changes...\n');
      } else {
        tui.log.step('   Analyzing...\n');
      }
    }

    // Step 4.5: Initialize memory storage
    const repoFullName = resolveProjectId(repoPath);

    if (options.memory) {
      // Determine backend: CLI flag > env var > default ('sqlite')
      const memoryBackend =
        options.memoryBackend ??
        (process.env.GHAGGA_MEMORY_BACKEND as 'sqlite' | 'engram' | undefined) ??
        'sqlite';

      // Validate backend value
      const validBackends = ['sqlite', 'engram'] as const;
      if (!validBackends.includes(memoryBackend as (typeof validBackends)[number])) {
        tui.log.error(
          `❌ Invalid memory backend "${memoryBackend}". Choose from: ${validBackends.join(', ')}`,
        );
        process.exit(1);
      }

      try {
        const dbPath = join(getConfigDir(), 'memory.db');

        // Provider + model/candidateK threaded from the merged CLI config
        // (design D2, task 5.2) — when unconfigured, `provider` is undefined
        // and SqliteMemoryStorage falls back to keyword-only search unchanged.
        const { config: embeddingConfig, provider: embeddingProvider } =
          resolveCliEmbeddingProvider();
        const sqliteOptions = embeddingProvider
          ? {
              embeddingProvider,
              embeddingModel: embeddingConfig.model,
              embeddingCandidateK: embeddingConfig.candidateK,
            }
          : {};

        if (memoryBackend === 'engram') {
          // Try Engram; fall back to SQLite if unavailable
          const engramHost = process.env.GHAGGA_ENGRAM_HOST ?? 'http://localhost:7437';
          const engramTimeout = process.env.GHAGGA_ENGRAM_TIMEOUT
            ? Number(process.env.GHAGGA_ENGRAM_TIMEOUT) * 1000
            : undefined;

          const engramStorage = await EngramMemoryStorage.create({
            host: engramHost,
            ...(engramTimeout != null ? { timeout: engramTimeout } : {}),
          });

          if (engramStorage) {
            memoryStorage = engramStorage;
          } else {
            tui.log.warn('⚠️  Engram not available, falling back to SQLite memory');
            memoryStorage = await SqliteMemoryStorage.create(dbPath, sqliteOptions);
          }
        } else {
          memoryStorage = await SqliteMemoryStorage.create(dbPath, sqliteOptions);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        tui.log.warn(`⚠️  Failed to initialize memory: ${msg}`);
        memoryStorage = undefined;
      }
    }

    // Compute total steps for progress indicator
    const FIXED_PIPELINE_STEPS = 5; // validate, parse-diff, detect-stacks, agent/quick, memory
    const activeToolCount = Math.max(settings.enabledTools?.length ?? 3, 3);
    const totalSteps = FIXED_PIPELINE_STEPS + activeToolCount;

    // Step 5: Create progress handler
    let stepIndex = 0;

    let s: ReturnType<typeof tui.spinner> | undefined;
    if (!options.outputFormat) {
      s = tui.spinner();
      tui.setActiveSpinner(s);
      s.start('Starting review...');
    }

    const onProgress: ProgressCallback = options.verbose
      ? createProgressHandler()
      : (event: ProgressEvent) => {
          stepIndex++;
          if (!options.outputFormat) {
            tui.progress(stepIndex, totalSteps, event.message);
          }
        };

    const result = await reviewPipeline({
      diff,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      settings,
      context: {
        repoFullName,
        prNumber: 0,
        commitMessages: [],
        fileList: [],
      },
      memoryStorage,
      onProgress,
      enhance: options.enhance,
      // --quick: disable AI review, use static analysis only
      ...(options.quick ? { aiReviewEnabled: false } : {}),
      // Per-voice cross-engine routing (BL-CLI-PROVIDER-CHAIN) — undefined
      // when `.ghagga.json` has no providerChain, unchanged flat-provider path.
      ...(providerChain ? { providerChain } : {}),
      // Blast-radius (design v2) — undefined when disabled/no graph, matching
      // the pre-existing `applyBlastRadius` gate (`enableBlastRadius && graphLoader`).
      ...(graphLoader ? { graphLoader } : {}),
      ...(fileReader ? { fileReader } : {}),
    });

    // Step 5.5: Persist memory to disk
    await memoryStorage?.close();

    if (s) {
      s.stop('Analysis complete');
      tui.setActiveSpinner(null);
    }

    // Step 6: Output the result
    outputResult(result, options.outputFormat, options.version);

    // Step 6.5: Create/update GitHub issue (if --issue is set)
    if (options.issue) {
      await handleIssueExport(result, options);
    }

    // Step 6.6: Post the summary back to a GitHub PR (--pr) or GitLab MR (--mr).
    // Composes WITH --issue and --output: all are independent outputs. Both route
    // through the SHARED composeForgePostback helper (BL-CLI-FORGE-COMPOSITION).
    // Returns false when an explicitly-requested post-back FAILED and soft-fail
    // is OFF — that turns into a non-zero exit below (the requested job failed).
    let prPostbackFailed = false;
    if (options.pr != null) {
      const ok = await handleForgePostback(result, options, 'github', options.pr);
      prPostbackFailed = !ok && !(options.prSoftFail ?? false);
    } else if (options.mr != null) {
      const ok = await handleForgePostback(result, options, 'gitlab', options.mr);
      prPostbackFailed = !ok && !(options.prSoftFail ?? false);
    }

    // Step 7: Exit code — pick the WORST (most-failing) of:
    //   - the review's own exit code (--exit-on-issues / status-based), and
    //   - the post-back outcome (non-zero when a required post-back failed).
    // Worst = any non-zero wins; we never mask a review-found-issues code with 0,
    // nor mask a post-back failure with a review PASS.
    const reviewExitCode = resolveExitCode(result, options.exitOnIssues ?? false);
    const exitCode = reviewExitCode !== 0 ? reviewExitCode : prPostbackFailed ? 1 : 0;
    if (!options.outputFormat) {
      tui.outro('Review complete');
    }
    process.exit(exitCode);
  } catch (error) {
    // Ensure memory is persisted even on error
    await memoryStorage?.close().catch(() => {});

    const message = error instanceof Error ? error.message : String(error);
    tui.log.error(`\n❌ Review failed: ${message}`);
    process.exit(1);
  }
}

// ─── Issue Export ───────────────────────────────────────────────

/**
 * Handle --issue flag: create a new issue or comment on an existing one.
 * Failures are non-blocking — the review result is always preserved.
 */
async function handleIssueExport(result: ReviewResult, options: ReviewOptions): Promise<void> {
  try {
    // 1. Validate GitHub token
    const token = getStoredToken();
    if (!token) {
      tui.log.warn('⚠️  No GitHub token found. Run `ghagga login` to authenticate.');
      return;
    }

    // 2. Get git remote URL
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    // 3. Parse owner/repo
    const { owner, repo } = parseGitHubRemote(remoteUrl);

    // 4. Get short SHA
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();

    // 5. Ensure label exists
    await ensureLabel({
      token,
      owner,
      repo,
      name: 'ghagga-review',
      color: '0ea5e9',
      description: 'Automated review by GHAGGA',
    });

    // 6. Format issue body
    const body = formatIssueBody(result, options.version ?? '0.0.0');

    // 7. Create issue or comment
    if (options.issue === 'new') {
      const { url } = await createIssue({
        token,
        owner,
        repo,
        title: `GHAGGA Review — ${sha}`,
        body,
        labels: ['ghagga-review'],
      });
      issueLog(options, `✅ Issue created: ${url}`);
    } else {
      const issueNumber = Number.parseInt(options.issue ?? '', 10);
      if (Number.isNaN(issueNumber) || issueNumber <= 0) {
        tui.log.warn(`⚠️  Invalid issue number "${options.issue}". Use "new" or a valid number.`);
        return;
      }
      const { url } = await createComment({
        token,
        owner,
        repo,
        issueNumber,
        body,
      });
      issueLog(options, `✅ Comment added: ${url}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    tui.log.warn(`⚠️  Issue export failed: ${msg}`);
  }
}

// ─── PR Post-Back ───────────────────────────────────────────────

/** Per-forge label + token guidance + composition builder for the post-back. */
interface ForgePostbackConfig {
  /** Human label for the change request ("PR" / "MR"). */
  label: string;
  /** The flag that triggered this ("--pr" / "--mr"). */
  flag: string;
  /** The forge display name ("GitHub" / "GitLab"). */
  forgeName: string;
  /** Resolve the forge token (env-first, stored fallback). */
  resolveToken: () => string | null;
  /** The "set X / run ghagga login" guidance when no token resolves. */
  tokenHint: string;
  /**
   * Resolve the DESTINATION host the token will be sent to (for the pre-POST
   * stderr disclosure). For GitLab this is the REAL resolved API host (derived
   * from the git remote + GITLAB_HOST / GITLAB_API_BASE overrides), so a
   * poisoned `origin` exfiltration target is visible BEFORE the token leaves.
   */
  resolveTargetHost: () => string;
  /** Build the forge adapter + canonical ref from a resolved token + number. */
  buildComposition: (token: string, changeRequestNumber: number) => Promise<ForgeComposition>;
}

/** GitHub `--pr` composition (P3): owner/repo from the remote, GitHub adapter. */
function githubPostbackConfig(): ForgePostbackConfig {
  return {
    label: 'PR',
    flag: '--pr',
    forgeName: 'GitHub',
    resolveToken: resolvePrToken,
    tokenHint: 'Set GITHUB_TOKEN (or GH_TOKEN) in your environment, or run `ghagga login`.',
    // The CLI GitHub client targets api.github.com (no GHE base override today);
    // disclose what the client actually hits.
    resolveTargetHost: () => 'api.github.com',
    async buildComposition(token, prNumber): Promise<ForgeComposition> {
      // Resolve owner/repo from the git remote (same source as issue-export).
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
      const { owner, repo } = parseGitHubRemote(remoteUrl);
      // StaticTokenProvider satisfies the SAME credential seam the server worker
      // uses (construction-site choice — no mint/refresh for a static token).
      const resolvedToken = await new StaticTokenProvider(token).getToken();
      const adapter = new GitHubForgeAdapter({
        client: createCliGitHubClientPort(),
        token: resolvedToken,
        owner,
        repo,
      });
      // Resolve the numeric repo id for RepoRef.nativeId (the opaque forge-native
      // identity — see packages/forge/src/types.ts). Normally the IMMUTABLE
      // numeric id (a rename changes owner/repo but not the id). Mirrors the
      // GitLab `--mr` flow's resolveGitLabProjectId — ONE GET /repos/{owner}/{repo}
      // → .id before the post. The adapter's wire calls still key on owner/repo
      // from its ctor, so nativeId is identity metadata only (no wire-behavior
      // change). If the resolution fails (network/404), degrade to the
      // path-shaped owner/repo — an OPAQUE-string fallback, honest per the
      // RepoRef.nativeId contract (opaque, may be path-shaped) — so an identity
      // field never crashes the post-back, and warn.
      let nativeId = `${owner}/${repo}`;
      try {
        nativeId = await resolveGitHubRepoId(owner, repo, resolvedToken);
      } catch (error) {
        console.warn(
          `[ghagga] Could not resolve numeric GitHub repo id for ${owner}/${repo} ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            'falling back to the owner/repo path for RepoRef.nativeId.',
        );
      }
      const ref: ChangeRequestRef = {
        repo: { kind: 'github', nativeId, path: `${owner}/${repo}` },
        iid: prNumber,
      };
      return { adapter, ref };
    },
  };
}

/**
 * GitLab `--mr` composition (P4): resolve the NUMERIC project id from the remote
 * path (R-GITLAB — path is mutable, id is canonical), build the GitLab adapter.
 */
function gitlabPostbackConfig(): ForgePostbackConfig {
  return {
    label: 'MR',
    flag: '--mr',
    forgeName: 'GitLab',
    resolveToken: resolveMrToken,
    tokenHint: 'Set GITLAB_TOKEN (or GL_TOKEN) in your environment, or run `ghagga login`.',
    // Disclose the REAL resolved API host (remote host + GITLAB_HOST /
    // GITLAB_API_BASE overrides) — the ACTUAL host the GITLAB_TOKEN is sent to.
    // A poisoned `origin` (or override) therefore surfaces BEFORE the post.
    resolveTargetHost: () => {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
      const { host } = parseGitLabRemote(remoteUrl);
      return gitlabApiBaseHost(resolveGitLabApiBase(host));
    },
    async buildComposition(token, mrIid): Promise<ForgeComposition> {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
      // Self-hosted GitLab: derive the API base from the REMOTE host (with a
      // GITLAB_HOST / GITLAB_API_BASE env override) so a self-managed instance
      // works, not just gitlab.com.
      const { host, projectPath } = parseGitLabRemote(remoteUrl);
      const apiBase = resolveGitLabApiBase(host);
      const resolvedToken = await new StaticTokenProvider(token).getToken();
      // R-GITLAB: nativeId MUST be the numeric project id (GET /projects/:path).
      const projectId = await resolveGitLabProjectId(projectPath, resolvedToken, apiBase);
      const adapter = new GitLabForgeAdapter({
        client: createCliGitLabClientPort(apiBase),
        token: resolvedToken,
        projectId,
      });
      const ref: ChangeRequestRef = {
        repo: { kind: 'gitlab', nativeId: projectId, path: projectPath },
        iid: mrIid,
      };
      return { adapter, ref };
    },
  };
}

/**
 * Extract the bare host from a resolved GitLab API base (`https://<host>/api/v4`
 * or a verbatim `GITLAB_API_BASE`). Used ONLY for the human-readable pre-POST
 * disclosure line — falls back to the raw base if it cannot be URL-parsed (e.g. a
 * malformed override) so the user still sees SOMETHING about the destination.
 */
function gitlabApiBaseHost(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
}

/**
 * Handle `--pr` (GitHub) / `--mr` (GitLab): post (idempotently upsert) the review
 * summary as a comment on the change request, routed through the SHARED
 * {@link composeForgePostback} pipeline (BL-CLI-FORGE-COMPOSITION). The
 * forge-specific glue (token resolver, remote parse, adapter, ref identity) is
 * supplied by the per-forge {@link ForgePostbackConfig}; the find-stale→delete→
 * repost idempotency lives inside the adapter + the forge-neutral
 * {@link postSummaryComment}.
 *
 * Token resolution is env-first (CI/Jenkins) with stored-login fallback. Missing
 * token is a hard, actionable error (unlike issue-export's soft-skip) because the
 * flag is an explicit post-back request. A 401 with a static token is fatal —
 * there is nothing to re-mint, so NO invalidate-retry is attempted.
 *
 * BLOCKING by default: the flag is an explicitly-requested side-effect, so
 * failing to perform it (thrown error OR missing token) is a JOB failure. The
 * review output is already emitted; we only signal the failure via the RETURN
 * value so the caller folds it into the worst exit code. `--pr-soft-fail` flips
 * this to the non-blocking behavior (warn + keep exit 0).
 *
 * @returns true when the summary was posted (or soft-fail-skipped), false when an
 *          explicitly-requested post-back FAILED (token missing or error thrown).
 */
async function handleForgePostback(
  result: ReviewResult,
  options: ReviewOptions,
  forge: 'github' | 'gitlab',
  changeRequestNumber: number,
): Promise<boolean> {
  const softFail = options.prSoftFail ?? false;
  const config = forge === 'github' ? githubPostbackConfig() : gitlabPostbackConfig();

  // Render the body via core's formatter (PARITY with the server PR comment).
  const body = formatReviewComment(result, { fileList: result.metadata.fileList });
  const marker = { html: REVIEW_COMMENT_MARKER };

  try {
    // SECURITY HYGIENE: disclose the DESTINATION HOST on stderr BEFORE the POST
    // fires, so the user sees where their token is going even if the post then
    // fails/hangs. For GitLab the host is the REAL resolved API host (derived
    // from the git remote + env overrides) — a poisoned `origin` that would
    // exfiltrate the token is therefore visible. stderr ONLY (never stdout /
    // SARIF): console.error regardless of --output, one line per post.
    const targetHost = config.resolveTargetHost();
    console.error(`→ Posting ${config.label} #${changeRequestNumber} review to ${targetHost}`);

    const outcome = await composeForgePostback({
      changeRequestNumber,
      resolveToken: config.resolveToken,
      buildComposition: config.buildComposition,
      body,
      marker,
    });

    if (outcome.kind === 'missing-token') {
      const errMsg = `❌ ${config.flag} requires a ${config.forgeName} token. ${config.tokenHint}`;
      if (softFail) {
        if (options.outputFormat) console.error(errMsg);
        else tui.log.warn(errMsg);
        return true;
      }
      if (options.outputFormat) console.error(errMsg);
      else tui.log.error(errMsg);
      return false;
    }

    const { createdNativeId, deletedNativeIds } = outcome.result;
    const stale = deletedNativeIds.length > 0 ? ` (replaced ${deletedNativeIds.length} stale)` : '';
    issueLog(
      options,
      `✅ ${config.label} #${changeRequestNumber} summary posted (comment ${createdNativeId})${stale}`,
    );
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (softFail) {
      issueLog(options, `⚠️  ${config.label} post-back failed (soft-fail, ignoring): ${msg}`);
      return true;
    }
    // BLOCKING: surface the failure so the caller exits non-zero. The review
    // output itself is already printed and is unaffected.
    const failMsg = `❌ ${config.label} post-back failed: ${msg}`;
    if (options.outputFormat) console.error(failMsg);
    else tui.log.error(failMsg);
    return false;
  }
}

/**
 * Print issue URL to stderr when --output is set (stdout reserved for format),
 * otherwise use tui.log.success().
 */
function issueLog(options: ReviewOptions, message: string): void {
  if (options.outputFormat) {
    console.error(message);
  } else {
    tui.log.success(message);
  }
}

// ─── Git Diff ───────────────────────────────────────────────────

/**
 * Get the diff from git. Uses staged changes if available,
 * otherwise falls back to `git diff HEAD`.
 */
function getGitDiff(repoPath: string): string {
  const execOpts = { cwd: repoPath, encoding: 'utf-8' as const, maxBuffer: 10 * 1024 * 1024 };

  // Check for staged changes first
  try {
    const staged = execSync('git diff --staged', execOpts).toString();
    if (staged.trim().length > 0) {
      return staged;
    }
  } catch {
    // git diff --staged failed, try HEAD
  }

  // Fall back to diff against HEAD
  try {
    const headDiff = execSync('git diff HEAD', execOpts).toString();
    if (headDiff.trim().length > 0) {
      return headDiff;
    }
  } catch {
    // HEAD might not exist (fresh repo), try unstaged diff
  }

  // Last resort: unstaged diff
  try {
    return execSync('git diff', execOpts).toString();
  } catch {
    throw new Error(
      `Could not get git diff from "${repoPath}". ` +
        'Make sure the path is a git repository with changes.',
    );
  }
}

// ─── Config File ────────────────────────────────────────────────

/**
 * Validate the shape of a `.ghagga.json` `providerChain` array. Throws a
 * descriptive `Error` on the first invalid entry — provider misrouting is
 * high-stakes (silently reviewing with the wrong engine), so this fails
 * loudly rather than the soft-warn-and-continue behavior used for a
 * generally malformed config file.
 */
function validateProviderChain(chain: unknown): asserts chain is GhaggaConfigProviderChainEntry[] {
  if (!Array.isArray(chain)) {
    throw new Error('providerChain must be an array');
  }

  chain.forEach((rawEntry, index) => {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`providerChain[${index}] must be an object`);
    }

    const entry = rawEntry as Record<string, unknown>;

    if (entry.provider !== 'gateway') {
      throw new Error(
        `providerChain[${index}].provider must be "gateway" (got ${JSON.stringify(entry.provider)})`,
      );
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      throw new Error(`providerChain[${index}].model must be a non-empty string`);
    }
    if (entry.targetProvider !== undefined && typeof entry.targetProvider !== 'string') {
      throw new Error(`providerChain[${index}].targetProvider must be a string`);
    }
    if (entry.gatewayUrl !== undefined && typeof entry.gatewayUrl !== 'string') {
      throw new Error(`providerChain[${index}].gatewayUrl must be a string`);
    }
    if (entry.cliModel !== undefined && typeof entry.cliModel !== 'string') {
      throw new Error(`providerChain[${index}].cliModel must be a string`);
    }
  });
}

/**
 * Load and parse an optional .ghagga.json config file.
 */
function loadConfigFile(repoPath: string, configPath?: string): GhaggaConfig {
  const filePath = configPath ? resolve(configPath) : join(repoPath, '.ghagga.json');

  if (!existsSync(filePath)) {
    return {};
  }

  let parsed: GhaggaConfig;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(raw) as GhaggaConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.log.warn(`⚠️  Could not parse config file: ${message}`);
    return {};
  }

  if (parsed.providerChain !== undefined) {
    try {
      validateProviderChain(parsed.providerChain);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tui.log.error(`❌ Invalid .ghagga.json providerChain: ${message}`);
      process.exit(1);
      return {};
    }
  }

  return parsed;
}

/**
 * Map a validated `.ghagga.json` providerChain into `ghagga-core`'s
 * `ProviderChainEntry[]` for `ReviewInput.providerChain` — the piece that
 * closes the CLI's gap in per-voice cross-engine routing (consensus/fan-out
 * modes round-robin each voice across these gateway entries, see
 * `resolveGenerateTextFns` in `packages/core/src/pipeline/providers.ts`).
 *
 * `apiKey` is NEVER read from the config file (never stored in plaintext) —
 * it is filled at runtime from the resolved gateway token (`options.apiKey`,
 * itself CLI flag > env var > stored login token, see `apps/cli/src/index.ts`).
 */
function buildProviderChain(
  fileConfig: GhaggaConfig,
  apiKey: string | undefined,
): ProviderChainEntry[] | undefined {
  if (!fileConfig.providerChain || fileConfig.providerChain.length === 0) {
    return undefined;
  }

  return fileConfig.providerChain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    apiKey: apiKey ?? '',
    ...(entry.targetProvider !== undefined ? { targetProvider: entry.targetProvider } : {}),
    ...(entry.gatewayUrl !== undefined ? { gatewayUrl: entry.gatewayUrl } : {}),
    ...(entry.cliModel !== undefined ? { cliModel: entry.cliModel } : {}),
  }));
}

// ─── Blast-Radius: Pure Seams (design v2 D9) ────────────────────
//
// These are NAMED, EXPORTED functions — extracted so the auto-ON,
// staleness, and partial-coverage logic can be unit-tested without mocking
// the side-effecting `reviewCommand` try-block. `reviewCommand` only wires
// I/O (git HEAD read, FilesystemGraphLoader, tui.warn) around them.
// NOTE: `resolveBlastRadiusEnabled` is NOT pure — it does a filesystem
// existence check (`existsSync`) against `repoPath`. `checkGraphStaleness`
// and `computeUncoveredLanguages` (below) are pure.

/** One staleness/coverage signal for `checkGraphStaleness` — WARN, never block. */
export interface StalenessWarning {
  kind: 'head-mismatch' | 'stale-age' | 'no-metadata' | 'version-mismatch';
  message: string;
}

/**
 * Resolve whether blast-radius should be enabled for this review run.
 *
 * Precedence (highest to lowest):
 *   1. `--no-blast-radius` (options.blastRadius === false) → OFF
 *   2. `.ghagga.json` `enableBlastRadius` (explicit true/false) → that value
 *   3. Auto-ON when `<repoPath>/.ghagga/graph.json` exists
 *   4. OFF (no graph, no override)
 *
 * CRITICAL-2 (JD B-001): the existence check is resolved against `repoPath`
 * — the review target — NOT `process.cwd()`, so `ghagga review <other-dir>`
 * from an unrelated cwd still auto-detects correctly.
 */
export function resolveBlastRadiusEnabled(
  repoPath: string,
  options: Pick<ReviewOptions, 'blastRadius'>,
  fileConfig: Pick<GhaggaConfig, 'enableBlastRadius'>,
): boolean {
  if (options.blastRadius === false) return false;
  if (fileConfig.enableBlastRadius === false) return false;
  if (fileConfig.enableBlastRadius === true) return true;
  return existsSync(join(repoPath, '.ghagga', 'graph.json'));
}

/**
 * Detect staleness/coverage-verification signals for the loaded graph.
 * ALWAYS warn-and-continue (design v2 D2) — never blocks the review.
 *
 * - HEAD mismatch: `metadata.lastIndexedCommit` non-empty and differs from
 *   `currentHead`. An EMPTY `currentHead` (non-git/detached checkout) skips
 *   this specific check — there's nothing meaningful to compare against.
 * - Age: delegates to `isGraphStale` (>`GRAPH_STALE_DAYS` days).
 * - Metadata absent (B-005): `metadata === null` — graph.json loaded but no
 *   sibling metadata.json (e.g. pre-feature `ghagga index` run). Returns
 *   EARLY with only this warning — there's nothing else to check.
 * - Version mismatch (B-003): `metadata.graphVersion` set and differs from
 *   the current `GRAPH_VERSION` (equivalent to comparing against the loaded
 *   graph's `version`, which `validateGraph` already pins to `GRAPH_VERSION`).
 */
export function checkGraphStaleness(
  metadata: GraphMetadata | null,
  currentHead: string,
): StalenessWarning[] {
  if (!metadata) {
    return [
      {
        kind: 'no-metadata',
        message:
          'Graph loaded but no metadata found — staleness cannot be verified; re-run `ghagga index`.',
      },
    ];
  }

  const warnings: StalenessWarning[] = [];

  if (currentHead && metadata.lastIndexedCommit && metadata.lastIndexedCommit !== currentHead) {
    warnings.push({
      kind: 'head-mismatch',
      message: `Dependency graph indexed at ${metadata.lastIndexedCommit}, HEAD is ${currentHead} — run \`ghagga index\` to refresh.`,
    });
  }

  if (isGraphStale(metadata)) {
    warnings.push({
      kind: 'stale-age',
      message: `Dependency graph is stale (last indexed: ${metadata.lastIndexedAt}) — run \`ghagga index\` to refresh.`,
    });
  }

  if (metadata.graphVersion !== undefined && metadata.graphVersion !== GRAPH_VERSION) {
    warnings.push({
      kind: 'version-mismatch',
      message: `Graph metadata schema version (${metadata.graphVersion}) does not match the current graph version (${GRAPH_VERSION}) — run \`ghagga index\` to refresh.`,
    });
  }

  return warnings;
}

/**
 * Compute the set of languages present among `changedFiles` that have ZERO
 * coverage in the loaded graph — i.e. files whose blast-radius dependent
 * count is unreliable (shows zero, not "no dependents").
 *
 * Coverage is derived from the graph's ACTUAL node contents (design v2 D8,
 * JD CRITICAL-1), not from indexer-dispatch bookkeeping:
 *   - The regex-fallback path sets `indexedLanguages: []` even though every
 *     node has a real `language` — keying off dispatch state would flag
 *     every changed file as uncovered.
 *   - `detectPresentLanguages` is root-only — a language that only exists in
 *     a subpackage (e.g. `packages/api/requirements.txt`) is never detected
 *     or skipped, so dispatch state gives no signal at all.
 *
 * Files whose language cannot be detected (`detectLanguage` returns
 * `undefined` — unknown extension) are silently excluded; there is no
 * language identity to report as uncovered.
 */
export function computeUncoveredLanguages(
  graph: DependencyGraph,
  changedFiles: string[],
): string[] {
  const covered = new Set(Object.values(graph.nodes).map((node) => node.language));
  const uncovered = new Set<string>();

  for (const filePath of changedFiles) {
    const language = detectLanguage(filePath);
    if (language && !covered.has(language)) {
      uncovered.add(language);
    }
  }

  return [...uncovered];
}

// ─── Settings Merge ─────────────────────────────────────────────

/**
 * Merge CLI options, config file, and defaults.
 * Priority: CLI options > config file > defaults.
 *
 * For tool lists: CLI --disable-tool/--enable-tool flags are merged with
 * config file disabledTools/enabledTools (CLI takes precedence via union).
 * Deprecated --no-semgrep/--no-trivy/--no-cpd flags are translated into
 * disabledTools entries.
 */
function mergeSettings(options: ReviewOptions, fileConfig: GhaggaConfig): ReviewSettings {
  // Collect disabledTools from: deprecated flags + CLI --disable-tool + config file
  const disabledTools = new Set<string>(DEFAULT_SETTINGS.disabledTools ?? []);

  // Translate deprecated boolean flags into disabledTools
  if (options.semgrep === false) disabledTools.add('semgrep');
  if (options.trivy === false) disabledTools.add('trivy');
  if (options.cpd === false) disabledTools.add('cpd');

  // Add config file disabledTools
  if (fileConfig.disabledTools) {
    for (const tool of fileConfig.disabledTools) disabledTools.add(tool);
  }

  // Translate deprecated config file boolean flags
  if (fileConfig.enableSemgrep === false) disabledTools.add('semgrep');
  if (fileConfig.enableTrivy === false) disabledTools.add('trivy');
  if (fileConfig.enableCpd === false) disabledTools.add('cpd');

  // CLI --disable-tool takes highest priority (additive)
  for (const tool of options.disableTools ?? []) disabledTools.add(tool);

  // Collect enabledTools from: CLI --enable-tool + config file
  const enabledTools = new Set<string>(DEFAULT_SETTINGS.enabledTools ?? []);

  // Config file enabledTools
  if (fileConfig.enabledTools) {
    for (const tool of fileConfig.enabledTools) enabledTools.add(tool);
  }

  // CLI --enable-tool (additive)
  for (const tool of options.enableTools ?? []) enabledTools.add(tool);

  // --disable-tool takes precedence over --enable-tool for same tool
  for (const tool of disabledTools) {
    enabledTools.delete(tool);
  }

  // Resolve lens configuration: CLI --lenses flag > .ghagga.json lenses > undefined (defaults)
  const lenses: string[] | undefined = options.lenses
    ? options.lenses
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : fileConfig.lenses;

  // Resolve lens directory: CLI --lens-dir > default .ghagga/lenses/
  // The lensDir is resolved to an absolute path relative to the repo root later,
  // but we set the default convention here.
  const lensDir = options.lensDir ?? join(resolve('.'), '.ghagga', 'lenses');

  return {
    enableSemgrep: options.semgrep ?? fileConfig.enableSemgrep ?? DEFAULT_SETTINGS.enableSemgrep,
    enableTrivy: options.trivy ?? fileConfig.enableTrivy ?? DEFAULT_SETTINGS.enableTrivy,
    enableCpd: options.cpd ?? fileConfig.enableCpd ?? DEFAULT_SETTINGS.enableCpd,
    enableMemory: options.memory ?? true, // Memory enabled by default, --no-memory disables
    customRules: fileConfig.customRules ?? DEFAULT_SETTINGS.customRules,
    ignorePatterns: fileConfig.ignorePatterns ?? DEFAULT_SETTINGS.ignorePatterns,
    reviewLevel:
      (fileConfig.reviewLevel as ReviewSettings['reviewLevel']) ?? DEFAULT_SETTINGS.reviewLevel,
    disabledTools: Array.from(disabledTools),
    enabledTools: Array.from(enabledTools),
    lenses,
    lensDir,
  };
}

// ─── Tool List ──────────────────────────────────────────────────

/**
 * Print all registered tools grouped by tier.
 * When format is 'json', outputs a JSON array.
 * Otherwise outputs a formatted table.
 */
function printToolList(format: 'markdown' | 'json'): void {
  initializeDefaultTools();
  const allTools = toolRegistry.getAll();

  if (format === 'json') {
    const json = allTools.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      category: t.category,
      tier: t.tier,
      version: t.version,
    }));
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const alwaysOn = allTools.filter((t) => t.tier === 'always-on');
  const autoDetect = allTools.filter((t) => t.tier === 'auto-detect');

  const lines: string[] = [];
  lines.push('Available static analysis tools:');
  lines.push('');
  lines.push('ALWAYS-ON:');
  for (const t of alwaysOn) {
    lines.push(`  ${t.name.padEnd(18)}${t.displayName}`);
  }
  lines.push('');
  lines.push('AUTO-DETECT:');
  for (const t of autoDetect) {
    lines.push(`  ${t.name.padEnd(18)}${t.displayName}`);
  }

  tui.log.message(lines.join('\n'));
}

// ─── Deprecation Warnings ───────────────────────────────────────

/** Deprecated flag name → new tool name mapping */
const DEPRECATED_FLAGS: Record<string, string> = {
  semgrep: 'semgrep',
  trivy: 'trivy',
  cpd: 'cpd',
};

/**
 * Emit deprecation warnings for old --no-semgrep/--no-trivy/--no-cpd flags.
 * Returns the list of tools disabled via deprecated flags (for merging).
 */
function emitDeprecationWarnings(options: ReviewOptions): string[] {
  const disabled: string[] = [];

  for (const [flagName, toolName] of Object.entries(DEPRECATED_FLAGS)) {
    // Commander negated options: --no-semgrep sets options.semgrep = false
    const value = options[flagName as keyof ReviewOptions];
    if (value === false) {
      tui.log.warn(`⚠ --no-${flagName} is deprecated, use --disable-tool ${toolName} instead`);
      disabled.push(toolName);
    }
  }

  return disabled;
}

// ─── Tool Name Validation ───────────────────────────────────────

/**
 * Validate that tool names in --disable-tool / --enable-tool are known.
 * Prints a warning for unknown tools but does NOT block execution.
 */
function validateToolNames(toolNames: string[] | undefined, _flagName: string): void {
  if (!toolNames?.length) return;

  const knownTools = toolRegistry.getAll().map((t) => t.name);

  for (const name of toolNames) {
    if (!knownTools.includes(name as ToolDefinition['name'])) {
      tui.log.warn(`Warning: Unknown tool "${name}". Known tools: ${knownTools.join(', ')}`);
    }
  }
}

// ─── Verbose Progress ───────────────────────────────────────────

/**
 * Create a progress callback that prints real-time verbose output.
 * Each step prints a single line with an icon, step name, and message.
 * Specialist/vote steps (dynamic names) get a generic icon.
 */
function createProgressHandler(): ProgressCallback {
  return (event: ProgressEvent) => {
    const icon = resolveStepIcon(event.step);

    const prefix = `  ${icon} [${event.step}]`;
    tui.log.step(`${prefix} ${event.message}`);

    if (event.detail) {
      // Indent detail lines for readability
      const indented = event.detail
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n');
      tui.log.message(indented);
    }
  };
}

// ─── Output Formatting ──────────────────────────────────────────

/**
 * Route result output based on the chosen format.
 * When outputFormat is undefined, uses styled TUI output (default).
 */
function outputResult(
  result: ReviewResult,
  outputFormat: 'json' | 'sarif' | 'markdown' | undefined,
  version?: string,
): void {
  switch (outputFormat) {
    case 'json':
      console.log(JSON.stringify(result, null, 2));
      break;
    case 'sarif':
      console.log(JSON.stringify(buildSarif(result, version ?? '0.0.0'), null, 2));
      break;
    case 'markdown':
      console.log(formatMarkdownResult(result));
      break;
    default: {
      // Styled TUI output with severity colors and box summary
      const boxLines = formatBoxSummary(result);
      tui.log.message(tui.box('Review Summary', boxLines));
      tui.log.message('');
      tui.log.message(formatMarkdownResult(result));
      break;
    }
  }
}

// ─── Exit Code ──────────────────────────────────────────────────

/**
 * Resolve the exit code for the review process.
 *
 * When `exitOnIssues` is true (hook mode), checks findings for
 * critical/high severity — returns 1 if any found, 0 otherwise.
 * When false, delegates to the default status-based exit code.
 */
function resolveExitCode(result: ReviewResult, exitOnIssues: boolean): number {
  if (exitOnIssues) {
    const hasBlockingIssues = result.findings.some(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    return hasBlockingIssues ? 1 : 0;
  }
  // Default behavior: use status-based exit code
  return getExitCode(result.status);
}

/**
 * Map review status to process exit code.
 * PASSED and SKIPPED = 0, everything else = 1.
 */
function getExitCode(status: ReviewStatus): number {
  switch (status) {
    case 'PASSED':
    case 'SKIPPED':
      return 0;
    case 'FAILED':
    case 'NEEDS_HUMAN_REVIEW':
    case 'PARTIAL':
      return 1;
    default: {
      const _exhaustive: never = status;
      console.warn(`Unknown status: ${_exhaustive as string}`);
      return 1;
    }
  }
}
