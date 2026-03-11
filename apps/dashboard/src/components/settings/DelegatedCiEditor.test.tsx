/**
 * DelegatedCiEditor component tests.
 *
 * Tests the editor's null/disabled/enabled states, toggle behavior,
 * add/remove job actions, and remove-policy confirmation flow.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedCiJobPolicy, DelegatedCiPolicy } from '@/lib/types';
import { DelegatedCiEditor } from './DelegatedCiEditor';

// ─── Mock useDiscoverCi ────────────────────────────────────────

vi.mock('@/lib/api', () => ({
  useDiscoverCi: () => ({
    data: undefined,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

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

function createTestPolicy(overrides: Partial<DelegatedCiPolicy> = {}): DelegatedCiPolicy {
  return {
    enabled: true,
    allowPullRequestTrigger: true,
    allowManualTrigger: true,
    jobs: [],
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('DelegatedCiEditor', () => {
  it('renders null state with disabled label and info text', () => {
    const onChange = vi.fn();
    renderWithProviders(<DelegatedCiEditor value={null} onChange={onChange} />);

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText(/no delegated ci policy configured/i)).toBeInTheDocument();
  });

  it('renders disabled state when value.enabled is false', () => {
    const onChange = vi.fn();
    const policy = createTestPolicy({ enabled: false });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText(/delegated ci is disabled/i)).toBeInTheDocument();
  });

  it('renders enabled state with empty jobs, trigger options, and add button', () => {
    const onChange = vi.fn();
    const policy = createTestPolicy({ enabled: true, jobs: [] });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText(/run on pull requests/i)).toBeInTheDocument();
    expect(screen.getByText(/allow manual trigger/i)).toBeInTheDocument();
    expect(screen.getByText(/add at least one job/i)).toBeInTheDocument();
    expect(screen.getByText(/\+ add custom job/i)).toBeInTheDocument();
  });

  it('enables from null and creates a fresh policy', () => {
    const onChange = vi.fn();
    renderWithProviders(<DelegatedCiEditor value={null} onChange={onChange} />);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      allowPullRequestTrigger: true,
      allowManualTrigger: true,
      jobs: [],
    });
  });

  it('disables while preserving existing jobs', () => {
    const onChange = vi.fn();
    const jobs = [createTestJob({ jobKey: 'lint' }), createTestJob({ jobKey: 'test' })];
    const policy = createTestPolicy({ enabled: true, jobs });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    // The main toggle is the first checkbox in the DOM
    const allCheckboxes = screen.getAllByRole('checkbox');
    fireEvent.click(allCheckboxes[0]);

    expect(onChange).toHaveBeenCalledOnce();
    const result = onChange.mock.calls[0]?.[0] as DelegatedCiPolicy;
    expect(result.enabled).toBe(false);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0].jobKey).toBe('lint');
    expect(result.jobs[1].jobKey).toBe('test');
  });

  it('re-enables while preserving existing jobs', () => {
    const onChange = vi.fn();
    const jobs = [createTestJob({ jobKey: 'build' })];
    const policy = createTestPolicy({ enabled: false, jobs });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledOnce();
    const result = onChange.mock.calls[0]?.[0] as DelegatedCiPolicy;
    expect(result.enabled).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].jobKey).toBe('build');
  });

  it('adds a job with default values when clicking "+ Add Custom Job"', () => {
    const onChange = vi.fn();
    const policy = createTestPolicy({ enabled: true, jobs: [createTestJob()] });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    fireEvent.click(screen.getByText(/\+ add custom job/i));

    expect(onChange).toHaveBeenCalledOnce();
    const result = onChange.mock.calls[0]?.[0] as DelegatedCiPolicy;
    expect(result.jobs).toHaveLength(2);

    const newJob = result.jobs[1];
    expect(newJob.jobKey).toBe('');
    expect(newJob.displayName).toBe('');
    expect(newJob.profile).toBe('node-lint');
    expect(newJob.classification).toBe('safe/delegable');
    expect(newJob.enabled).toBe(true);
    expect(newJob.allowArtifacts).toBe(false);
    expect(newJob.allowCache).toBe(true);
  });

  it('hides add buttons and shows max message when 10 jobs exist', () => {
    const onChange = vi.fn();
    const jobs = Array.from({ length: 10 }, (_, i) => createTestJob({ jobKey: `job-${i}` }));
    const policy = createTestPolicy({ enabled: true, jobs });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    expect(screen.queryByText(/\+ add custom job/i)).not.toBeInTheDocument();
    expect(screen.getByText(/maximum of 10 jobs reached/i)).toBeInTheDocument();
  });

  it('removes policy when confirm is accepted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChange = vi.fn();
    const policy = createTestPolicy({ enabled: true, jobs: [createTestJob()] });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    fireEvent.click(screen.getByText(/remove delegated ci configuration/i));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('does not remove policy when confirm is cancelled', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onChange = vi.fn();
    const policy = createTestPolicy({ enabled: true, jobs: [createTestJob()] });
    renderWithProviders(<DelegatedCiEditor value={policy} onChange={onChange} />);

    fireEvent.click(screen.getByText(/remove delegated ci configuration/i));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
