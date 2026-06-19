/**
 * Unit tests for ObservationDetailModal component.
 * Tests rendering, close behavior (Escape, backdrop, button),
 * conditional fields (severity, topicKey, revisions, timestamps).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Observation } from '@/lib/types';
import { ObservationDetailModal } from './ObservationDetailModal';

// ─── Fixtures ───────────────────────────────────────────────────

const baseObservation: Observation = {
  id: 100,
  sessionId: 1,
  type: 'pattern',
  title: 'Cache invalidation strategy',
  content: 'Use write-through caching with TTL-based eviction.',
  filePaths: ['src/cache.ts', 'src/utils/ttl.ts'],
  severity: 'high',
  topicKey: 'cache-invalidation',
  revisionCount: 3,
  createdAt: '2026-01-15T10:00:00Z',
  updatedAt: '2026-01-16T14:30:00Z',
};

const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// Basic rendering
// ═══════════════════════════════════════════════════════════════════

describe('ObservationDetailModal — rendering', () => {
  it('does not render when observation is null', () => {
    render(<ObservationDetailModal observation={null} onClose={onClose} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders dialog with observation title', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Cache invalidation strategy')).toBeInTheDocument();
  });

  it('renders observation content', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(
      screen.getByText('Use write-through caching with TTL-based eviction.'),
    ).toBeInTheDocument();
  });

  it('renders type badge', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByText('Pattern')).toBeInTheDocument();
  });

  it('renders severity badge when severity is valid', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('does not render severity badge when severity is null', () => {
    const obs = { ...baseObservation, severity: null };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.queryByText('High')).not.toBeInTheDocument();
    // Type badge should still render
    expect(screen.getByText('Pattern')).toBeInTheDocument();
  });

  it('renders revision count badge when revisionCount > 1', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByText('3 revisions')).toBeInTheDocument();
  });

  it('does not render revision count badge when revisionCount is 1', () => {
    const obs = { ...baseObservation, revisionCount: 1 };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.queryByText('1 revisions')).not.toBeInTheDocument();
    expect(screen.queryByText('1 revision')).not.toBeInTheDocument();
  });

  it('renders file paths', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByText('src/cache.ts')).toBeInTheDocument();
    expect(screen.getByText('src/utils/ttl.ts')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('does not render file paths section when filePaths is empty', () => {
    const obs = { ...baseObservation, filePaths: [] };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.queryByText('Files')).not.toBeInTheDocument();
  });

  it('renders topic key when present', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    expect(screen.getByText('Topic Key')).toBeInTheDocument();
    expect(screen.getByText('cache-invalidation')).toBeInTheDocument();
  });

  it('does not render topic key section when topicKey is null', () => {
    const obs = { ...baseObservation, topicKey: null };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.queryByText('Topic Key')).not.toBeInTheDocument();
  });

  it('renders created timestamp', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    // The relative time text contains "Created ..." — we just check it exists
    const timestamps = screen.getByText(/^Created /);
    expect(timestamps).toBeInTheDocument();
  });

  it('renders updated timestamp when different from created', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    // updatedAt !== createdAt, so "Updated ..." should appear
    const updated = screen.getByText(/^Updated /);
    expect(updated).toBeInTheDocument();
  });

  it('does not render updated timestamp when same as created', () => {
    const obs = { ...baseObservation, updatedAt: baseObservation.createdAt };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Close behavior
// ═══════════════════════════════════════════════════════════════════

describe('ObservationDetailModal — close behavior', () => {
  it('calls onClose when close button is clicked', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('detail-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for non-Escape keys', () => {
    render(<ObservationDetailModal observation={baseObservation} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, {
      key: 'Enter',
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Observation types
// ═══════════════════════════════════════════════════════════════════

describe('ObservationDetailModal — observation types', () => {
  const types: Array<{ type: Observation['type']; label: string }> = [
    { type: 'pattern', label: 'Pattern' },
    { type: 'bugfix', label: 'Bug Fix' },
    { type: 'learning', label: 'Learning' },
    { type: 'decision', label: 'Decision' },
    { type: 'architecture', label: 'Architecture' },
    { type: 'config', label: 'Config' },
    { type: 'discovery', label: 'Discovery' },
  ];

  it.each(types)('renders "$label" badge for type "$type"', ({ type, label }) => {
    const obs = { ...baseObservation, type };
    render(<ObservationDetailModal observation={obs} onClose={onClose} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
