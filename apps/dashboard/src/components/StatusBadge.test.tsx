/**
 * Tests for StatusBadge component.
 * Pure presentational — renders review status label and applies correct CSS classes.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReviewStatus } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

const statuses: Array<{ status: ReviewStatus; label: string }> = [
  { status: 'PASSED', label: 'Passed' },
  { status: 'FAILED', label: 'Failed' },
  { status: 'NEEDS_HUMAN_REVIEW', label: 'Needs Review' },
  { status: 'SKIPPED', label: 'Skipped' },
  { status: 'PARTIAL', label: 'Partial' },
];

describe('StatusBadge', () => {
  it.each(statuses)('renders "$label" text for status "$status"', ({ status, label }) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<StatusBadge status="PASSED" className="my-custom" />);
    const badge = screen.getByText('Passed');
    expect(badge.className).toContain('my-custom');
  });

  it('falls back to a neutral gray badge for an unknown status', () => {
    // Defense-in-depth: the server might return a new status before the
    // dashboard ships. The component should render the raw string as label
    // and apply neutral gray classes instead of crashing.
    render(<StatusBadge status={'UNKNOWN_STATUS' as ReviewStatus} />);
    const badge = screen.getByText('UNKNOWN_STATUS');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('bg-gray-500/15');
    expect(badge.className).toContain('text-gray-400');
    expect(badge.className).toContain('border-gray-500/25');
  });
});
