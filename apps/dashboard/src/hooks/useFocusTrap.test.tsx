/**
 * Tests for useFocusTrap hook.
 * Verifies focus trapping behavior in ObservationDetailModal and ConfirmDialog.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ObservationDetailModal } from '@/components/ObservationDetailModal';
import type { Observation } from '@/lib/types';

// ─── Fixtures ───────────────────────────────────────────────────

const sampleObservation: Observation = {
  id: 1,
  sessionId: 1,
  type: 'pattern',
  title: 'Focus trap test',
  content: 'Testing focus trap behavior.',
  filePaths: ['src/test.ts'],
  severity: 'high',
  topicKey: null,
  revisionCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ═══════════════════════════════════════════════════════════════════
// ObservationDetailModal focus trap
// ═══════════════════════════════════════════════════════════════════

describe('Focus trap — ObservationDetailModal', () => {
  it('wraps focus from last to first focusable element on Tab', async () => {
    const user = userEvent.setup();
    render(<ObservationDetailModal observation={sampleObservation} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog');

    // The only focusable element inside the dialog is the Close button
    const closeButton = screen.getByLabelText('Close');

    // Focus the close button (the only interactive element)
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    // Tab from the last element should wrap to the first
    await user.tab();
    // Since there's only one focusable element, focus should stay on it
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('wraps focus from first to last focusable element on Shift+Tab', async () => {
    const user = userEvent.setup();
    render(<ObservationDetailModal observation={sampleObservation} onClose={() => {}} />);

    const dialog = screen.getByRole('dialog');
    const closeButton = screen.getByLabelText('Close');

    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab from the first element should wrap to the last
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('does not trap focus when modal is closed', () => {
    render(<ObservationDetailModal observation={null} onClose={() => {}} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// ConfirmDialog focus trap
// ═══════════════════════════════════════════════════════════════════

describe('Focus trap — ConfirmDialog', () => {
  it('traps focus within the dialog on Tab cycling', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
        title="Test dialog"
        description="Test description"
        confirmLabel="Confirm"
      />,
    );

    const dialog = screen.getByRole('dialog');
    const cancelButton = screen.getByText('Cancel');
    const confirmButton = screen.getByText('Confirm');

    // Focus cancel (first button)
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    // Tab to confirm
    await user.tab();
    expect(document.activeElement).toBe(confirmButton);

    // Tab from last element should wrap back inside the dialog
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('traps focus within Tier 2 dialog with text input', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
        title="Clear memory"
        description="Are you sure?"
        confirmLabel="Clear"
        confirmText="confirm"
        confirmPlaceholder='Type "confirm"'
      />,
    );

    const dialog = screen.getByRole('dialog');
    const input = screen.getByLabelText('Confirmation text');
    const cancelButton = screen.getByText('Cancel');

    // The input, cancel, and confirm buttons are all focusable
    // Tab through all of them — focus should stay in the dialog
    input.focus();
    expect(document.activeElement).toBe(input);

    await user.tab(); // -> Cancel
    expect(document.activeElement).toBe(cancelButton);

    await user.tab(); // -> Confirm (Clear)
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.tab(); // -> should wrap to input
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('does not trap focus when dialog is closed', () => {
    render(
      <ConfirmDialog
        open={false}
        onConfirm={() => {}}
        onCancel={() => {}}
        title="Test"
        description="Test"
        confirmLabel="OK"
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
