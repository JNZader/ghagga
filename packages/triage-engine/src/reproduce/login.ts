/**
 * Login recipe executor — runs a `LoginRecipe` (config/schema.ts discriminated
 * union) against a Playwright-shaped page. The `steps` interpreter is the
 * direct generalization of the PoC's login sequence (biogas-repro.mts —
 * goto /login, fill Email/Contraseña, click submit).
 *
 * Structurally typed against a minimal `LoginPage` interface (not
 * `@playwright/test`'s `Page`) so the step interpreter is unit-testable with
 * a plain mock object — no browser, no lazy import, needed for this module.
 * A real Playwright `Page` satisfies `LoginPage` structurally.
 */

import type { LoginRecipe, LoginStep } from '../config/schema.js';

export interface LoginLocator {
  fill(value: string): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
}

export interface LoginPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  getByLabel(label: string): LoginLocator;
  getByRole(role: string, options?: { name?: string }): LoginLocator;
  waitForURL(pattern: RegExp, options?: { timeout?: number }): Promise<unknown>;
}

export interface LoginContext {
  baseURL: string;
  credentials?: { email?: string; password?: string };
}

export interface LoginResult {
  loggedIn: boolean;
  note: string;
}

/** Resolves `{{email}}` / `{{password}}` placeholders against `ctx.credentials`; any other value is literal. */
function resolveStepValue(step: LoginStep, ctx: LoginContext): string {
  if (step.value === '{{email}}') return ctx.credentials?.email ?? '';
  if (step.value === '{{password}}') return ctx.credentials?.password ?? '';
  return step.value ?? '';
}

async function runLoginSteps(
  page: LoginPage,
  steps: LoginStep[],
  ctx: LoginContext,
): Promise<LoginResult> {
  try {
    for (const step of steps) {
      switch (step.action) {
        case 'goto': {
          const url = step.url ?? ctx.baseURL;
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          break;
        }
        case 'fill': {
          const value = resolveStepValue(step, ctx);
          const locator = step.label
            ? page.getByLabel(step.label)
            : page.getByRole(step.role ?? 'textbox', { name: step.name });
          await locator.fill(value);
          break;
        }
        case 'click': {
          const locator = step.label
            ? page.getByLabel(step.label)
            : page.getByRole(step.role ?? 'button', { name: step.name });
          await locator.click();
          break;
        }
      }
    }
    return { loggedIn: true, note: `login steps completed (${steps.length} step(s))` };
  } catch (error) {
    return { loggedIn: false, note: `login FAILED: ${(error as Error).message.split('\n')[0]}` };
  }
}

/**
 * Runs `recipe` against `page`. `storageState` is a no-op here — the browser
 * context is expected to have already loaded the storage state file at
 * context-creation time (see harness.ts), so reaching this point means the
 * session is already authenticated.
 */
export async function runLoginRecipe(
  page: LoginPage,
  recipe: LoginRecipe,
  ctx: LoginContext,
): Promise<LoginResult> {
  switch (recipe.kind) {
    case 'none':
      return { loggedIn: false, note: 'no auth configured (loginRecipe.kind === "none")' };
    case 'storageState':
      return { loggedIn: true, note: `storage state loaded from ${recipe.path}` };
    case 'steps':
      return runLoginSteps(page, recipe.steps, ctx);
  }
}
