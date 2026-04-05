import { describe, expect, it, vi } from 'vitest';
import { configureTracer, getTracer, type Span, type Tracer, withSpan } from './index.js';

describe('NoopTracer', () => {
  it('getTracer returns a tracer by default', () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
  });

  it('NoopTracer.startSpan returns a span without throwing', () => {
    const tracer = getTracer();
    const span = tracer.startSpan('test.span', { key: 'value' });
    expect(span).toBeDefined();
  });

  it('NoopSpan methods do not throw', () => {
    const tracer = getTracer();
    const span = tracer.startSpan('test.noop');
    expect(() => span.setAttribute('k', 'v')).not.toThrow();
    expect(() => span.setAttribute('n', 42)).not.toThrow();
    expect(() => span.setAttribute('b', true)).not.toThrow();
    expect(() => span.recordException(new Error('oops'))).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });

  it('startSpan works with no attributes', () => {
    const tracer = getTracer();
    const span = tracer.startSpan('test.no-attrs');
    expect(span).toBeDefined();
    expect(() => span.end()).not.toThrow();
  });
});

describe('configureTracer', () => {
  it('replaces the global tracer', () => {
    const mockSpan: Span = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer: Tracer = {
      startSpan: vi.fn(() => mockSpan),
    };

    configureTracer(mockTracer);
    const tracer = getTracer();
    expect(tracer).toBe(mockTracer);

    // Restore noop tracer for subsequent tests
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });

  it('new tracer is used by withSpan after configureTracer', async () => {
    const endMock = vi.fn();
    const setAttrMock = vi.fn();
    const mockSpan: Span = {
      setAttribute: setAttrMock,
      recordException: vi.fn(),
      end: endMock,
    };
    const startSpanMock = vi.fn(() => mockSpan);
    const mockTracer: Tracer = { startSpan: startSpanMock };

    configureTracer(mockTracer);

    await withSpan('test.configured', { env: 'test' }, async () => 'ok');

    expect(startSpanMock).toHaveBeenCalledWith('test.configured', { env: 'test' });
    expect(endMock).toHaveBeenCalled();

    // Restore noop
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });
});

describe('withSpan', () => {
  it('returns the value from the wrapped function', async () => {
    const result = await withSpan('test.value', {}, async () => 42);
    expect(result).toBe(42);
  });

  it('ends the span even when function resolves', async () => {
    const endMock = vi.fn();
    const mockSpan: Span = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      end: endMock,
    };
    configureTracer({ startSpan: () => mockSpan });

    await withSpan('test.end', {}, async () => 'done');
    expect(endMock).toHaveBeenCalledOnce();

    // Restore noop
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });

  it('records exception and re-throws on error', async () => {
    const recordMock = vi.fn();
    const endMock = vi.fn();
    const mockSpan: Span = {
      setAttribute: vi.fn(),
      recordException: recordMock,
      end: endMock,
    };
    configureTracer({ startSpan: () => mockSpan });

    const err = new Error('boom');
    await expect(
      withSpan('test.error', {}, async () => {
        throw err;
      }),
    ).rejects.toThrow('boom');

    expect(recordMock).toHaveBeenCalledWith(err);
    expect(endMock).toHaveBeenCalled();

    // Restore noop
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });

  it('span can receive attributes mid-execution via fn parameter', async () => {
    const setAttrMock = vi.fn();
    const mockSpan: Span = {
      setAttribute: setAttrMock,
      recordException: vi.fn(),
      end: vi.fn(),
    };
    configureTracer({ startSpan: () => mockSpan });

    await withSpan('test.mid-attrs', {}, async (span) => {
      span.setAttribute('mid', 'execution');
    });

    expect(setAttrMock).toHaveBeenCalledWith('mid', 'execution');

    // Restore noop
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });

  it('non-Error throws do not call recordException', async () => {
    const recordMock = vi.fn();
    const endMock = vi.fn();
    const mockSpan: Span = {
      setAttribute: vi.fn(),
      recordException: recordMock,
      end: endMock,
    };
    configureTracer({ startSpan: () => mockSpan });

    await expect(
      withSpan('test.non-error', {}, async () => {
        throw 'a string';
      }),
    ).rejects.toBe('a string');

    expect(recordMock).not.toHaveBeenCalled();
    expect(endMock).toHaveBeenCalled();

    // Restore noop
    configureTracer({
      startSpan: () => ({
        setAttribute: () => {},
        recordException: () => {},
        end: () => {},
      }),
    });
  });
});
