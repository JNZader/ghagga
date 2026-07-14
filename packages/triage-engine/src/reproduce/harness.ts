/**
 * REPRODUCE — LLM-driven reproduction agent (design.md decision 7).
 *
 * Drives the live app in a real (headless) browser to REPRODUCE a reported
 * issue: an agentic loop feeds the page's dialog-aware aria snapshot + the
 * issue to an LLM, which emits the next UI action; the harness executes it
 * and captures console/network/UI errors. Direct generalization of the
 * biogas PoC (biogas-repro.mts).
 *
 * `@playwright/test` is an OPTIONAL peer dependency: this module `import()`s
 * it lazily, ONLY when `reproduce()` is actually called, so the rest of
 * `ghagga-triage-engine` (config/forge/locate/triage/queue) works without it
 * installed. Callers that never reproduce never pay the Playwright cost.
 */

import type { GenerateTextFn } from 'ghagga-core';
import type { TriageConfig } from '../config/schema.js';
import type { NetworkFailure, ReproEvidence } from '../types/evidence.js';
import { executeAction } from './action-executor.js';
import { attachEvidenceListeners, captureUIErrors } from './evidence.js';
import { runLoginRecipe } from './login.js';
import type { ReproAction } from './parse-action.js';
import { parseAction } from './parse-action.js';
import { captureScopedSnapshot } from './snapshot.js';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_VIEWPORT = { width: 1366, height: 633 };
const DEFAULT_STEP_DELAY_MS = 1300;

export class PlaywrightNotInstalledError extends Error {
  constructor() {
    super(
      "reproduce() requires '@playwright/test' to be installed. It is an optional peer " +
        'dependency of ghagga-triage-engine — run `pnpm add -D @playwright/test && npx playwright install chromium` ' +
        'in your project to enable browser-driven reproduction.',
    );
    this.name = 'PlaywrightNotInstalledError';
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the whole point of this type is "whatever @playwright/test's module namespace is" without a hard import
type PlaywrightModule = any;
type PlaywrightLoader = () => Promise<PlaywrightModule>;

const defaultLoader: PlaywrightLoader = () => import('@playwright/test');

async function loadPlaywright(loader: PlaywrightLoader = defaultLoader): Promise<PlaywrightModule> {
  try {
    return await loader();
  } catch {
    throw new PlaywrightNotInstalledError();
  }
}

/**
 * Best-effort check for whether a real reproduction run is currently
 * possible on this machine (package installed AND a chromium binary
 * launches). Used to gate browser-requiring tests — never throws.
 */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

export interface ReproduceIssueInput {
  title: string;
  body: string;
}

export interface ReproduceOptions {
  /** Route appended to `config.app.baseURL` after login (e.g. `/app/alerts` or `#/app`). */
  route: string;
  maxSteps?: number;
  headless?: boolean;
  viewport?: { width: number; height: number };
  credentials?: { email?: string; password?: string };
  /** Absolute path to write a full-page screenshot to; omitted = no screenshot. */
  screenshotPath?: string;
  /** Delay after each action before checking whether new errors appeared (default 1300ms). */
  stepDelayMs?: number;
}

const REPRO_SYSTEM_PROMPT =
  'You are a QA agent reproducing a reported bug by driving a real web app. You are given the ' +
  'issue and the accessibility snapshot of the CURRENT screen. Reply with ONLY a JSON object for ' +
  'the NEXT action to move toward reproducing the bug. Schema: ' +
  '{"action":"click"|"fill","role":"<aria role>","name":"<accessible name>","value":"<only if fill>","near":"<row text, optional>"}. ' +
  'If the control is an icon-only button WITHOUT an accessible name inside a table row, use ' +
  '{"action":"click","role":"button","near":"<row text>"} to click that row\'s button. ' +
  'When the bug has already triggered or you cannot proceed, reply {"action":"done"}. No prose.';

function buildReproPrompt(
  issue: ReproduceIssueInput,
  snapshot: string,
  history: ReproAction[],
): string {
  return (
    `ISSUE: "${issue.title}"\n${issue.body}\n\nCURRENT SCREEN (aria snapshot):\n${snapshot}\n\n` +
    `ACTIONS ALREADY TAKEN: ${JSON.stringify(history)}\n\nNext action (JSON):`
  );
}

function skippedEvidence(reason: string): ReproEvidence {
  return { reproduced: false, steps: [reason], consoleErrors: [], netFails: [], uiErrors: [] };
}

/**
 * Runs the full REPRODUCE pipeline: login → agentic loop (snapshot → LLM →
 * execute → capture) → evidence. A non-reproduction (`reproduced: false`) is
 * a valid, meaningful result, not an error (design.md decision 5).
 *
 * `playwrightLoader` is injectable for testing the "Playwright not
 * installed" error path without actually uninstalling the package.
 */
export async function reproduce(
  issue: ReproduceIssueInput,
  config: TriageConfig,
  generateFn: GenerateTextFn,
  options: ReproduceOptions,
  playwrightLoader: PlaywrightLoader = defaultLoader,
): Promise<ReproEvidence> {
  if (!config.app) {
    return skippedEvidence('reproduction skipped: config.app.baseURL is not configured');
  }

  const { chromium } = await loadPlaywright(playwrightLoader);
  const browser = await chromium.launch({ headless: options.headless ?? true });

  try {
    const storageStatePath =
      config.app.loginRecipe.kind === 'storageState' ? config.app.loginRecipe.path : undefined;
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });
    const page = await context.newPage();
    const { consoleErrors, netFails } = attachEvidenceListeners(page);

    const steps: string[] = [];
    const record = (line: string) => steps.push(line);

    const loginResult = await runLoginRecipe(page, config.app.loginRecipe, {
      baseURL: config.app.baseURL,
      credentials: options.credentials,
    });
    record(loginResult.note);

    const history: ReproAction[] = [];
    let reproduced = false;
    const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
    const errorCount = () => netFails.length + consoleErrors.length;

    if (loginResult.loggedIn) {
      await page.goto(`${config.app.baseURL}${options.route}`, {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      record(`navigated to ${options.route}`);

      const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
      for (let i = 0; i < maxSteps; i++) {
        const snapshot = await captureScopedSnapshot(page);
        const before = errorCount();
        const raw = await generateFn(
          REPRO_SYSTEM_PROMPT,
          buildReproPrompt(issue, snapshot, history),
        );
        const action = parseAction(raw.text);

        if (!action || action.action === 'done') {
          record(`LLM decided to stop (step ${i + 1})`);
          break;
        }

        try {
          await executeAction(page, action);
          history.push(action);
          const target = action.near ? ` @row "${action.near}"` : ` "${action.name ?? ''}"`;
          record(`step ${i + 1}: ${action.action} ${action.role ?? 'button'}${target}`);
        } catch (error) {
          history.push({ ...action, failed: true });
          record(
            `step ${i + 1} FAILED (${action.action} "${action.name ?? action.near ?? ''}"): ${(error as Error).message.split('\n')[0].slice(0, 80)}`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        if (errorCount() > before) {
          reproduced = true;
          record('error captured after action — bug REPRODUCED');
          break;
        }
      }
    }

    const uiErrors = await captureUIErrors(page);
    if (uiErrors.length > 0) reproduced = true;

    let screenshotRef: string | undefined;
    if (options.screenshotPath) {
      try {
        await page.screenshot({ path: options.screenshotPath, fullPage: true });
        screenshotRef = options.screenshotPath;
      } catch {
        // screenshot failure is non-fatal to reproduction evidence
      }
    }

    return {
      reproduced,
      steps,
      consoleErrors,
      netFails: netFails as NetworkFailure[],
      uiErrors,
      ...(screenshotRef ? { screenshotRef } : {}),
    };
  } finally {
    await browser.close();
  }
}
