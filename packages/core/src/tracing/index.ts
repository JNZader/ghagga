/**
 * Lightweight OTel-compatible tracing abstraction.
 *
 * Works WITHOUT requiring @opentelemetry packages (they are optional).
 * Defaults to a no-op implementation. Real OTel can be injected via
 * configureTracer() at application startup.
 */

// ─── Interfaces ─────────────────────────────────────────────────

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: Error): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

// ─── No-op Implementation ────────────────────────────────────────

class NoopSpan implements Span {
  setAttribute(_key: string, _value: string | number | boolean): void {
    // intentional no-op
  }

  recordException(_error: Error): void {
    // intentional no-op
  }

  end(): void {
    // intentional no-op
  }
}

class NoopTracer implements Tracer {
  startSpan(_name: string, _attributes?: Record<string, string | number | boolean>): Span {
    return new NoopSpan();
  }
}

// ─── Global Tracer State ─────────────────────────────────────────

let _tracer: Tracer = new NoopTracer();

/**
 * Replace the global tracer with a real OTel tracer (or any custom implementation).
 * Must be called before any pipeline operations to take effect.
 */
export function configureTracer(tracer: Tracer): void {
  _tracer = tracer;
}

/**
 * Get the currently active global tracer.
 * Returns NoopTracer by default when OTel is not configured.
 */
export function getTracer(): Tracer {
  return _tracer;
}

// ─── Convenience Wrapper ─────────────────────────────────────────

/**
 * Wrap an async function in a span.
 *
 * Creates a span, passes it to the callback so attributes can be set
 * mid-execution, then ends the span when the promise settles.
 * Exceptions are recorded on the span before being re-thrown.
 *
 * @param name       - Span name (e.g., "ghagga.review")
 * @param attributes - Initial span attributes set before the function runs
 * @param fn         - Async function to execute inside the span
 * @returns The resolved value of fn
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = _tracer.startSpan(name, attributes);
  try {
    const result = await fn(span);
    return result;
  } catch (error) {
    if (error instanceof Error) {
      span.recordException(error);
    }
    throw error;
  } finally {
    span.end();
  }
}
