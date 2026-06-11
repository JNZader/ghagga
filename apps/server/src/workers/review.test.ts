/**
 * Worker entry-point tests — verify the BullMQ event handlers never log the
 * raw error object (BullMQ jobs carry encryptedApiKey in their payload, and
 * pino would serialize whatever is attached to the error).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockLogger };
});

vi.mock('../lib/logger.js', () => ({ logger: mockLogger }));

// Capture the event handlers registered on the worker
const handlers: Record<string, (...args: unknown[]) => void> = {};

vi.mock('../queues/review.js', () => ({
  createReviewWorker: vi.fn(() => ({
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    },
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('review worker event handlers', () => {
  let stdinResumeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The entry point calls process.stdin.resume() to stay alive — stub it.
    stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    await import('./review.js');
  });

  afterEach(() => {
    stdinResumeSpy.mockRestore();
  });

  it('registers completed/failed/progress handlers', () => {
    expect(handlers.completed).toBeDefined();
    expect(handlers.failed).toBeDefined();
    expect(handlers.progress).toBeDefined();
  });

  it('failed handler logs only the error MESSAGE, never the error object', () => {
    const err = new Error('pipeline exploded');
    // Simulate BullMQ attaching the job (with sensitive payload) to the error
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    (err as any).jobData = { encryptedApiKey: 'v2:super:secret:value' };

    handlers.failed?.({ id: 'job-9' }, err);

    expect(mockLogger.error).toHaveBeenCalledOnce();
    const [payload, message] = mockLogger.error.mock.calls[0]!;
    expect(payload).toEqual({ jobId: 'job-9', error: 'pipeline exploded' });
    expect(typeof payload.error).toBe('string');
    expect(JSON.stringify(payload)).not.toContain('super:secret');
    expect(message).toContain('job-9');
  });

  it('failed handler stringifies non-Error rejections', () => {
    handlers.failed?.({ id: 'job-10' }, 'plain string failure');

    const [payload] = mockLogger.error.mock.calls[0]!;
    expect(payload).toEqual({ jobId: 'job-10', error: 'plain string failure' });
  });
});
