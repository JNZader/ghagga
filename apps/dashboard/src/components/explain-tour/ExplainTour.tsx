import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeExplainTourPopover } from '@/components/explain-tour/placement';
import { type ExplainTourStep, PR_EXPLANATIONS_DOCS_HREF } from '@/components/explain-tour/steps';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Save, the replay control, and the dismissible note stay in the tab cycle.
 * The dimmer does not capture clicks, so those actions keep working while the
 * tour is open. aria-modal stays off because those controls live outside the
 * dialog.
 */
const TOUR_CHROME_SELECTOR =
  '[data-critical-save="true"]:not([disabled]), [data-explain-tour-chrome] button:not([disabled]), [data-explain-tour-chrome] a[href]';

export function ExplainTourReplayButton({
  visible,
  onReplay,
}: {
  visible: boolean;
  onReplay: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      className="btn-secondary text-sm"
      onClick={onReplay}
      data-explain-tour-chrome="replay"
    >
      Replay tour
    </button>
  );
}

export function ExplainTourBanner({
  visible,
  tourOpen,
  onStart,
  onDismiss,
}: {
  visible: boolean;
  tourOpen: boolean;
  onStart: () => void;
  onDismiss: () => void;
}) {
  if (!visible) return null;
  return (
    <section
      aria-label="PR explanations tour"
      data-explain-tour-chrome="banner"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary-600/30 bg-primary-600/10 p-4"
    >
      <p className="text-sm text-primary-300">
        <strong className="text-primary-200">/ghagga explain</strong> answers one question on a
        GitHub pull request. It does not post review findings, approve, or request changes.
      </p>
      <div className="flex gap-2">
        {!tourOpen && (
          <button type="button" className="btn-primary text-sm" onClick={onStart}>
            Start tour
          </button>
        )}
        <button type="button" className="btn-secondary text-sm" onClick={onDismiss}>
          Dismiss note
        </button>
      </div>
    </section>
  );
}

export function ExplainTour({
  open,
  steps,
  onDismiss,
}: {
  open: boolean;
  steps: ExplainTourStep[];
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [targetFound, setTargetFound] = useState(false);
  const [spotlight, setSpotlight] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({
    top: 12,
    left: 12,
  });

  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) setIndex(0);
    wasOpen.current = open;
  }, [open]);

  const step = steps[Math.min(index, steps.length - 1)];
  const stepAnchor = step?.anchor;

  useLayoutEffect(() => {
    if (!open || !stepAnchor) return;

    const anchor = findAnchor(stepAnchor);
    if (anchor) {
      try {
        anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        // jsdom may not implement scrolling.
      }
    }

    const measure = () => {
      const currentAnchor = findAnchor(stepAnchor);
      const dialog = dialogRef.current;
      const anchorRect = readBox(currentAnchor);
      const dialogRect = readBox(dialog);
      const save = document.querySelector<HTMLElement>('[data-critical-save="true"]');
      const saveRect = readBox(save);

      setTargetFound(Boolean(currentAnchor));

      if (anchorRect) {
        const pad = 8;
        const nextSpotlight = {
          top: anchorRect.top - pad,
          left: anchorRect.left - pad,
          width: anchorRect.width + pad * 2,
          height: anchorRect.height + pad * 2,
        };
        setSpotlight((current) => (sameBox(current, nextSpotlight) ? current : nextSpotlight));
      } else {
        setSpotlight((current) => (current === null ? current : null));
      }

      if (anchorRect && dialogRect) {
        const nextPos = placeExplainTourPopover({
          target: anchorRect,
          popover: dialogRect,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          avoid: saveRect,
        });
        setPopoverPos((current) =>
          current.top === nextPos.top && current.left === nextPos.left ? current : nextPos,
        );
      }
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      observer.disconnect();
    };
  }, [open, stepAnchor]);

  useExplainTourKeys({
    open,
    dialogRef,
    index,
    onBack: () => setIndex((current) => Math.max(0, current - 1)),
    onNext: () => {
      setIndex((current) => {
        if (current >= steps.length - 1) return current;
        return current + 1;
      });
    },
    onDismiss,
    atEnd: index >= steps.length - 1,
  });

  if (!open || !step) return null;

  const atEnd = index >= steps.length - 1;

  return createPortal(
    <>
      {spotlight && (
        <div
          aria-hidden="true"
          data-testid="explain-tour-spotlight"
          data-spotlight-anchor={step.anchor}
          data-spotlight-field={step.field ?? ''}
          className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-primary-400"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            boxShadow: '0 0 0 9999px rgba(1, 4, 9, 0.72)',
          }}
        />
      )}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="explain-tour-title"
        aria-describedby="explain-tour-body"
        tabIndex={-1}
        data-tour-step={step.id}
        data-tour-anchor={step.anchor}
        data-tour-field={step.field ?? ''}
        data-tour-target-found={targetFound ? 'true' : 'false'}
        className="fixed z-40 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-surface-border bg-surface-card p-4 shadow-xl focus:outline-hidden"
        style={{ top: popoverPos.top, left: popoverPos.left }}
      >
        <p className="sr-only" aria-live="polite">
          Step {index + 1} of {steps.length}: {step.title}. {step.body}
        </p>
        <div className="flex items-start justify-between gap-3">
          <h2 id="explain-tour-title" className="text-base font-semibold text-text-primary">
            {step.title}
          </h2>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            onClick={onDismiss}
            aria-label="Dismiss tour"
          >
            ×
          </button>
        </div>
        <p id="explain-tour-body" className="mt-2 text-sm text-text-secondary">
          {step.body}
        </p>
        {step.anchor === 'docs' && (
          <a
            href={PR_EXPLANATIONS_DOCS_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-primary-400 underline hover:text-primary-300"
          >
            Open the PR explanations guide
          </a>
        )}
        <p className="mt-3 text-xs text-text-muted">
          Step {index + 1} of {steps.length}. Saving settings stays available.
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-sm"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={index === 0}
          >
            Back
          </button>
          <div className="flex gap-2">
            {!atEnd && (
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-sm"
                onClick={onDismiss}
              >
                Skip
              </button>
            )}
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-sm"
              data-explain-tour-primary="true"
              data-tour-index={index}
              onClick={() => {
                if (atEnd) onDismiss();
                else setIndex((current) => current + 1);
              }}
            >
              {atEnd ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

function useExplainTourKeys(options: {
  open: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  index: number;
  atEnd: boolean;
  onBack: () => void;
  onNext: () => void;
  onDismiss: () => void;
}): void {
  const { open, dialogRef, index, atEnd, onBack, onNext, onDismiss } = options;

  useLayoutEffect(() => {
    if (!open) return;
    const primary = dialogRef.current?.querySelector<HTMLElement>(
      `[data-explain-tour-primary="true"][data-tour-index="${index}"]`,
    );
    primary?.focus();
  }, [open, dialogRef, index]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }

      const dialog = dialogRef.current;
      if (!dialog) return;

      if (
        (event.key === 'ArrowRight' || event.key === 'ArrowLeft') &&
        (dialog.contains(document.activeElement) ||
          (event.target instanceof Node && dialog.contains(event.target)))
      ) {
        event.preventDefault();
        if (event.key === 'ArrowRight') {
          if (atEnd) onDismiss();
          else onNext();
        } else if (index > 0) {
          onBack();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const items = focusCycle(dialog);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const nextIndex = event.shiftKey
        ? (current <= 0 ? items.length : current) - 1
        : (current + 1) % items.length;
      items[nextIndex]?.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dialogRef, index, atEnd, onBack, onNext, onDismiss]);
}

function focusCycle(dialog: HTMLElement): HTMLElement[] {
  const inside = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const outside = Array.from(document.querySelectorAll<HTMLElement>(TOUR_CHROME_SELECTOR)).filter(
    (element) => !dialog.contains(element),
  );
  return [...inside, ...outside];
}

function sameBox(
  current: { top: number; left: number; width: number; height: number } | null,
  next: { top: number; left: number; width: number; height: number },
): boolean {
  return (
    current !== null &&
    current.top === next.top &&
    current.left === next.left &&
    current.width === next.width &&
    current.height === next.height
  );
}

function findAnchor(anchor: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[data-explain-tour="${CSS.escape(anchor)}"]`,
  );
  return nodes.item(nodes.length - 1);
}

function readBox(element: HTMLElement | null): {
  top: number;
  left: number;
  width: number;
  height: number;
} | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}
