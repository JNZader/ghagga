/**
 * Evidence capture — attaches console/pageerror/network listeners to a
 * Playwright-shaped page and reads UI-visible error text, building the
 * pieces of a `ReproEvidence` (types/evidence.ts). Direct generalization of
 * the PoC's evidence-capture block (biogas-repro.mts).
 *
 * `ReproEvidence` has a single `consoleErrors` field (no separate
 * `pageErrors`, unlike the PoC) — `pageerror` exceptions are folded into
 * `consoleErrors`, since both represent "the app broke on its own", just via
 * a different browser event.
 */

import type { NetworkFailure } from '../types/evidence.js';

export interface EvidenceConsoleMessage {
  type(): string;
  text(): string;
}

export interface EvidencePageError {
  message: string;
}

export interface EvidenceResponse {
  status(): number;
  url(): string;
  request(): { method(): string };
  text(): Promise<string>;
}

export interface EvidenceCapablePage {
  on(event: 'console', handler: (message: EvidenceConsoleMessage) => void): void;
  on(event: 'pageerror', handler: (error: EvidencePageError) => void): void;
  on(event: 'response', handler: (response: EvidenceResponse) => void): void;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

const MAX_MESSAGE_LENGTH = 300;
const MAX_BODY_LENGTH = 800;
const MIN_FAILURE_STATUS = 400;

export interface AttachedEvidence {
  consoleErrors: string[];
  netFails: NetworkFailure[];
}

/**
 * Registers `console`/`pageerror`/`response` listeners on `page` and returns
 * the (live, mutated-in-place) arrays they fill. Call this BEFORE any
 * navigation so early errors aren't missed.
 */
export function attachEvidenceListeners(page: EvidenceCapablePage): AttachedEvidence {
  const consoleErrors: string[] = [];
  const netFails: NetworkFailure[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, MAX_MESSAGE_LENGTH));
    }
  });

  page.on('pageerror', (error) => {
    consoleErrors.push(error.message.slice(0, MAX_MESSAGE_LENGTH));
  });

  page.on('response', (response) => {
    if (response.status() >= MIN_FAILURE_STATUS) {
      void (async () => {
        let body = '';
        try {
          body = (await response.text()).slice(0, MAX_BODY_LENGTH);
        } catch {
          // opaque response body — leave empty
        }
        netFails.push({
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          body,
        });
      })();
    }
  });

  return { consoleErrors, netFails };
}

/**
 * Reads UI-visible error text (client-side validation / notifications) —
 * no network round-trip needed. Returns `[]` on any evaluation failure
 * (e.g. a detached frame) rather than throwing.
 */
export async function captureUIErrors(page: EvidenceCapablePage): Promise<string[]> {
  try {
    const raw = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll('[role=alert],[class*="rror"],[class*="Notification"]'),
      )) {
        const text = (el.textContent || '').trim();
        if (text && text.length < 200) out.push(text);
      }
      return out;
    });
    return [...new Set(raw)];
  } catch {
    return [];
  }
}
