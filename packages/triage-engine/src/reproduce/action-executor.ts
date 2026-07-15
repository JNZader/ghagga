/**
 * Action executor — builds and runs the Playwright locator for a `ReproAction`
 * emitted by the LLM. Direct generalization of the PoC's action-execution
 * block (biogas-repro.mts): a plain `role`+`name` locator, OR — when the LLM
 * targets an icon-only button without an accessible name — a row-scoped
 * `getByRole('row', { name: /near/i }).getByRole(role)` locator.
 *
 * `buildActionLocator` is exported separately so the locator-BUILDING logic
 * can be unit-tested against a mocked page/locator, without a real browser.
 */

import type { ReproAction } from './parse-action.js';

export interface ExecutableLocator {
  getByRole(role: string, options?: { name?: string | RegExp }): ExecutableLocator;
  first(): ExecutableLocator;
  fill(value: string): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
}

export interface ExecutablePage {
  getByRole(role: string, options?: { name?: string | RegExp }): ExecutableLocator;
}

/** Escapes regex-special characters so `near` can be used safely inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds (without executing) the locator for `action`. Exported for direct
 * unit testing of the targeting logic.
 */
export function buildActionLocator(page: ExecutablePage, action: ReproAction): ExecutableLocator {
  const role = action.role ?? 'button';
  if (action.near) {
    const pattern = new RegExp(escapeRegExp(action.near), 'i');
    return page.getByRole('row', { name: pattern }).getByRole(role, undefined).first();
  }
  return page.getByRole(role, { name: action.name ?? '' }).first();
}

/** Executes `action` against `page`: `fill` for fill actions, bounded `click` otherwise. */
export async function executeAction(page: ExecutablePage, action: ReproAction): Promise<void> {
  const locator = buildActionLocator(page, action);
  if (action.action === 'fill') {
    await locator.fill(String(action.value ?? ''));
  } else {
    await locator.click({ timeout: 5000 });
  }
}
