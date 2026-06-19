/**
 * Tests for ConfirmDialog — all 3 tiers.
 * Tier 1: simple confirm/cancel
 * Tier 2: text match required
 * Tier 3: text match + countdown timer
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

// ─── Helpers ────────────────────────────────────────────────────

const defaults = {
  open: true,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  title: 'Delete observation',
  description: 'Are you sure you want to delete this observation?',
  confirmLabel: 'Delete',
  confirmVariant: 'danger' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// Tier 1: Simple confirm
// ═══════════════════════════════════════════════════════════════════

describe('ConfirmDialog — Tier 1 (simple)', () => {
  it('renders title and description when open', () => {
    render(<ConfirmDialog {...defaults} />);

    expect(screen.getByText('Delete observation')).toBeInTheDocument();
    expect(
      screen.getByText('Are you sure you want to delete this observation?'),
    ).toBeInTheDocument();
  });

  it('does not render when open is false', () => {
    render(<ConfirmDialog {...defaults} open={false} />);

    expect(screen.queryByText('Delete observation')).not.toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', () => {
    render(<ConfirmDialog {...defaults} />);

    fireEvent.click(screen.getByText('Delete'));
    expect(defaults.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(<ConfirmDialog {...defaults} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(defaults.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    render(<ConfirmDialog {...defaults} />);

    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, {
      key: 'Escape',
    });
    expect(defaults.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows loading state and disables confirm button', () => {
    render(<ConfirmDialog {...defaults} isLoading />);

    const confirmBtn = screen.getByText('Delete').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('displays error message when error prop is set', () => {
    render(<ConfirmDialog {...defaults} error="Network error" />);

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('does not call onCancel on Escape when isLoading', () => {
    render(<ConfirmDialog {...defaults} isLoading />);

    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, {
      key: 'Escape',
    });
    // Should NOT close
    expect(defaults.onCancel).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 2: Text match
// ═══════════════════════════════════════════════════════════════════

describe('ConfirmDialog — Tier 2 (text match)', () => {
  const tier2Props = {
    ...defaults,
    title: 'Clear all memory for acme/widgets',
    confirmLabel: 'Clear Memory',
    confirmText: 'acme/widgets',
    confirmPlaceholder: 'Type "acme/widgets" to confirm',
  };

  it('renders a text input with the correct placeholder', () => {
    render(<ConfirmDialog {...tier2Props} />);

    const input = screen.getByLabelText('Confirmation text');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Type "acme/widgets" to confirm');
  });

  it('confirm button is disabled when text is empty', () => {
    render(<ConfirmDialog {...tier2Props} />);

    const confirmBtn = screen.getByText('Clear Memory').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is disabled when text partially matches', () => {
    render(<ConfirmDialog {...tier2Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widget' },
    });

    const confirmBtn = screen.getByText('Clear Memory').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is disabled when text has wrong case', () => {
    render(<ConfirmDialog {...tier2Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'ACME/WIDGETS' },
    });

    const confirmBtn = screen.getByText('Clear Memory').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('confirm button is enabled when text matches exactly', () => {
    render(<ConfirmDialog {...tier2Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });

    const confirmBtn = screen.getByText('Clear Memory').closest('button')!;
    expect(confirmBtn).not.toBeDisabled();
  });

  it('fires onConfirm when text matches and button is clicked', () => {
    render(<ConfirmDialog {...tier2Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });

    fireEvent.click(screen.getByText('Clear Memory'));
    expect(tier2Props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('resets input value when dialog is re-opened', () => {
    const { rerender } = render(<ConfirmDialog {...tier2Props} />);

    // Type something
    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });

    // Close
    rerender(<ConfirmDialog {...tier2Props} open={false} />);

    // Re-open
    rerender(<ConfirmDialog {...tier2Props} open={true} />);

    const input = screen.getByLabelText('Confirmation text') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 3: Text match + Countdown
// ═══════════════════════════════════════════════════════════════════

describe('ConfirmDialog — Tier 3 (text match + countdown)', () => {
  const tier3Props = {
    ...defaults,
    title: 'Purge all memory',
    confirmLabel: 'Purge All',
    confirmText: 'DELETE ALL',
    confirmPlaceholder: 'Type "DELETE ALL" to confirm',
    countdownSeconds: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows countdown on confirm button when opened', () => {
    render(<ConfirmDialog {...tier3Props} />);

    expect(screen.getByText('Purge All (5s)')).toBeInTheDocument();
  });

  it('counts down each second', () => {
    render(<ConfirmDialog {...tier3Props} />);

    expect(screen.getByText('Purge All (5s)')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Purge All (4s)')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Purge All (3s)')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Purge All (2s)')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Purge All (1s)')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Purge All')).toBeInTheDocument();
  });

  it('button stays disabled even with correct text while countdown is active', () => {
    render(<ConfirmDialog {...tier3Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    // 2s elapsed, 3s remaining
    act(() => vi.advanceTimersByTime(2000));

    const confirmBtn = screen.getByText('Purge All (3s)').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('button stays disabled after countdown if text does not match', () => {
    render(<ConfirmDialog {...tier3Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'delete all' },
    });

    // Wait full countdown
    act(() => vi.advanceTimersByTime(5000));

    const confirmBtn = screen.getByText('Purge All').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('button becomes enabled when both text matches AND countdown is done', () => {
    render(<ConfirmDialog {...tier3Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    act(() => vi.advanceTimersByTime(5000));

    const confirmBtn = screen.getByText('Purge All').closest('button')!;
    expect(confirmBtn).not.toBeDisabled();
  });

  it('calls onConfirm when both conditions met and button clicked', () => {
    render(<ConfirmDialog {...tier3Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    act(() => vi.advanceTimersByTime(5000));

    fireEvent.click(screen.getByText('Purge All'));
    expect(tier3Props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('resets countdown when dialog is closed and re-opened', () => {
    const { rerender } = render(<ConfirmDialog {...tier3Props} />);

    // Let 3 seconds pass
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Purge All (2s)')).toBeInTheDocument();

    // Close
    rerender(<ConfirmDialog {...tier3Props} open={false} />);

    // Re-open
    rerender(<ConfirmDialog {...tier3Props} open={true} />);

    expect(screen.getByText('Purge All (5s)')).toBeInTheDocument();
  });

  it('resets text input when dialog is closed and re-opened', () => {
    const { rerender } = render(<ConfirmDialog {...tier3Props} />);

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    // Close
    rerender(<ConfirmDialog {...tier3Props} open={false} />);

    // Re-open
    rerender(<ConfirmDialog {...tier3Props} open={true} />);

    const input = screen.getByLabelText('Confirmation text') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});
