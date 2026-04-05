/**
 * `ghagga feedback` command.
 *
 * Records whether a finding was accepted, rejected, or modified.
 * Used by the self-improvement loop to derive future review rules.
 *
 * Usage:
 *   ghagga feedback <pr-url> <finding-hash> <accepted|rejected|modified>
 *
 * Options:
 *   --category <name>   Finding category (e.g., "security", "style")
 *   --severity <level>  Finding severity (e.g., "high", "medium")
 *   --model <id>        Model that produced the finding
 *   --path <file>       Path to the feedback storage file (default: ~/.ghagga/feedback.jsonl)
 */

import { join } from 'node:path';
import { Command } from 'commander';
import type { FindingOutcome } from 'ghagga-core';
import { deriveRules, loadFeedback, recordFeedback } from 'ghagga-core';
import { getConfigDir } from '../lib/config.js';
import * as tui from '../ui/tui.js';

// ─── Main command ────────────────────────────────────────────────

export const feedbackCommand = new Command('feedback')
  .description('Record feedback on a finding to improve future reviews')
  .argument('<pr-url>', 'Pull request URL (used for context / traceability)')
  .argument('<finding-hash>', 'Hash of the finding to record feedback for')
  .argument('<outcome>', 'Outcome: accepted | rejected | modified')
  .option('--category <name>', 'Finding category (e.g., security, style)', 'general')
  .option('--severity <level>', 'Finding severity (e.g., critical, high, medium, low)', 'medium')
  .option('--model <id>', 'Model that produced the finding', 'unknown')
  .option('--path <file>', 'Path to feedback storage file')
  .action(
    async (
      prUrl: string,
      findingHash: string,
      outcome: string,
      opts: { category: string; severity: string; model: string; path?: string },
    ) => {
      const validOutcomes: FindingOutcome[] = ['accepted', 'rejected', 'modified'];
      if (!validOutcomes.includes(outcome as FindingOutcome)) {
        tui.log.error(
          `Error: invalid outcome "${outcome}". Must be one of: ${validOutcomes.join(', ')}`,
        );
        process.exit(1);
      }

      const storagePath = opts.path ?? join(getConfigDir(), 'feedback.jsonl');

      try {
        await recordFeedback(
          {
            findingHash,
            outcome: outcome as FindingOutcome,
            category: opts.category,
            severity: opts.severity,
            modelUsed: opts.model,
            recordedAt: new Date().toISOString(),
          },
          storagePath,
        );

        tui.log.success(
          `✓ Feedback recorded\n` +
            `  pr: ${prUrl}\n` +
            `  hash: ${findingHash}\n` +
            `  outcome: ${outcome}\n` +
            `  category: ${opts.category}`,
        );
      } catch (error) {
        tui.log.error(
          `Error recording feedback: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    },
  );

// ─── feedback rules ───────────────────────────────────────────────

feedbackCommand
  .command('rules')
  .description('Show derived improvement rules from recorded feedback')
  .option('--path <file>', 'Path to feedback storage file')
  .action(async (opts: { path?: string }) => {
    const storagePath = opts.path ?? join(getConfigDir(), 'feedback.jsonl');

    try {
      const feedback = await loadFeedback(storagePath);

      if (feedback.length === 0) {
        tui.log.info(
          "No feedback recorded yet. Use 'ghagga feedback <pr-url> <hash> <outcome>' to record feedback.",
        );
        return;
      }

      const rules = deriveRules(feedback);

      if (rules.length === 0) {
        tui.log.info(
          `${feedback.length} feedback records found, but no rules derived yet.\n` +
            `Rules require at least 5 samples per category with >70% rejection or >80% acceptance rate.`,
        );
        return;
      }

      tui.log.message(
        `Derived ${rules.length} improvement rule(s) from ${feedback.length} feedback records:\n`,
      );
      for (const rule of rules) {
        const pct = Math.round(rule.confidence * 100);
        const arrow = rule.action === 'suppress' ? '↓ SUPPRESS' : '↑ PRIORITIZE';
        tui.log.message(
          `  ${arrow} [${rule.category}] — ${pct}% confidence, ${rule.sampleCount} samples`,
        );
      }
    } catch (error) {
      tui.log.error(
        `Error loading feedback: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

// ─── feedback list ────────────────────────────────────────────────

feedbackCommand
  .command('list')
  .description('List all recorded feedback entries')
  .option('--path <file>', 'Path to feedback storage file')
  .option('--category <name>', 'Filter by category')
  .option('--outcome <type>', 'Filter by outcome: accepted | rejected | modified')
  .action(async (opts: { path?: string; category?: string; outcome?: string }) => {
    const storagePath = opts.path ?? join(getConfigDir(), 'feedback.jsonl');

    try {
      let records = await loadFeedback(storagePath);

      if (opts.category) {
        records = records.filter((r) => r.category === opts.category);
      }
      if (opts.outcome) {
        records = records.filter((r) => r.outcome === opts.outcome);
      }

      if (records.length === 0) {
        tui.log.info('No feedback records found.');
        return;
      }

      tui.log.message(`Found ${records.length} record(s):\n`);
      for (const rec of records) {
        tui.log.message(
          `  [${rec.outcome.toUpperCase()}] ${rec.findingHash.slice(0, 12)} ` +
            `cat=${rec.category} sev=${rec.severity} model=${rec.modelUsed} ` +
            `at=${rec.recordedAt.slice(0, 10)}`,
        );
      }
    } catch (error) {
      tui.log.error(
        `Error loading feedback: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });
