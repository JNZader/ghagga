/**
 * Review command handler.
 *
 * Gets the local git diff, merges configuration from CLI options,
 * environment, and optional .ghagga.json file, then runs the
 * core review pipeline and formats the output.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  LLMProvider,
  MemoryStorage,
  ProgressCallback,
  ProgressEvent,
  ReviewMode,
  ReviewResult,
  ReviewSettings,
  ReviewStatus,
  ToolDefinition,
} from 'ghagga-core';
import {
  buildSarif,
  DEFAULT_SETTINGS,
  EngramMemoryStorage,
  initializeDefaultTools,
  reviewPipeline,
  SqliteMemoryStorage,
  toolRegistry,
} from 'ghagga-core';
import { getConfigDir, getStoredToken } from '../lib/config.js';
import { getStagedDiff, resolveProjectId } from '../lib/git.js';
import {
  createComment,
  createIssue,
  ensureLabel,
  formatIssueBody,
  parseGitHubRemote,
} from '../lib/github-api.js';
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
            memoryStorage = await SqliteMemoryStorage.create(dbPath);
          }
        } else {
          memoryStorage = await SqliteMemoryStorage.create(dbPath);
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

    // Step 7: Exit code — --exit-on-issues overrides default behavior
    const exitCode = resolveExitCode(result, options.exitOnIssues ?? false);
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
 * Load and parse an optional .ghagga.json config file.
 */
function loadConfigFile(repoPath: string, configPath?: string): GhaggaConfig {
  const filePath = configPath ? resolve(configPath) : join(repoPath, '.ghagga.json');

  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as GhaggaConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.log.warn(`⚠️  Could not parse config file: ${message}`);
    return {};
  }
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
    ? options.lenses.split(',').map((s) => s.trim()).filter(Boolean)
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
      return 1;
    default: {
      const _exhaustive: never = status;
      console.warn(`Unknown status: ${_exhaustive as string}`);
      return 1;
    }
  }
}
