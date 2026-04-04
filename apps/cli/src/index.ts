#!/usr/bin/env node

/**
 * GHAGGA CLI — AI-powered code review from the command line.
 *
 * Quick start:
 *   ghagga login                   Authenticate with GitHub (free!)
 *   ghagga review [path]           Review staged or uncommitted changes
 *   ghagga status                  Show current auth and config
 *   ghagga logout                  Clear stored credentials
 *
 * After "ghagga login", reviews use GitHub Models (gpt-4o-mini) for free.
 * You can override with --provider, --model, --api-key for other providers.
 *
 * Environment variables (override stored config):
 *   GHAGGA_API_KEY          API key for the LLM provider
 *   GHAGGA_PROVIDER         LLM provider: gateway, cli-bridge, ollama
 *   GHAGGA_MODEL            Model identifier
 *   GITHUB_TOKEN            GitHub token (fallback auth for gateway / cli-bridge)
 *   GHAGGA_MEMORY_BACKEND   Memory backend: sqlite (default) or engram
 */

import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { LLMProvider, ReviewMode } from 'ghagga-core';
import { DEFAULT_MODELS } from 'ghagga-core';
import { auditCommand } from './commands/audit.js';
import { dismissCommand } from './commands/dismiss.js';
import { healthCommand } from './commands/health.js';
import { hooksCommand } from './commands/hooks/index.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { memoryCommand } from './commands/memory/index.js';
import { reviewCommand } from './commands/review.js';
import { statusCommand } from './commands/status.js';
import { getStoredToken, loadConfig } from './lib/config.js';
import * as tui from './ui/tui.js';

// Read version from package.json at runtime (no hardcoded strings)
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

/** Collect repeatable option values into an array (Commander pattern) */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command();

program
  .name('ghagga')
  .description('AI-powered code review CLI')
  .version(pkg.version)
  .option('--plain', 'Disable styled terminal output');

// Initialize TUI mode before any command runs (Design AD3)
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals() as { plain?: boolean; output?: string };
  const isPlain = !!opts.plain || !process.stdout.isTTY || !!process.env.CI || !!opts.output;
  tui.init({ plain: isPlain });
});

// ─── Login ──────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with GitHub (uses free AI models)')
  .action(async () => {
    await loginCommand();
  });

// ─── Logout ─────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear stored GitHub credentials')
  .action(() => {
    logoutCommand();
  });

// ─── Status ─────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current authentication and configuration')
  .action(async () => {
    await statusCommand();
  });

// ─── Review ─────────────────────────────────────────────────────

program
  .command('review')
  .description('Review local code changes using AI')
  .argument('[path]', 'Path to the repository', '.')
  .option('-m, --mode <mode>', 'Review mode', 'simple')
  .option(
    '-p, --provider <provider>',
    'LLM provider (auto-detected from login)',
    process.env.GHAGGA_PROVIDER,
  )
  .option('--model <model>', 'LLM model identifier', process.env.GHAGGA_MODEL)
  .option('--api-key <key>', 'LLM provider API key', process.env.GHAGGA_API_KEY)
  .option('-o, --output <format>', 'Output format: json | sarif | markdown')
  .option('-f, --format <format>', '(deprecated) Use --output instead')
  .option('--no-semgrep', '(deprecated) Use --disable-tool semgrep')
  .option('--no-trivy', '(deprecated) Use --disable-tool trivy')
  .option('--no-cpd', '(deprecated) Use --disable-tool cpd')
  .option('--disable-tool <name>', 'Disable a specific tool (repeatable)', collect, [])
  .option('--enable-tool <name>', 'Force-enable a specific tool (repeatable)', collect, [])
  .option('--list-tools', 'List all available analysis tools and exit')
  .option('--no-memory', 'Disable review memory')
  .option('-c, --config <path>', 'Path to .ghagga.json config file')
  .option('-v, --verbose', 'Show detailed progress during review')
  .option('--staged', 'Review only staged changes (for pre-commit hooks)')
  .option('--commit-msg <file>', 'Validate commit message from file path')
  .option('--exit-on-issues', 'Exit with code 1 if critical/high issues found')
  .option('--quick', 'Static analysis only — skip LLM review')
  .option('--enhance', 'Enable AI-powered post-analysis enhancement')
  .option(
    '--issue <target>',
    'Create/update a GitHub issue with review results (use "new" or issue number)',
  )
  .option('--lenses <names>', 'Comma-separated lens names for fan-out mode (e.g., "security,wcag")')
  .option(
    '--lens-dir <path>',
    'Path to custom lens definitions directory (default: .ghagga/lenses/)',
  )
  .option(
    '--memory-backend <type>',
    'Memory backend: sqlite (default) or engram (env: GHAGGA_MEMORY_BACKEND)',
    'sqlite',
  )
  .action(async (path: string, options: ReviewCommandOptions) => {
    // ── Auto-resolve auth from stored config ──────────────────
    const config = loadConfig();
    const storedToken = getStoredToken();

    // Priority: CLI flag > env var > stored config
    if (!options.provider) {
      options.provider = config.defaultProvider ?? 'gateway';
    }

    if (!options.model) {
      options.model = config.defaultModel ?? undefined;
    }

    // Auto-resolve API key: CLI flag > env var > stored token (gateway/cli-bridge)
    if (!options.apiKey) {
      if (options.provider === 'gateway' || options.provider === 'cli-bridge') {
        options.apiKey = storedToken ?? undefined;
      }
    }

    // ── Validate mode ─────────────────────────────────────────
    const validModes: ReviewMode[] = ['simple', 'workflow', 'consensus', 'fan-out'];
    if (!validModes.includes(options.mode as ReviewMode)) {
      tui.log.error(`❌ Invalid mode "${options.mode}". Choose from: ${validModes.join(', ')}`);
      process.exit(1);
    }

    // ── Validate / migrate provider ───────────────────────────
    const currentProviders: LLMProvider[] = ['gateway', 'cli-bridge', 'ollama'];
    const legacyCLIProviders = new Set([
      'anthropic',
      'openai',
      'google',
      'github',
      'groq',
      'openrouter',
      'azure',
      'deepseek',
      'qwen',
      'cerebras',
    ]);

    if (legacyCLIProviders.has(options.provider as string)) {
      tui.log.error(
        `\n❌ Provider '${options.provider}' is no longer supported directly.\n` +
          `  → Set --provider gateway and configure credentials in mcp-llm-bridge.\n` +
          `  → See: https://github.com/JNZader/mcp-llm-bridge\n\n` +
          `  Or use --provider cli-bridge for local CLI tools (Claude Code, OpenCode, Copilot).\n`,
      );
      process.exit(1);
    }

    if (!currentProviders.includes(options.provider as LLMProvider)) {
      tui.log.error(
        `❌ Invalid provider "${options.provider}". Choose from: ${currentProviders.join(', ')}`,
      );
      process.exit(1);
    }

    // ── Resolve output format (--output takes priority over deprecated --format) ──
    let outputFormat: 'json' | 'sarif' | 'markdown' | undefined;
    if (options.output) {
      const validOutputs = ['json', 'sarif', 'markdown'];
      if (!validOutputs.includes(options.output)) {
        tui.log.error(
          `❌ Invalid output format "${options.output}". Choose from: ${validOutputs.join(', ')}`,
        );
        process.exit(1);
      }
      outputFormat = options.output as 'json' | 'sarif' | 'markdown';
    } else if (options.format) {
      // Deprecated --format flag
      console.error('Warning: --format is deprecated. Use --output instead.');
      const validFormats = ['markdown', 'json'];
      if (!validFormats.includes(options.format)) {
        tui.log.error(
          `❌ Invalid format "${options.format}". Choose from: ${validFormats.join(', ')}`,
        );
        process.exit(1);
      }
      outputFormat = options.format as 'json' | 'markdown';
    }

    // ── Validate API key ──────────────────────────────────────
    // ollama, cli-bridge, and gateway (when self-hosted) don't require a key.
    const noKeyRequired =
      options.provider === 'ollama' ||
      options.provider === 'cli-bridge' ||
      options.provider === 'gateway';

    if (!options.apiKey && !noKeyRequired && !options.quick) {
      tui.log.error('❌ No API key available.\n');
      tui.log.error('   Quick fix: run "ghagga login" to authenticate.');
      tui.log.error('   Or pass --api-key <key> or set GHAGGA_API_KEY.');
      tui.log.error('   Or use --provider ollama / --provider cli-bridge for key-free review.\n');
      process.exit(1);
    }

    // Ollama doesn't need an API key — use a placeholder so the pipeline doesn't error
    if (options.provider === 'ollama' && !options.apiKey) {
      options.apiKey = 'ollama';
    }

    // ── Resolve model default ─────────────────────────────────
    const provider = options.provider as LLMProvider;
    const model = options.model ?? DEFAULT_MODELS[provider];

    await reviewCommand(path, {
      mode: options.mode as ReviewMode,
      provider,
      model,
      apiKey: options.apiKey ?? '',
      outputFormat,
      version: pkg.version,
      semgrep: options.semgrep,
      trivy: options.trivy,
      cpd: options.cpd,
      memory: options.memory,
      memoryBackend: options.memoryBackend as 'sqlite' | 'engram' | undefined,
      config: options.config,
      verbose: options.verbose ?? false,
      staged: options.staged ?? false,
      commitMsg: options.commitMsg,
      exitOnIssues: options.exitOnIssues ?? false,
      quick: options.quick ?? false,
      enhance: options.enhance ?? false,
      issue: options.issue,
      disableTools: options.disableTool ?? [],
      enableTools: options.enableTool ?? [],
      listTools: options.listTools ?? false,
      lenses: options.lenses,
      lensDir: options.lensDir,
    });
  });

// ─── Health ─────────────────────────────────────────────────────

program
  .command('health')
  .description('Quick project health check with scoring and trends')
  .argument('[path]', 'Path to the repository', '.')
  .option('--top <n>', 'Number of top issues to show', '5')
  .action(async (path: string, options: { top: string }) => {
    const globalOpts = program.optsWithGlobals() as { output?: string; plain?: boolean };
    await healthCommand(path, {
      output: globalOpts.output,
      plain: globalOpts.plain,
      top: Number.parseInt(options.top, 10) || 5,
    });
  });

// ─── Audit ──────────────────────────────────────────────────────

program
  .command('audit')
  .description('Full-project security and code-quality audit')
  .argument('[path]', 'Path to the repository', '.')
  .option('--quick', 'Static analysis only — skip LLM audit')
  .option(
    '-p, --provider <provider>',
    'LLM provider (auto-detected from login)',
    process.env.GHAGGA_PROVIDER,
  )
  .option('--model <model>', 'LLM model identifier', process.env.GHAGGA_MODEL)
  .option('--api-key <key>', 'LLM provider API key', process.env.GHAGGA_API_KEY)
  .option('-o, --output <format>', 'Output format: text | json')
  .option('--save', 'Persist audit result to history file')
  .action(async (path: string, options: AuditCommandOptions) => {
    await auditCommand(path, {
      quick: options.quick ?? false,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      output: options.output,
      save: options.save ?? false,
    });
  });

// ─── Memory ─────────────────────────────────────────────────────

program.addCommand(memoryCommand);

// ─── Dismiss ─────────────────────────────────────────────────────

program.addCommand(dismissCommand);

// ─── Hooks ──────────────────────────────────────────────────────

program.addCommand(hooksCommand);

program.parse();

// ─── Types ──────────────────────────────────────────────────────

interface ReviewCommandOptions {
  mode: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  format?: string;
  output?: string;
  semgrep: boolean;
  trivy: boolean;
  cpd: boolean;
  memory: boolean;
  memoryBackend?: string;
  config?: string;
  verbose: boolean;
  // Hook-oriented flags (Phase 2: cli-git-hooks)
  staged?: boolean;
  commitMsg?: string;
  exitOnIssues?: boolean;
  quick?: boolean;
  enhance?: boolean;
  // Issue export (Phase 6)
  issue?: string;
  // Extensible tool system flags (Phase 7)
  disableTool: string[];
  enableTool: string[];
  listTools?: boolean;
  // Pluggable review lenses (fan-out mode)
  lenses?: string;
  lensDir?: string;
}

interface AuditCommandOptions {
  quick?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  output?: string;
  save?: boolean;
}
