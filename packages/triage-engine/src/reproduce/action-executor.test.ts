import { describe, expect, it, vi } from 'vitest';
import type { ExecutableLocator, ExecutablePage } from './action-executor.js';
import { buildActionLocator, executeAction } from './action-executor.js';

function mockLocator(): ExecutableLocator {
  const self: ExecutableLocator = {
    getByRole: vi.fn((_role: string, _opts?: { name?: string | RegExp }) => self),
    first: vi.fn(() => self),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };
  return self;
}

function mockPage() {
  const roleLocator = mockLocator();
  const page: ExecutablePage = {
    getByRole: vi.fn((_role: string, _opts?: { name?: string | RegExp }) => roleLocator),
  };
  return { page, roleLocator };
}

describe('buildActionLocator', () => {
  it('builds a plain role+name locator when no `near` is given', () => {
    const { page, roleLocator } = mockPage();
    const loc = buildActionLocator(page, { action: 'click', role: 'button', name: 'Guardar' });
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Guardar' });
    expect(roleLocator.first).toHaveBeenCalled();
    expect(loc).toBe(roleLocator);
  });

  it('defaults role to "button" when omitted', () => {
    const { page } = mockPage();
    buildActionLocator(page, { action: 'click', name: 'Guardar' });
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Guardar' });
  });

  it('defaults name to empty string when omitted (no `near`)', () => {
    const { page } = mockPage();
    buildActionLocator(page, { action: 'click', role: 'button' });
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: '' });
  });

  it('builds row-scoped `near` targeting for icon-only buttons without an accessible name', () => {
    const { page, roleLocator } = mockPage();
    buildActionLocator(page, { action: 'click', role: 'button', near: 'pH' });
    expect(page.getByRole).toHaveBeenCalledWith('row', { name: expect.any(RegExp) });
    const [, opts] = (page.getByRole as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.name.test('Fila pH')).toBe(true);
    expect(opts.name.test('Fila OD')).toBe(false);
    // chained getByRole(role) on the row locator, then .first()
    expect(roleLocator.getByRole).toHaveBeenCalledWith('button', undefined);
    expect(roleLocator.first).toHaveBeenCalled();
  });

  it('escapes regex-special characters in `near` before building the row pattern', () => {
    const { page } = mockPage();
    buildActionLocator(page, { action: 'click', role: 'button', near: 'pH (7.0)' });
    const [, opts] = (page.getByRole as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.name.test('Fila pH (7.0)')).toBe(true);
    expect(opts.name.test('Fila pH X7X0X')).toBe(false);
  });
});

describe('executeAction', () => {
  it('calls .fill() for a fill action', async () => {
    const { page, roleLocator } = mockPage();
    await executeAction(page, {
      action: 'fill',
      role: 'textbox',
      name: 'Nuevo valor',
      value: '99',
    });
    expect(roleLocator.fill).toHaveBeenCalledWith('99');
    expect(roleLocator.click).not.toHaveBeenCalled();
  });

  it('coerces a missing fill value to an empty string', async () => {
    const { page, roleLocator } = mockPage();
    await executeAction(page, { action: 'fill', role: 'textbox', name: 'x' });
    expect(roleLocator.fill).toHaveBeenCalledWith('');
  });

  it('calls .click() for a click action with a bounded timeout', async () => {
    const { page, roleLocator } = mockPage();
    await executeAction(page, { action: 'click', role: 'button', name: 'Guardar' });
    expect(roleLocator.click).toHaveBeenCalledWith({ timeout: 5000 });
    expect(roleLocator.fill).not.toHaveBeenCalled();
  });
});
