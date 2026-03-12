/**
 * DelegatedCiJobEntry component tests.
 *
 * Tests rendering of job fields, dropdown options,
 * onChange callbacks, and the remove button.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedCiJobPolicy } from '@/lib/types';
import { DelegatedCiJobEntry } from './DelegatedCiJobEntry';

// ─── Helpers ───────────────────────────────────────────────────

function createTestJob(overrides: Partial<DelegatedCiJobPolicy> = {}): DelegatedCiJobPolicy {
  return {
    jobKey: 'lint-check',
    displayName: 'ESLint Check',
    profile: 'node-lint',
    classification: 'safe/delegable',
    enabled: true,
    allowArtifacts: false,
    allowCache: true,
    ...overrides,
  };
}

const noop = vi.fn();

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('DelegatedCiJobEntry', () => {
  it('renders all fields with correct values', () => {
    const job = createTestJob({
      jobKey: 'unit-test',
      displayName: 'Unit Tests',
      profile: 'node-unit',
      classification: 'safe/delegable',
    });
    render(<DelegatedCiJobEntry index={0} job={job} onChange={noop} onRemove={noop} />);

    expect(screen.getByDisplayValue('unit-test')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Unit Tests')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Node.js Unit Tests')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Safe / Delegable')).toBeInTheDocument();
  });

  it('shows correct index number (1-based)', () => {
    render(<DelegatedCiJobEntry index={0} job={createTestJob()} onChange={noop} onRemove={noop} />);
    expect(screen.getByText('1')).toBeInTheDocument();

    const { unmount } = render(
      <DelegatedCiJobEntry index={4} job={createTestJob()} onChange={noop} onRemove={noop} />,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
    unmount();
  });

  it('calls onChange with updated jobKey when input changes', () => {
    const onChange = vi.fn();
    const job = createTestJob({ jobKey: 'old-key' });
    render(<DelegatedCiJobEntry index={0} job={job} onChange={onChange} onRemove={noop} />);

    const input = screen.getByDisplayValue('old-key');
    fireEvent.change(input, { target: { value: 'new-key' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].jobKey).toBe('new-key');
  });

  it('calls onChange when profile dropdown changes', () => {
    const onChange = vi.fn();
    const job = createTestJob({ profile: 'node-lint' });
    render(<DelegatedCiJobEntry index={0} job={job} onChange={onChange} onRemove={noop} />);

    const select = screen.getByDisplayValue('Node.js Lint');
    fireEvent.change(select, { target: { value: 'python-pytest' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].profile).toBe('python-pytest');
  });

  it('calls onChange when classification changes', () => {
    const onChange = vi.fn();
    const job = createTestJob({ classification: 'safe/delegable' });
    render(<DelegatedCiJobEntry index={0} job={job} onChange={onChange} onRemove={noop} />);

    const select = screen.getByDisplayValue('Safe / Delegable');
    fireEvent.change(select, { target: { value: 'sensitive/no-delegable' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].classification).toBe('sensitive/no-delegable');
  });

  it('calls onRemove when remove button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <DelegatedCiJobEntry index={0} job={createTestJob()} onChange={noop} onRemove={onRemove} />,
    );

    const removeButton = screen.getByTitle('Remove job');
    fireEvent.click(removeButton);

    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('shows correct profile options (16 profiles)', () => {
    render(<DelegatedCiJobEntry index={0} job={createTestJob()} onChange={noop} onRemove={noop} />);

    const profileSelect = screen.getByDisplayValue('Node.js Lint');
    const options = within(profileSelect).getAllByRole('option');

    expect(options).toHaveLength(16);
    expect(options.map((o) => o.textContent)).toEqual([
      'Node.js Lint',
      'Node.js Unit Tests',
      'Python Lint',
      'Python Pytest',
      'Go Test',
      'Go Lint',
      'JVM Gradle Build',
      'JVM Gradle Test',
      'JVM Maven Build',
      'JVM Maven Test',
      'Rust Build',
      'Rust Test',
      '.NET Build',
      '.NET Test',
      'PHP Lint',
      'PHP Test',
    ]);
  });

  it('toggles enabled state when checkbox is clicked', () => {
    const onChange = vi.fn();
    const job = createTestJob({ enabled: true });
    render(<DelegatedCiJobEntry index={0} job={job} onChange={onChange} onRemove={noop} />);

    // The enabled toggle checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox is the enabled toggle (sr-only)
    fireEvent.click(checkboxes[0]);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].enabled).toBe(false);
  });
});
