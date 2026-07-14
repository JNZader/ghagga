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

import { Command } from 'commander';
import { createCLIBridgeGenerateFn } from 'ghagga-core';
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
import * as tui from '../ui/tui.js';

/** Resolves the TriageConfig + generateFns from `--config` (or its defaults). */
function resolveEngineOptions(configPath?: string): EngineOptions {
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
  };
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
  .action(async (iid: string | undefined, opts: { new?: boolean }) => {
    const options = resolveEngineOptions(triageCommand.opts().config);

    if (opts.new) {
      const drafts = await triageNew(options);
      tui.log.success(`Triaged ${drafts.length} new issue(s).`);
      return;
    }

    if (!iid) {
      tui.log.error('Usage: ghagga triage triage <iid> | ghagga triage triage --new');
      process.exitCode = 1;
      return;
    }

    const draft = await triageIssue(options, iid);
    tui.log.success(`#${iid} triaged -> ${draft.status} (queued for review).`);
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
    tui.log.message(`#${draft.issueIid}  status=${draft.status}`);
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
