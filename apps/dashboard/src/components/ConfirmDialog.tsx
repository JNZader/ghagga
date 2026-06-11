import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { cn } from '@/lib/cn';

// ─── Types ──────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: 'danger';
  isLoading?: boolean;
  error?: string | null;

  /** Tier 2+: User must type this text to enable confirm */
  confirmText?: string;
  /** Placeholder for the text input (Tier 2+) */
  confirmPlaceholder?: string;

  /** Tier 3: Countdown in seconds before confirm becomes available */
  countdownSeconds?: number;

  /** Optional extra content rendered between description and the confirm input */
  children?: React.ReactNode;
}

// ─── Component ──────────────────────────────────────────────────

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel,
  confirmVariant,
  isLoading = false,
  error = null,
  confirmText,
  confirmPlaceholder,
  countdownSeconds,
  children,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState(countdownSeconds ?? 0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Reset state when dialog opens ─────────────────────────────
  useEffect(() => {
    if (open) {
      setInputValue('');
      setSecondsRemaining(countdownSeconds ?? 0);
    }
  }, [open, countdownSeconds]);

  // ── Focus trap: trap focus within the dialog while open ────────
  useFocusTrap(dialogRef, open);

  // ── Countdown timer (Tier 3) ──────────────────────────────────
  useEffect(() => {
    if (!open || !countdownSeconds || secondsRemaining <= 0) return;

    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [open, countdownSeconds, secondsRemaining]);

  // ── Escape key handling ───────────────────────────────────────
  // `HTMLElement` covers both the dialog `<div>` and the backdrop `<button>` —
  // both attach this handler.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape' && !isLoading) {
        onCancel();
      }
    },
    [onCancel, isLoading],
  );

  // ── Backdrop click ────────────────────────────────────────────
  const handleBackdropClick = useCallback(() => {
    if (!isLoading) onCancel();
  }, [onCancel, isLoading]);

  if (!open) return null;

  // ── Determine if confirm button is enabled ────────────────────
  const textMatches = confirmText ? inputValue === confirmText : true;
  const countdownDone = countdownSeconds ? secondsRemaining === 0 : true;
  const canConfirm = textMatches && countdownDone && !isLoading;

  // ── Confirm button label (with countdown) ─────────────────────
  let buttonLabel = confirmLabel;
  if (countdownSeconds && secondsRemaining > 0) {
    buttonLabel = `${confirmLabel} (${secondsRemaining}s)`;
  }

  return createPortal(
    // Outer wrapper handles backdrop positioning + Escape key delegation.
    // It is NOT the dialog itself — the inner div carries role="dialog".
    // `role="presentation"` keeps the wrapper out of the a11y tree so screen
    // readers only announce a single dialog (fixes dual-role ARIA violation).
    // onKeyDown here catches Escape bubbling from ANY focused child (dialog,
    // inputs, backdrop) regardless of which element holds focus — moving it to a
    // single interactive child would miss Escape from siblings. The interactive
    // affordances (close button, dialog) are real elements with proper roles, so
    // this presentation wrapper is intentionally non-interactive to the a11y tree.
    // biome-ignore lint/a11y/noStaticElementInteractions: presentation wrapper does Escape delegation only, see above
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop — acts as a dismiss button for keyboard/mouse */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/60"
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        data-testid="confirm-backdrop"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        tabIndex={-1}
        className="relative z-10 w-full max-w-md rounded-lg border border-surface-border bg-surface-card p-6 shadow-xl focus:outline-hidden"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-text-primary">
          {title}
        </h2>

        <p className="mt-2 text-sm text-text-secondary">{description}</p>

        {/* Optional extra content (e.g. checkboxes) */}
        {children}

        {/* Error message */}
        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Text confirmation input (Tier 2 & 3) */}
        {confirmText && (
          <div className="mt-4">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={confirmPlaceholder ?? `Type "${confirmText}" to confirm`}
              className="input-field w-full"
              aria-label="Confirmation text"
              disabled={isLoading}
            />
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={cn(
              'rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              confirmVariant === 'danger'
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary-600 text-white hover:bg-primary-700',
            )}
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                {confirmLabel}
              </span>
            ) : (
              buttonLabel
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
