/**
 * Audit command — full-project security and code-quality audit.
 *
 * Runs static analysis tools against a project directory and optionally
 * calls an LLM to produce an executive audit report. Use --quick to
 * skip the LLM and get static findings only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AuditResult, LLMProvider, ReviewFinding, StaticAnalysisResult } from 'ghagga-core';
import {
  createNodeExecutionContext,
  DEFAULT_MODELS,
  formatStaticAnalysisContext,
  initializeDefaultTools,
  resolveActivatedTools,
  runAuditReport,
  runTools,
  toolRegistry,
} from 'ghagga-core';
import { getConfigDir, getStoredToken, loadConfig } from '../lib/config.js';
import { resolveProjectId } from '../lib/git.js';
import { isLegacyProvider, remapLegacyStoredProvider } from '../lib/providers.js';
import { formatSeverityLine } from '../ui/format.js';
import * as tui from '../ui/tui.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AuditOptions {
  /** Skip LLM call — static analysis only */
  quick?: boolean;
  /** LLM provider (overrides config) */
  provider?: string;
  /** LLM model (overrides config) */
  model?: string;
  /** API key (overrides config/env) */
  apiKey?: string;
  /** Output format: 'text' (default) or 'json' */
  output?: string;
  /** Persist audit result to history file */
  save?: boolean;
}

// ─── Main Command ───────────────────────────────────────────────

export async function auditCommand(targetPath: string, options: AuditOptions): Promise<void> {
  const repoPath = resolve(targetPath);

  try {
    // Step 1: Validate path
    if (!existsSync(repoPath)) {
      tui.log.error(`❌ Path does not exist: ${repoPath}`);
      process.exit(1);
    }

    if (!statSync(repoPath).isDirectory()) {
      tui.log.error(`❌ Path is not a directory: ${repoPath}`);
      process.exit(1);
    }

    // Step 2: Resolve auth (if not --quick)
    let provider = options.provider;
    let model = options.model;
    let apiKey = options.apiKey;

    if (!options.quick) {
      const config = loadConfig();

      // Explicit legacy values (--provider flag / env var) are a hard error —
      // same behavior as "ghagga review". Only STORED CONFIG values are
      // remapped (read-time migration below).
      if (isLegacyProvider(provider)) {
        tui.log.error(
          `\n❌ Provider '${provider}' is no longer supported directly.\n` +
            `  → Set --provider gateway and configure credentials in mcp-llm-bridge.\n` +
            `  → See: https://github.com/JNZader/mcp-llm-bridge\n\n` +
            `  Or use --provider cli-bridge for local CLI tools (Claude Code, OpenCode, Copilot).\n`,
        );
        process.exit(1);
      }

      let providerRemapped = false;
      if (!provider) {
        provider = config.defaultProvider ?? 'gateway';

        // Read-time migration: legacy provider stored by an old "ghagga login"
        const remap = remapLegacyStoredProvider(provider);
        if (remap.remapped) {
          tui.log.warn(
            `⚠️  Stored provider '${provider}' is no longer supported — using 'gateway' instead.\n` +
              `   Run "ghagga login" again to refresh your saved config.`,
          );
          provider = remap.provider;
          providerRemapped = true;
        }
      }

      if (!model) {
        // A stored model belongs to the legacy provider — ignore it after remap
        model =
          (providerRemapped ? undefined : config.defaultModel) ??
          DEFAULT_MODELS[provider as LLMProvider];
      }

      if (!apiKey) {
        apiKey = process.env.GHAGGA_API_KEY ?? undefined;
        // gateway / cli-bridge can use the stored GitHub token (same as review)
        if (!apiKey && (provider === 'gateway' || provider === 'cli-bridge')) {
          apiKey = getStoredToken() ?? undefined;
        }
      }

      // ollama, cli-bridge, and gateway (when self-hosted) don't require a key
      const noKeyRequired =
        provider === 'ollama' || provider === 'cli-bridge' || provider === 'gateway';

      if (!apiKey && !noKeyRequired) {
        tui.log.error('❌ No API key available.\n');
        tui.log.error('   Quick fix: run "ghagga login" to authenticate.');
        tui.log.error('   Or pass --api-key <key> or set GHAGGA_API_KEY.');
        tui.log.error('   Or use --provider ollama for local models (no key needed).');
        tui.log.error('   Or use --quick to run static analysis only.\n');
        process.exit(1);
      }

      // Ollama doesn't need an API key — use a placeholder
      if (provider === 'ollama' && !apiKey) {
        apiKey = 'ollama';
      }
    }

    // Step 3: Initialize tool registry
    initializeDefaultTools();

    if (!options.output) {
      tui.intro('🔍 GHAGGA Audit');
    }

    // Step 4: Run static analysis (all tools)
    if (!options.output) {
      tui.log.step('Running static analysis...');
    }

    const allTools = resolveActivatedTools({
      registry: toolRegistry,
      files: [],
      enabledTools: toolRegistry.getAll().map((t) => t.name),
    });

    if (allTools.length === 0) {
      tui.log.warn('⚠️  No static analysis tools available. Exiting.');
      process.exit(0);
    }

    const ctx = createNodeExecutionContext();
    const staticResult: StaticAnalysisResult = (await runTools(
      ctx,
      allTools,
      repoPath,
      [],
    )) as StaticAnalysisResult;

    // Step 5: Format static context
    const staticContext = formatStaticAnalysisContext(staticResult);

    // Collect raw findings for output/save
    const allFindings: ReviewFinding[] = [];
    for (const toolResult of Object.values(staticResult)) {
      if (toolResult && typeof toolResult === 'object' && 'findings' in toolResult) {
        allFindings.push(...(toolResult as { findings: ReviewFinding[] }).findings);
      }
    }

    // Step 6: --quick path — print findings and exit
    if (options.quick) {
      if (options.output === 'json') {
        console.log(
          JSON.stringify(
            {
              mode: 'quick',
              findings: allFindings,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      } else {
        renderStaticFindings(allFindings, staticContext);
      }

      if (!options.output) {
        tui.outro('Audit complete (static only)');
      }
      return;
    }

    // Step 7: LLM audit report
    if (!options.output) {
      tui.log.step('Running LLM audit...');
    }

    let auditResult: AuditResult;

    try {
      auditResult = await runAuditReport({
        repoPath,
        staticContext,
        provider: provider ?? 'gateway',
        model: model ?? DEFAULT_MODELS[(provider ?? 'gateway') as LLMProvider],
        apiKey: apiKey ?? '',
        onProgress: options.output
          ? undefined
          : (event) => {
              tui.log.step(`  ${event.message}`);
            },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tui.log.warn(`⚠️  LLM audit failed: ${message}`);
      tui.log.warn('   Falling back to static findings only.');

      if (options.output === 'json') {
        console.log(
          JSON.stringify(
            {
              mode: 'quick',
              error: message,
              findings: allFindings,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      } else {
        renderStaticFindings(allFindings, staticContext);
      }

      if (!options.output) {
        tui.outro('Audit complete (static only — LLM unavailable)');
      }
      return;
    }

    // Step 8: Output
    if (options.output === 'json') {
      console.log(
        JSON.stringify(
          {
            status: auditResult.status,
            report: auditResult.report,
            findings: allFindings,
            timestamp: auditResult.timestamp,
            ...(auditResult.error ? { error: auditResult.error } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      renderAuditReport(auditResult, allFindings);
    }

    // Step 9: Save to history if --save flag is set
    if (options.save) {
      const projectPath = resolveProjectId(repoPath);
      const configDir = getConfigDir();
      persistAuditEntry(configDir, projectPath, auditResult, allFindings);
    }

    if (!options.output) {
      tui.outro('Audit complete');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.log.error(`\n❌ Audit failed: ${message}`);
    process.exit(1);
  }
}

// ─── Styled Output ──────────────────────────────────────────────

function renderStaticFindings(findings: ReviewFinding[], staticContext: string): void {
  if (findings.length === 0) {
    tui.log.message(tui.box('Audit Results', ['✅ No static analysis findings.']));
    return;
  }

  const boxLines = [
    `Total findings: ${findings.length}`,
    '',
    `Critical: ${findings.filter((f) => f.severity === 'critical').length}`,
    `High:     ${findings.filter((f) => f.severity === 'high').length}`,
    `Medium:   ${findings.filter((f) => f.severity === 'medium').length}`,
    `Low:      ${findings.filter((f) => f.severity === 'low').length}`,
    `Info:     ${findings.filter((f) => f.severity === 'info').length}`,
  ];

  tui.log.message(tui.box('Static Analysis Results', boxLines));

  if (staticContext.length > 0) {
    tui.log.message('');
    tui.log.message(tui.divider('Findings'));
    const topFindings = findings.slice(0, 20);
    for (const finding of topFindings) {
      tui.log.message(`  ${formatSeverityLine(finding)}`);
    }
    if (findings.length > 20) {
      tui.log.message(`  ... and ${findings.length - 20} more findings`);
    }
  }
}

function renderAuditReport(auditResult: AuditResult, allFindings: ReviewFinding[]): void {
  const statusIcon =
    auditResult.status === 'completed' ? '✅' : auditResult.status === 'no-findings' ? '✅' : '⚠️';

  const summaryLines = [
    `Status: ${auditResult.status}`,
    `Findings: ${allFindings.length} total`,
    `Timestamp: ${auditResult.timestamp}`,
  ];

  tui.log.message(tui.box(`${statusIcon} Audit Report`, summaryLines));

  if (auditResult.report) {
    tui.log.message('');
    tui.log.message(tui.divider('Executive Report'));
    tui.log.message(auditResult.report);
  }

  if (auditResult.error) {
    tui.log.message('');
    tui.log.warn(`⚠️  Error: ${auditResult.error}`);
  }
}

// ─── History Persistence ─────────────────────────────────────────

interface AuditHistoryEntry {
  timestamp: string;
  status: string;
  findingCount: number;
  projectPath: string;
  report?: string;
}

const AUDIT_HISTORY_FILE = 'audit-history.json';
const MAX_AUDIT_ENTRIES = 20;

function persistAuditEntry(
  configDir: string,
  projectPath: string,
  auditResult: AuditResult,
  findings: ReviewFinding[],
): void {
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const historyPath = join(configDir, AUDIT_HISTORY_FILE);
    let entries: AuditHistoryEntry[] = [];

    if (existsSync(historyPath)) {
      try {
        entries = JSON.parse(readFileSync(historyPath, 'utf-8')) as AuditHistoryEntry[];
      } catch {
        // Non-critical trend history: don't abort the save, but surface the reset instead of silently wiping it.
        tui.log.warn('⚠️  Existing audit history was unreadable; starting a fresh history file');
        entries = [];
      }
    }

    const newEntry: AuditHistoryEntry = {
      timestamp: auditResult.timestamp,
      status: auditResult.status,
      findingCount: findings.length,
      projectPath,
      report: auditResult.report || undefined,
    };

    entries.push(newEntry);

    // Prune oldest entries beyond max (keep newest)
    if (entries.length > MAX_AUDIT_ENTRIES) {
      entries = entries.slice(entries.length - MAX_AUDIT_ENTRIES);
    }

    const tmpPath = `${historyPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, historyPath); // atomic on POSIX — never truncate existing history mid-write
    tui.log.success('✅ Audit saved to history');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.log.warn(`⚠️  Could not save audit history: ${message}`);
  }
}
