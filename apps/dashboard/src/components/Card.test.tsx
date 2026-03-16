/**
 * Tests for Card and CardHeader components.
 * Pure presentational — renders children with correct padding and structure.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardHeader } from './Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Hello Card</Card>);
    expect(screen.getByText('Hello Card')).toBeInTheDocument();
  });

  it('applies default padding (md = p-6)', () => {
    const { container } = render(<Card>Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('p-6');
  });

  it('applies custom className', () => {
    const { container } = render(<Card className="my-custom">Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('my-custom');
  });

  it('applies no padding when padding="none"', () => {
    const { container } = render(<Card padding="none">Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).not.toContain('p-4');
    expect(card.className).not.toContain('p-6');
    expect(card.className).not.toContain('p-8');
  });

  it('applies lg padding when padding="lg"', () => {
    const { container } = render(<Card padding="lg">Content</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('p-8');
  });
});

describe('CardHeader', () => {
  it('renders title', () => {
    render(<CardHeader title="My Title" />);
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<CardHeader title="Title" description="A description" />);
    expect(screen.getByText('A description')).toBeInTheDocument();
  });

  it('renders action slot when provided', () => {
    render(<CardHeader title="Title" action={<button type="button">Action</button>} />);
    expect(screen.getByText('Action')).toBeInTheDocument();
  });
});
