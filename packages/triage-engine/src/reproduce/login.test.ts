import { describe, expect, it, vi } from 'vitest';
import type { LoginPage } from './login.js';
import { runLoginRecipe } from './login.js';

function mockLoginPage() {
  const calls: string[] = [];
  const locator = () => ({
    fill: vi.fn(async (value: string) => {
      calls.push(`fill:${value}`);
    }),
    click: vi.fn(async () => {
      calls.push('click');
    }),
  });
  const page: LoginPage = {
    goto: vi.fn(async (url: string) => {
      calls.push(`goto:${url}`);
    }),
    getByLabel: vi.fn((label: string) => {
      calls.push(`getByLabel:${label}`);
      return locator();
    }),
    getByRole: vi.fn((role: string, opts?: { name?: string }) => {
      calls.push(`getByRole:${role}:${opts?.name ?? ''}`);
      return locator();
    }),
    waitForURL: vi.fn(async () => {
      calls.push('waitForURL');
    }),
  };
  return { page, calls };
}

describe('runLoginRecipe', () => {
  it('kind: none — returns loggedIn:false without touching the page', async () => {
    const { page, calls } = mockLoginPage();
    const result = await runLoginRecipe(page, { kind: 'none' }, { baseURL: 'https://x.test' });
    expect(result.loggedIn).toBe(false);
    expect(calls).toEqual([]);
  });

  it('kind: storageState — returns loggedIn:true as a no-op (context already authenticated)', async () => {
    const { page, calls } = mockLoginPage();
    const result = await runLoginRecipe(
      page,
      { kind: 'storageState', path: './auth.storageState.json' },
      { baseURL: 'https://x.test' },
    );
    expect(result.loggedIn).toBe(true);
    expect(result.note).toContain('auth.storageState.json');
    expect(calls).toEqual([]);
  });

  it('kind: steps — runs goto/fill/click in order, resolving {{email}}/{{password}} placeholders', async () => {
    const { page, calls } = mockLoginPage();
    const result = await runLoginRecipe(
      page,
      {
        kind: 'steps',
        steps: [
          { action: 'goto', url: 'https://x.test/login' },
          { action: 'fill', label: 'Email', value: '{{email}}' },
          { action: 'fill', label: 'Contraseña', value: '{{password}}' },
          { action: 'click', role: 'button', name: 'Iniciar sesión' },
        ],
      },
      { baseURL: 'https://x.test', credentials: { email: 'a@b.com', password: 'secret' } },
    );
    expect(result.loggedIn).toBe(true);
    expect(calls).toEqual([
      'goto:https://x.test/login',
      'getByLabel:Email',
      'fill:a@b.com',
      'getByLabel:Contraseña',
      'fill:secret',
      'getByRole:button:Iniciar sesión',
      'click',
    ]);
  });

  it('kind: steps — a fill step without a label falls back to role+name targeting', async () => {
    const { page, calls } = mockLoginPage();
    await runLoginRecipe(
      page,
      {
        kind: 'steps',
        steps: [{ action: 'fill', role: 'textbox', name: 'Email', value: 'literal' }],
      },
      { baseURL: 'https://x.test' },
    );
    expect(calls).toEqual(['getByRole:textbox:Email', 'fill:literal']);
  });

  it('kind: steps — goto with no url falls back to ctx.baseURL', async () => {
    const { page, calls } = mockLoginPage();
    await runLoginRecipe(
      page,
      { kind: 'steps', steps: [{ action: 'goto' }] },
      { baseURL: 'https://x.test' },
    );
    expect(calls).toEqual(['goto:https://x.test']);
  });

  it('kind: steps — returns loggedIn:false with a note when a step throws', async () => {
    const { page } = mockLoginPage();
    (page.getByLabel as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: vi.fn().mockRejectedValue(new Error('element not found')),
      click: vi.fn(),
    }));
    const result = await runLoginRecipe(
      page,
      { kind: 'steps', steps: [{ action: 'fill', label: 'Email', value: 'a@b.com' }] },
      { baseURL: 'https://x.test' },
    );
    expect(result.loggedIn).toBe(false);
    expect(result.note).toContain('element not found');
  });
});
