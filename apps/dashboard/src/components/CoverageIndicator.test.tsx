/**
 * Tests for CoverageIndicator component.
 * Pure presentational — renders a warning only for coverageComplete === false.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CoverageIndicator } from './CoverageIndicator';

const TOOLTIP = 'Incomplete coverage — some pipeline steps degraded';

describe('CoverageIndicator', () => {
  it('renders the warning with tooltip when coverageComplete is false', () => {
    render(<CoverageIndicator coverageComplete={false} />);
    const indicator = screen.getByLabelText(TOOLTIP);
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute('title', TOOLTIP);
    expect(indicator).toHaveTextContent('⚠');
  });

  it('renders nothing when coverageComplete is true', () => {
    const { container } = render(<CoverageIndicator coverageComplete={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when coverageComplete is undefined (legacy/SKIPPED rows)', () => {
    const { container } = render(<CoverageIndicator />);
    expect(container).toBeEmptyDOMElement();
  });
});
