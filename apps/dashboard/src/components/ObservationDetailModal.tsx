import { type KeyboardEvent, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { cn } from '@/lib/cn';
import type { Observation } from '@/lib/types';
import { formatRelativeTime, isValidSeverity } from '@/lib/utils';
import { SeverityBadge } from './SeverityBadge';

// ─── Types ──────────────────────────────────────────────────────

const observationTypeConfig: Record<Observation['type'], { label: string; classes: string }> = {
  pattern: {
    label: 'Pattern',
    classes: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  },
  bugfix: {
    label: 'Bug Fix',
    classes: 'bg-red-500/15 text-red-400 border-red-500/25',
  },
  learning: {
    label: 'Learning',
    classes: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  },
  decision: {
    label: 'Decision',
    classes: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  },
  architecture: {
    label: 'Architecture',
    classes: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
  },
  config: {
    label: 'Config',
    classes: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  },
  discovery: {
    label: 'Discovery',
    classes: 'bg-green-500/15 text-green-400 border-green-500/25',
  },
};

export interface ObservationDetailModalProps {
  observation: Observation | null;
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────────────

export function ObservationDetailModal({ observation, onClose }: ObservationDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Trap focus within the dialog while open
  useFocusTrap(dialogRef, observation !== null);

  // `HTMLElement` covers both the dialog `<div>` and the backdrop `<button>` —
  // both attach this handler.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!observation) return null;

  const typeConfig = observationTypeConfig[observation.type];

  return createPortal(
    // Outer wrapper handles backdrop positioning + Escape key delegation.
    // It is NOT the dialog itself — the inner div carries role="dialog".
    // `role="presentation"` keeps the wrapper out of the a11y tree so screen
    // readers only announce a single dialog (fixes dual-role ARIA violation).
    // onKeyDown here catches Escape bubbling from ANY focused child (dialog,
    // backdrop) regardless of which element holds focus — moving it to a single
    // interactive child would miss Escape from siblings. The interactive
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
        data-testid="detail-backdrop"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="observation-detail-title"
        tabIndex={-1}
        className="relative z-10 w-full max-w-2xl rounded-lg border border-surface-border bg-surface-card shadow-xl focus:outline-hidden"
      >
        {/* Scrollable body */}
        <div className="max-h-[80vh] overflow-y-auto p-6">
          {/* Header: title + badges */}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 id="observation-detail-title" className="text-lg font-semibold text-text-primary">
                {observation.title}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    typeConfig.classes,
                  )}
                >
                  {typeConfig.label}
                </span>
                {isValidSeverity(observation.severity) && (
                  <SeverityBadge severity={observation.severity} />
                )}
                {observation.revisionCount > 1 && (
                  <span className="inline-flex items-center rounded-full border border-surface-border bg-surface-bg px-2 py-0.5 text-xs text-text-muted">
                    {observation.revisionCount} revisions
                  </span>
                )}
              </div>
            </div>

            {/* Close button */}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
              aria-label="Close"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <title>Close icon</title>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="mt-4">
            <p className="whitespace-pre-wrap font-mono text-sm text-text-secondary">
              {observation.content}
            </p>
          </div>

          {/* File paths */}
          {observation.filePaths.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                Files
              </h3>
              <div className="flex flex-wrap gap-2">
                {observation.filePaths.map((path: string) => (
                  <span
                    key={path}
                    className="rounded-sm bg-surface-bg px-2 py-1 font-mono text-xs text-text-secondary"
                  >
                    {path}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Topic key */}
          {observation.topicKey && (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">
                Topic Key
              </h3>
              <p className="font-mono text-sm text-text-secondary">{observation.topicKey}</p>
            </div>
          )}

          {/* Timestamps */}
          <div className="mt-4 flex items-center gap-4 border-t border-surface-border pt-4 text-xs text-text-muted">
            <span title={new Date(observation.createdAt).toLocaleString()}>
              Created {formatRelativeTime(observation.createdAt)}
            </span>
            {observation.updatedAt !== observation.createdAt && (
              <span title={new Date(observation.updatedAt).toLocaleString()}>
                Updated {formatRelativeTime(observation.updatedAt)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
