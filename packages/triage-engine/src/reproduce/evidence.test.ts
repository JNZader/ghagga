import { describe, expect, it, vi } from 'vitest';
import type { EvidenceCapablePage } from './evidence.js';
import { attachEvidenceListeners, captureUIErrors } from './evidence.js';

function mockPage(overrides: Partial<EvidenceCapablePage> = {}): {
  page: EvidenceCapablePage;
  handlers: Record<string, (...args: unknown[]) => void>;
} {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const page: EvidenceCapablePage = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    evaluate: vi.fn(async () => []),
    screenshot: vi.fn(async () => Buffer.from('')),
    ...overrides,
  };
  return { page, handlers };
}

describe('attachEvidenceListeners', () => {
  it('captures console.error messages, truncated to 300 chars', () => {
    const { page, handlers } = mockPage();
    const { consoleErrors } = attachEvidenceListeners(page);
    handlers.console({ type: () => 'error', text: () => 'boom' });
    expect(consoleErrors).toEqual(['boom']);
  });

  it('ignores non-error console messages', () => {
    const { page, handlers } = mockPage();
    const { consoleErrors } = attachEvidenceListeners(page);
    handlers.console({ type: () => 'log', text: () => 'just info' });
    expect(consoleErrors).toEqual([]);
  });

  it('folds pageerror exceptions into consoleErrors', () => {
    const { page, handlers } = mockPage();
    const { consoleErrors } = attachEvidenceListeners(page);
    handlers.pageerror({ message: 'Uncaught TypeError: x is not a function' });
    expect(consoleErrors).toEqual(['Uncaught TypeError: x is not a function']);
  });

  it('captures 4xx/5xx network responses with url/status/method/body', async () => {
    const { page, handlers } = mockPage();
    const { netFails } = attachEvidenceListeners(page);
    handlers.response({
      status: () => 422,
      url: () => 'https://x.test/api/params',
      request: () => ({ method: () => 'POST' }),
      text: async () => '{"error":"out of range"}',
    });
    await vi.waitFor(() => expect(netFails).toHaveLength(1));
    expect(netFails[0]).toEqual({
      url: 'https://x.test/api/params',
      status: 422,
      method: 'POST',
      body: '{"error":"out of range"}',
    });
  });

  it('ignores 2xx/3xx responses', async () => {
    const { page, handlers } = mockPage();
    const { netFails } = attachEvidenceListeners(page);
    handlers.response({
      status: () => 200,
      url: () => 'https://x.test/ok',
      request: () => ({ method: () => 'GET' }),
      text: async () => '',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(netFails).toEqual([]);
  });

  it('records an empty body when reading the response body throws (opaque response)', async () => {
    const { page, handlers } = mockPage();
    const { netFails } = attachEvidenceListeners(page);
    handlers.response({
      status: () => 500,
      url: () => 'https://x.test/opaque',
      request: () => ({ method: () => 'GET' }),
      text: async () => {
        throw new Error('body already consumed');
      },
    });
    await vi.waitFor(() => expect(netFails).toHaveLength(1));
    expect(netFails[0]?.body).toBe('');
  });
});

describe('captureUIErrors', () => {
  it('returns the deduplicated UI-visible error texts from evaluate()', async () => {
    const { page } = mockPage({ evaluate: vi.fn(async () => ['Error A', 'Error A', 'Error B']) });
    const errors = await captureUIErrors(page);
    expect(errors).toEqual(['Error A', 'Error B']);
  });

  it('returns an empty array when evaluate() throws', async () => {
    const { page } = mockPage({
      evaluate: vi.fn(async () => {
        throw new Error('detached frame');
      }),
    });
    const errors = await captureUIErrors(page);
    expect(errors).toEqual([]);
  });
});
