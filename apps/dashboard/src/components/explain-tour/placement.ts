export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
}

/**
 * Place the tour popover beside its target without covering the save control.
 * The overlay itself does not capture clicks; this only keeps the popover off
 * the button maintainers use to persist settings.
 */
export function placeExplainTourPopover(options: {
  target: TourRect;
  popover: Pick<TourRect, 'width' | 'height'>;
  viewport: { width: number; height: number };
  avoid?: TourRect | null;
  margin?: number;
}): PopoverPosition {
  const margin = options.margin ?? 12;
  const { target, popover, viewport, avoid } = options;

  const candidates: PopoverPosition[] = [
    { top: target.top + target.height + margin, left: target.left },
    { top: target.top - popover.height - margin, left: target.left },
    { top: target.top, left: target.left + target.width + margin },
    { top: target.top, left: target.left - popover.width - margin },
  ];

  for (const candidate of candidates) {
    if (fits(candidate, popover, viewport, avoid, margin)) return candidate;
  }

  const left = clamp(target.left, margin, viewport.width - popover.width - margin);
  let top = target.top + target.height + margin;
  if (avoid && intersects({ top, left }, popover, avoid)) {
    top = target.top - popover.height - margin;
  }
  top = clamp(top, margin, viewport.height - popover.height - margin);
  return { top, left };
}

function fits(
  position: PopoverPosition,
  popover: Pick<TourRect, 'width' | 'height'>,
  viewport: { width: number; height: number },
  avoid: TourRect | null | undefined,
  margin: number,
): boolean {
  if (position.top < margin || position.left < margin) return false;
  if (position.top + popover.height > viewport.height - margin) return false;
  if (position.left + popover.width > viewport.width - margin) return false;
  if (avoid && intersects(position, popover, avoid)) return false;
  return true;
}

function intersects(
  position: PopoverPosition,
  popover: Pick<TourRect, 'width' | 'height'>,
  other: TourRect,
): boolean {
  return !(
    position.left + popover.width <= other.left ||
    other.left + other.width <= position.left ||
    position.top + popover.height <= other.top ||
    other.top + other.height <= position.top
  );
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
