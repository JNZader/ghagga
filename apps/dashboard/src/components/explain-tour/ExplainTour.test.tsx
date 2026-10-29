/**
 * First-visit tour for /ghagga explain.
 * Covers open, dismiss, seen state, the dismissible note, keyboard reachability
 * of Save, and the enable step staying on explanationsEnabled.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExplainTour,
  ExplainTourBanner,
  ExplainTourReplayButton,
} from '@/components/explain-tour/ExplainTour';
import { placeExplainTourPopover } from '@/components/explain-tour/placement';
import { buildExplainTourSteps, EXPLAIN_TOUR_TOGGLE_FIELD } from '@/components/explain-tour/steps';
import {
  readExplainTourSeen,
  resetExplainTourStorageForTests,
  writeExplainTourSeen,
} from '@/components/explain-tour/storage';
import { useExplainTour } from '@/components/explain-tour/useExplainTour';
import { PrExplanationsSection } from '@/components/settings/PrExplanationsSection';

function TourFixture({
  autoStart = true,
  enabled = true,
  editable = true,
  onSave = () => {},
}: {
  autoStart?: boolean;
  enabled?: boolean;
  editable?: boolean;
  onSave?: () => void;
}) {
  const tour = useExplainTour(enabled, autoStart);
  const steps = useMemo(() => buildExplainTourSteps({ scope: 'repository', editable }), [editable]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <ExplainTourReplayButton visible={enabled} onReplay={tour.replay} />
      <ExplainTourBanner
        visible={tour.bannerVisible}
        tourOpen={tour.open}
        onStart={tour.replay}
        onDismiss={tour.dismissBanner}
      />
      <PrExplanationsSection
        mode={editable ? 'edit' : 'inherited'}
        enabled={false}
        onChange={() => {}}
        description={
          editable
            ? 'Let maintainers ask /ghagga explain on a pull request. Answers stay separate from reviews.'
            : 'Inherited from global settings'
        }
      />
      <button type="submit" data-critical-save="true">
        Save Settings
      </button>
      <ExplainTour open={tour.open} steps={steps} onDismiss={tour.dismissTour} />
    </form>
  );
}

beforeEach(() => {
  resetExplainTourStorageForTests();
});

describe('explain tour steps', () => {
  it('points the enable step at explanationsEnabled for every settings surface', () => {
    for (const input of [
      { scope: 'repository' as const, editable: true },
      { scope: 'repository' as const, editable: false },
      { scope: 'installation' as const, editable: true },
    ]) {
      const enable = buildExplainTourSteps(input).find((step) => step.id === 'enable');
      expect(enable).toMatchObject({
        anchor: 'toggle',
        field: EXPLAIN_TOUR_TOGGLE_FIELD,
      });
    }
  });
});

describe('explain tour placement', () => {
  it('keeps the popover off the save control when the spot below the target overlaps it', () => {
    const position = placeExplainTourPopover({
      target: { top: 500, left: 40, width: 280, height: 48 },
      popover: { width: 320, height: 200 },
      viewport: { width: 1000, height: 800 },
      avoid: { top: 540, left: 40, width: 160, height: 40 },
    });

    const popover = { ...position, width: 320, height: 200 };
    const save = { top: 540, left: 40, width: 160, height: 40 };
    const overlaps = !(
      popover.left + popover.width <= save.left ||
      save.left + save.width <= popover.left ||
      popover.top + popover.height <= save.top ||
      save.top + save.height <= popover.top
    );
    expect(overlaps).toBe(false);
    expect(position.top).toBeLessThan(500);
  });
});

describe('explain tour', () => {
  it('opens on the first visit and dismisses with Escape, remembering it was seen', () => {
    const { unmount } = render(<TourFixture />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-tour-step', 'what');
    expect(dialog).toHaveAttribute('data-tour-target-found', 'true');
    expect(screen.getByRole('region', { name: 'PR explanations tour' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'PR explanations tour' })).not.toBeInTheDocument();
    expect(readExplainTourSeen()).toBe(true);

    unmount();
    render(<TourFixture />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reopens from Replay tour after it has been seen', () => {
    writeExplainTourSeen();
    render(<TourFixture />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay tour' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-tour-step', 'what');
  });

  it('starts from the dismissible note without marking the tour seen until the tour closes', () => {
    const { unmount } = render(<TourFixture autoStart={false} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(readExplainTourSeen()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss note' }));
    expect(screen.queryByRole('region', { name: 'PR explanations tour' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(readExplainTourSeen()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(readExplainTourSeen()).toBe(true);

    unmount();
    render(<TourFixture autoStart={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'PR explanations tour' })).not.toBeInTheDocument();
  });

  it('targets the explanationsEnabled control on the enable step', () => {
    render(<TourFixture />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-tour-step', 'enable');
    expect(dialog).toHaveAttribute('data-tour-anchor', 'toggle');
    expect(dialog).toHaveAttribute('data-tour-field', 'explanationsEnabled');
    expect(dialog).toHaveAttribute('data-tour-target-found', 'true');

    const toggle = document.querySelector('[data-explain-tour="toggle"]');
    const input = toggle?.querySelector('input[name="explanationsEnabled"]');
    expect(input).toBe(screen.getByRole('checkbox', { name: 'PR explanations' }));
    expect(input).toHaveAttribute('id', 'explanationsEnabled');
  });

  it('leaves Save clickable and reachable from the keyboard while the tour is open', () => {
    const onSave = vi.fn();
    render(<TourFixture onSave={onSave} />);

    const save = screen.getByRole('button', { name: 'Save Settings' });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Dismiss tour' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('moves with the arrow keys and wraps focus inside the tour and save control', () => {
    render(<TourFixture />);

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog')).toHaveAttribute('data-tour-step', 'enable');

    const save = screen.getByRole('button', { name: 'Save Settings' });
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).not.toBe(save);
    expect(
      screen.getByRole('dialog').contains(document.activeElement) ||
        document.activeElement === screen.getByRole('button', { name: 'Replay tour' }) ||
        document.activeElement === screen.getByRole('button', { name: 'Dismiss note' }),
    ).toBe(true);
  });

  it('draws a non-blocking spotlight on the explanationsEnabled toggle', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        x: 24,
        y: 120,
        top: 120,
        left: 24,
        width: this.getAttribute('data-critical-save') === 'true' ? 140 : 220,
        height: 40,
        right: 244,
        bottom: 160,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };

    try {
      render(<TourFixture />);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      const spotlight = screen.getByTestId('explain-tour-spotlight');
      expect(spotlight).toHaveClass('pointer-events-none');
      expect(spotlight).toHaveAttribute('data-spotlight-anchor', 'toggle');
      expect(spotlight).toHaveAttribute('data-spotlight-field', 'explanationsEnabled');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
