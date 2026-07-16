import { fileURLToPath } from 'node:url';
import type { GenerateTextFn } from 'ghagga-core';
import { describe, expect, it, vi } from 'vitest';
import type { TriageConfig } from '../config/schema.js';
import { isChromiumAvailable, PlaywrightNotInstalledError, reproduce } from './harness.js';

// Computed once at module-collection time so we can `it.skipIf` the
// browser-requiring tests below without ever failing CI on a machine
// that has @playwright/test installed but no downloaded chromium binary.
const chromiumAvailable = await isChromiumAvailable();
if (!chromiumAvailable) {
  console.warn(
    'SKIP: chromium not available locally (no @playwright/test browser install found) — ' +
      'skipping reproduce() fixture agentic-loop integration tests. Pure-seam unit tests ' +
      '(parse-action, login, action-executor, snapshot, evidence) run regardless.',
  );
}

const FIXTURE_URL = `file://${fileURLToPath(new URL('./fixtures/fake-app.html', import.meta.url))}`;

function baseConfig(overrides: Partial<TriageConfig['app']> = {}): TriageConfig {
  return {
    forge: 'gitlab',
    repo: 'acme/widget',
    codeRoot: '/tmp/does-not-matter',
    language: 'ts',
    graphExpand: false,
    models: { rerank: 'x', analysis: 'x' },
    app: {
      baseURL: FIXTURE_URL,
      loginRecipe: {
        kind: 'steps',
        steps: [
          { action: 'goto', url: FIXTURE_URL },
          { action: 'fill', label: 'Email', value: '{{email}}' },
          { action: 'fill', label: 'Contraseña', value: '{{password}}' },
          { action: 'click', role: 'button', name: 'Iniciar sesión' },
        ],
      },
      ...overrides,
    },
  };
}

function mockGenerateFn(script: string[]): { fn: GenerateTextFn; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const fn: GenerateTextFn = vi.fn(async (_system: string, prompt: string) => {
    prompts.push(prompt);
    const text = script[i] ?? '{"action":"done"}';
    i += 1;
    return { text, tokensUsed: 0, provider: 'mock', model: 'mock' };
  });
  return { fn, prompts };
}

describe('PlaywrightNotInstalledError / lazy loading', () => {
  it('reproduce() throws PlaywrightNotInstalledError when the loader fails to import @playwright/test', async () => {
    const { fn } = mockGenerateFn(['{"action":"done"}']);
    const failingLoader = () => Promise.reject(new Error('Cannot find module @playwright/test'));
    await expect(
      reproduce(
        { title: 'x', body: 'y' },
        baseConfig(),
        fn,
        { route: '', credentials: { email: 'a', password: 'b' } },
        failingLoader,
      ),
    ).rejects.toBeInstanceOf(PlaywrightNotInstalledError);
  });

  it('creates the browser context with baseURL === config.app.baseURL so relative gotos resolve', async () => {
    const { fn } = mockGenerateFn([]);
    const newContext = vi.fn(async (_opts: Record<string, unknown>) => ({
      newPage: async () => ({
        on: () => {},
        evaluate: async () => [],
      }),
    }));
    const browser = { newContext, close: vi.fn(async () => {}) };
    const chromium = { launch: vi.fn(async () => browser) };
    const mockLoader = () => Promise.resolve({ chromium });

    // loginRecipe.kind === 'none' short-circuits the agentic loop, so the mock
    // page needs only the surface reproduce() touches before returning.
    const cfg = baseConfig({ loginRecipe: { kind: 'none' } });
    await reproduce({ title: 'x', body: 'y' }, cfg, fn, { route: '/app/energia' }, mockLoader);

    expect(newContext).toHaveBeenCalledTimes(1);
    expect(newContext.mock.calls[0][0]).toMatchObject({ baseURL: FIXTURE_URL });
    if (cfg.app) expect(newContext.mock.calls[0][0]).toMatchObject({ baseURL: cfg.app.baseURL });
  });

  // Fully-mocked browser/page: exercises the login-redirect wait seam without a
  // real chromium. `waitForURL`/`waitForLoadState` are the redirect-wait signals
  // added to fix the login timing race (harness navigates before the SPA
  // post-login redirect establishes the session → unauthenticated reproduce).
  function mockBrowserWithPage(page: Record<string, unknown>) {
    const newContext = vi.fn(async (_opts: Record<string, unknown>) => ({
      newPage: async () => page,
    }));
    const browser = { newContext, close: vi.fn(async () => {}) };
    const chromium = { launch: vi.fn(async () => browser) };
    return { loader: () => Promise.resolve({ chromium }), newContext };
  }

  function fakeStepsPage() {
    const locator = { fill: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    return {
      on: () => {},
      evaluate: async () => [],
      goto: vi.fn(async () => {}),
      getByLabel: vi.fn(() => locator),
      getByRole: vi.fn(() => locator),
      // captureScopedSnapshot falls back to page.locator('body').ariaSnapshot()
      // when getByRole('dialog').count() is unavailable on this bare mock.
      locator: vi.fn(() => ({ ariaSnapshot: async () => '' })),
      waitForURL: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
    };
  }

  it('waits for the post-login redirect (page.waitForURL) for a `steps` recipe', async () => {
    const { fn } = mockGenerateFn(['{"action":"done"}']);
    const page = fakeStepsPage();
    const { loader } = mockBrowserWithPage(page);

    await reproduce(
      { title: 'x', body: 'y' },
      baseConfig(),
      fn,
      { route: '#/app', credentials: { email: 'a@x.test', password: 'b' } },
      loader,
    );

    expect(page.waitForURL).toHaveBeenCalledTimes(1);
    // The predicate must treat a URL still on /login as "not yet left".
    const predicate = page.waitForURL.mock.calls[0][0] as (u: string) => boolean;
    expect(predicate('https://app.test/login')).toBe(false);
    expect(predicate('https://app.test/app/dashboard')).toBe(true);
  });

  it('does NOT wait for a redirect when loginRecipe.kind === "none"', async () => {
    const { fn } = mockGenerateFn([]);
    const page = fakeStepsPage();
    const { loader } = mockBrowserWithPage(page);

    const cfg = baseConfig({ loginRecipe: { kind: 'none' } });
    await reproduce({ title: 'x', body: 'y' }, cfg, fn, { route: '/app/energia' }, loader);

    expect(page.waitForURL).not.toHaveBeenCalled();
  });

  it('returns a skipped-reproduction evidence when config.app is not set (no crash, no browser launch)', async () => {
    const { fn } = mockGenerateFn([]);
    const cfg: TriageConfig = { ...baseConfig(), app: undefined };
    const evidence = await reproduce({ title: 'x', body: 'y' }, cfg, fn, { route: '' });
    expect(evidence.reproduced).toBe(false);
    expect(evidence.steps[0]).toMatch(/app\.baseURL/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('reproduce() — fixture agentic-loop integration (real chromium)', () => {
  it.skipIf(!chromiumAvailable)(
    'dialog-aware snapshot + row-scoped `near` targeting + error capture (real bug reproduction)',
    async () => {
      const { fn, prompts } = mockGenerateFn([
        '{"action":"click","role":"button","near":"pH"}',
        '{"action":"fill","role":"textbox","name":"Nuevo valor de pH","value":"99"}',
        '{"action":"click","role":"button","name":"Guardar"}',
      ]);

      const evidence = await reproduce(
        {
          title: 'El pH se rompe con valores fuera de rango',
          body: 'Al editar pH con un valor inválido, algo falla.',
        },
        baseConfig(),
        fn,
        {
          route: '#/app',
          credentials: { email: 'admin@x.test', password: 'secret' },
          stepDelayMs: 200,
        },
      );

      // dialog-aware snapshot: the 2nd LLM call (after opening the dialog) must have
      // seen the dialog-scoped snapshot, not the bare main-page table.
      expect(prompts[1]).toContain('DIÁLOGO ABIERTO');
      // and it must reflect the CORRECT row (pH, not OD) — proves `near` row-scoped
      // targeting clicked the right row's icon-only button.
      expect(prompts[1]).toContain('Nuevo valor de pH');

      expect(evidence.reproduced).toBe(true);
      expect(evidence.consoleErrors.some((e) => e.includes('Validation failed'))).toBe(true);
      expect(evidence.steps.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    'a scripted run with no injected error is a valid non-repro result ({reproduced:false})',
    async () => {
      const { fn } = mockGenerateFn(['{"action":"done"}']);

      const evidence = await reproduce(
        { title: 'Revisar la pantalla de parámetros', body: 'Sólo verificar que carga bien.' },
        baseConfig(),
        fn,
        {
          route: '#/app',
          credentials: { email: 'admin@x.test', password: 'secret' },
          stepDelayMs: 100,
        },
      );

      expect(evidence.reproduced).toBe(false);
      expect(evidence.consoleErrors).toEqual([]);
      expect(evidence.netFails).toEqual([]);
      expect(evidence.uiErrors).toEqual([]);
    },
    30_000,
  );
});
