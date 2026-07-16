/**
 * `ghagga triage` command group — thin CLI wiring around
 * `ghagga-triage-engine`'s engine facade (config-driven code-aware issue
 * triage with a local human-approval queue). All logic lives in the
 * package; this file only parses args and calls the right engine function.
 *
 * SAFETY: triage NEVER posts by itself. A comment reaches the forge ONLY
 * via `approve`, which a human runs explicitly (CLI or the `serve` web UI),
 * and only the (edited) client reply is posted — see
 * `ghagga-triage-engine`'s queue/approval.ts for the enforced guarantee.
 */

import { join } from 'node:path';
import { Command } from 'commander';
import { createCLIBridgeGenerateFn, SqliteMemoryStorage } from 'ghagga-core';
import {
  approveIssue,
  type EngineOptions,
  editDraft,
  listQueue,
  loadConfig,
  rejectIssue,
  resolveConfigPath,
  showDraft,
  startTriageServer,
  triageIssue,
  triageNew,
} from 'ghagga-triage-engine';
import { getConfigDir } from '../lib/config.js';
import { resolveCliEmbeddingProvider } from '../lib/embedding.js';
import * as tui from '../ui/tui.js';

/**
 * Fallback model for the (opt-in) live-app reproduction agentic loop, used
 * when the config's `models.reproduce` field is absent. Matches the model
 * used during the reproduce() PoC.
 */
const DEFAULT_REPRODUCE_MODEL = 'opencode-go/kimi-k2.7-code';

/**
 * Resolves the TriageConfig + generateFns from `--config` (or its defaults).
 *
 * `reproduce: true` additionally wires a `reproduceGenerateFn`, which makes
 * `triageIssue` attempt a live-app reproduction (browser + LLM agentic loop)
 * before triaging. Opt-in only — see the `--reproduce` flag on `triage <iid>`.
 */
function resolveEngineOptions(
  configPath?: string,
  opts: { reproduce?: boolean } = {},
): EngineOptions {
  const path = resolveConfigPath({ explicitPath: configPath });
  const config = loadConfig(path);
  return {
    config,
    rerankGenerateFn: createCLIBridgeGenerateFn({
      preferredCLI: 'opencode',
      cliModel: config.models.rerank,
    }),
    analysisGenerateFn: createCLIBridgeGenerateFn({
      preferredCLI: 'opencode',
      cliModel: config.models.analysis,
    }),
    ...(opts.reproduce
      ? {
          reproduceGenerateFn: createCLIBridgeGenerateFn({
            preferredCLI: 'opencode',
            cliModel: config.models?.reproduce ?? DEFAULT_REPRODUCE_MODEL,
          }),
        }
      : {}),
  };
}

/**
 * Open the SQLite memory store that backs issue DEDUP for `ghagga triage`.
 *
 * Reuses the SAME per-user `~/.config/ghagga/memory.db` the `memory`/`review`
 * commands use (issue observations are project + type scoped, so they coexist
 * with review memory without collision). The embedding provider is threaded
 * from the merged CLI config exactly like every other construction site; when
 * unconfigured, dedup falls back to keyword-only search unchanged.
 */
async function openTriageMemory(): Promise<SqliteMemoryStorage> {
  const dbPath = join(getConfigDir(), 'memory.db');
  const { config, provider } = resolveCliEmbeddingProvider();
  return SqliteMemoryStorage.create(
    dbPath,
    provider
      ? {
          embeddingProvider: provider,
          embeddingModel: config.model,
          embeddingCandidateK: config.candidateK,
        }
      : {},
  );
}

/**
 * Wire a memory store into `options` for the duration of `fn`, then flush it to
 * disk via `close()` (SQLite is an in-memory WASM DB — without close(), saved
 * observations never persist). Skipped entirely when dedup is disabled in
 * config, so an opt-out never pays the WASM init cost.
 */
async function runWithMemory<T>(options: EngineOptions, fn: () => Promise<T>): Promise<T> {
  const dedupEnabled = options.config.dedup?.enabled ?? true;
  if (!dedupEnabled) {
    return fn();
  }
  // Dedup is an ENHANCEMENT — a corrupt/unopenable memory.db must never crash
  // the triage command. On open failure, DEGRADE to running WITHOUT dedup (the
  // engine no-ops dedup when `options.memory` is falsy). Mirrors review.ts.
  let store: SqliteMemoryStorage | undefined;
  try {
    store = await openTriageMemory();
    options.memory = store;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    tui.log.warn(`⚠️  Failed to initialize triage memory (dedup disabled): ${msg}`);
    options.memory = undefined;
  }
  try {
    return await fn();
  } finally {
    // Only flush/close if the store actually opened.
    await store?.close();
  }
}

export const triageCommand = new Command('triage').description(
  'Code-aware issue triage with a local human-approval queue (never auto-posts)',
);

triageCommand.option(
  '--config <path>',
  'Path to the triage config file (default: ./.ghagga/triage.config.json)',
);

// ─── triage <iid> | --new ───────────────────────────────────────

triageCommand
  .command('triage [iid]')
  .description('Triage one issue by iid, or every new issue not already queued with --new')
  .option('--new', 'Triage every issue returned by the forge that is not already queued')
  .option(
    '--reproduce',
    'Attempt a live-app reproduction before triaging this issue (single-issue only: ' +
      'launches a browser + costs LLM calls, so it is ignored with --new)',
  )
  .action(async (iid: string | undefined, opts: { new?: boolean; reproduce?: boolean }) => {
    const configPath = triageCommand.opts().config;

    if (opts.new) {
      if (opts.reproduce) {
        tui.log.warn(
          '--reproduce is ignored with --new (too slow/costly across many issues). ' +
            'Reproduce per-issue instead: ghagga triage triage <iid> --reproduce',
        );
      }
      const options = resolveEngineOptions(configPath);
      const drafts = await runWithMemory(options, () => triageNew(options));
      tui.log.success(`Triaged ${drafts.length} new issue(s).`);
      return;
    }

    if (!iid) {
      tui.log.error('Usage: ghagga triage triage <iid> | ghagga triage triage --new');
      process.exitCode = 1;
      return;
    }

    const options = resolveEngineOptions(configPath, { reproduce: opts.reproduce });
    const draft = await runWithMemory(options, () => triageIssue(options, iid));
    const kindNote = draft.kind === 'DUPLICATE' ? ' — DUPLICATE (analysis skipped)' : '';
    tui.log.success(`#${iid} triaged -> ${draft.status} (queued for review)${kindNote}.`);
  });

// ─── list ───────────────────────────────────────────────────────

triageCommand
  .command('list')
  .description('List the local approval queue')
  .action(() => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    const queue = listQueue(options);
    const drafts = Object.values(queue);

    if (!drafts.length) {
      tui.log.info('Queue is empty.');
      return;
    }

    for (const draft of drafts) {
      tui.log.message(`#${draft.issueIid}  [${draft.status}]`);
    }
  });

// ─── show <iid> ─────────────────────────────────────────────────

triageCommand
  .command('show <iid>')
  .description('Show a queued draft in full (technical analysis + client reply)')
  .action((iid: string) => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    const draft = showDraft(options, iid);
    tui.log.message(`#${draft.issueIid}  status=${draft.status}  kind=${draft.kind ?? 'ANALYSIS'}`);
    if (draft.dedupMatches?.length) {
      tui.log.message('--- likely duplicate of (memory dedup) ---');
      for (const match of draft.dedupMatches) {
        tui.log.message(
          `  • ${match.title} (observation #${match.observationId}, overlap ${match.score.toFixed(2)})`,
        );
      }
    }
    tui.log.message('--- technical analysis (internal, NEVER posted) ---');
    tui.log.message(draft.report);
    tui.log.message('--- client reply (what gets posted on approve) ---');
    tui.log.message(draft.clientReply);
  });

// ─── edit <iid> ─────────────────────────────────────────────────

triageCommand
  .command('edit <iid>')
  .description('Edit the client reply of a queued draft')
  .requiredOption('--reply <text>', 'New client-reply text')
  .action((iid: string, opts: { reply: string }) => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    editDraft(options, iid, opts.reply);
    tui.log.success(`#${iid} client reply updated.`);
  });

// ─── approve <iid> ──────────────────────────────────────────────

triageCommand
  .command('approve <iid>')
  .description('Approve a queued draft and post the client reply to the forge')
  .option('--reply <text>', 'Override the client reply text before posting')
  .action(async (iid: string, opts: { reply?: string }) => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    const result = await approveIssue(options, iid, opts.reply);

    if (result.posted) {
      tui.log.success(`#${iid} posted to ${options.config.forge} and marked POSTED.`);
    } else {
      tui.log.info(`#${iid} was already POSTED — no repost.`);
    }
  });

// ─── reject <iid> ───────────────────────────────────────────────

triageCommand
  .command('reject <iid>')
  .description('Reject a queued draft (never posts)')
  .action((iid: string) => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    rejectIssue(options, iid);
    tui.log.success(`#${iid} rejected — nothing was posted.`);
  });

// ─── serve [port] ───────────────────────────────────────────────

triageCommand
  .command('serve [port]')
  .description('Start the local web review UI (default port 4599)')
  .action((port: string | undefined) => {
    const options = resolveEngineOptions(triageCommand.opts().config);
    startTriageServer(options, port ? Number(port) : undefined);
  });
