/**
 * Tests for the Toast notification system.
 * Covers rendering, auto-dismiss timing, stacking, and type variants.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

// ─── Helper: component that triggers toasts ──────────────────────

function ToastTrigger({
  message,
  type = 'success',
  duration,
}: {
  message: string;
  type?: 'success' | 'error' | 'info';
  duration?: number;
}) {
  const { addToast } = useToast();
  return (
    <button type="button" onClick={() => addToast({ message, type, duration })}>
      Add Toast
    </button>
  );
}

function MultiTrigger() {
  const { addToast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        addToast({ message: 'First toast', type: 'success' });
        addToast({ message: 'Second toast', type: 'error' });
        addToast({ message: 'Third toast', type: 'info' });
      }}
    >
      Add Multiple
    </button>
  );
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════

describe('Toast', () => {
  it('renders a toast with the given message', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Observation deleted" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Toast').click();
    });

    expect(screen.getByText('Observation deleted')).toBeInTheDocument();
  });

  it('auto-dismisses after the default duration (4000ms)', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Gone soon" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Toast').click();
    });
    expect(screen.getByText('Gone soon')).toBeInTheDocument();

    // Advance just short of 4000ms — still visible
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByText('Gone soon')).toBeInTheDocument();

    // Advance past 4000ms — gone
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText('Gone soon')).not.toBeInTheDocument();
  });

  it('auto-dismisses after a custom duration', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Custom timeout" duration={2000} />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Toast').click();
    });
    expect(screen.getByText('Custom timeout')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2001);
    });
    expect(screen.queryByText('Custom timeout')).not.toBeInTheDocument();
  });

  it('stacks multiple toasts simultaneously', () => {
    render(
      <ToastProvider>
        <MultiTrigger />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Multiple').click();
    });

    expect(screen.getByText('First toast')).toBeInTheDocument();
    expect(screen.getByText('Second toast')).toBeInTheDocument();
    expect(screen.getByText('Third toast')).toBeInTheDocument();
  });

  it('dismisses toasts independently', () => {
    render(
      <ToastProvider>
        <MultiTrigger />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Multiple').click();
    });

    // All 3 have 4000ms default; after 4001ms they all should disappear
    act(() => {
      vi.advanceTimersByTime(4001);
    });

    expect(screen.queryByText('First toast')).not.toBeInTheDocument();
    expect(screen.queryByText('Second toast')).not.toBeInTheDocument();
    expect(screen.queryByText('Third toast')).not.toBeInTheDocument();
  });

  it('renders success variant with role="alert"', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Success!" type="success" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Toast').click();
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Success!');
  });

  it('renders error variant', () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Failed!" type="error" />
      </ToastProvider>,
    );

    act(() => {
      screen.getByText('Add Toast').click();
    });

    expect(screen.getByText('Failed!')).toBeInTheDocument();
  });
});
