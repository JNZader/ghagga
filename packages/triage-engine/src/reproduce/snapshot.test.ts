import { describe, expect, it, vi } from 'vitest';
import type { SnapshotLocator, SnapshotPage } from './snapshot.js';
import { captureScopedSnapshot } from './snapshot.js';

function mockLocator(overrides: Partial<SnapshotLocator> = {}): SnapshotLocator {
  const self: SnapshotLocator = {
    count: vi.fn(async () => 0),
    first: vi.fn(() => self),
    ariaSnapshot: vi.fn(async () => ''),
    ...overrides,
  };
  return self;
}

describe('captureScopedSnapshot', () => {
  it('prefers the open dialog when one is present (Mantine-style modals portal outside <main>)', async () => {
    const dialogLocator = mockLocator({
      count: vi.fn(async () => 1),
      ariaSnapshot: vi.fn(async () => 'dialog: Editar pH'),
    });
    const mainLocator = mockLocator({ ariaSnapshot: vi.fn(async () => 'main: table') });
    const page: SnapshotPage = {
      getByRole: vi.fn((role: string) => (role === 'dialog' ? dialogLocator : mainLocator)),
      locator: vi.fn(() => mockLocator()),
    };
    const snap = await captureScopedSnapshot(page);
    expect(snap).toContain('DIÁLOGO ABIERTO');
    expect(snap).toContain('dialog: Editar pH');
    expect(mainLocator.ariaSnapshot).not.toHaveBeenCalled();
  });

  it('falls back to <main> when no dialog is open', async () => {
    const dialogLocator = mockLocator({ count: vi.fn(async () => 0) });
    const mainLocator = mockLocator({ ariaSnapshot: vi.fn(async () => 'main content') });
    const page: SnapshotPage = {
      getByRole: vi.fn((role: string) => (role === 'dialog' ? dialogLocator : mainLocator)),
      locator: vi.fn(() => mockLocator()),
    };
    const snap = await captureScopedSnapshot(page);
    expect(snap).toBe('main content');
  });

  it('falls back to body when getByRole(main) throws (no <main> landmark)', async () => {
    const dialogLocator = mockLocator({ count: vi.fn(async () => 0) });
    const bodyLocator = mockLocator({ ariaSnapshot: vi.fn(async () => 'body content') });
    const page: SnapshotPage = {
      getByRole: vi.fn((role: string) => {
        if (role === 'dialog') return dialogLocator;
        throw new Error('no main landmark');
      }),
      locator: vi.fn(() => bodyLocator),
    };
    const snap = await captureScopedSnapshot(page);
    expect(page.locator).toHaveBeenCalledWith('body');
    expect(snap).toBe('body content');
  });

  it('truncates the snapshot to maxLength', async () => {
    const long = 'x'.repeat(5000);
    const dialogLocator = mockLocator({ count: vi.fn(async () => 0) });
    const mainLocator = mockLocator({ ariaSnapshot: vi.fn(async () => long) });
    const page: SnapshotPage = {
      getByRole: vi.fn((role: string) => (role === 'dialog' ? dialogLocator : mainLocator)),
      locator: vi.fn(() => mockLocator()),
    };
    const snap = await captureScopedSnapshot(page, 100);
    expect(snap).toHaveLength(100);
  });
});
