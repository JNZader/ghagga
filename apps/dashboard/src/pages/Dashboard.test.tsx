/**
 * Smoke render tests for Dashboard page.
 * Mocks api hooks and repo-context to render without crashes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock modules ───────────────────────────────────────────────

const mockUseStats = vi.fn();
const mockUseRepositories = vi.fn();

vi.mock('@/lib/api', () => ({
  useStats: () => mockUseStats(),
  useRepositories: () => mockUseRepositories(),
}));

const mockUseSelectedRepo = vi.fn();

vi.mock('@/lib/repo-context', () => ({
  useSelectedRepo: () => mockUseSelectedRepo(),
}));

// Import after mocks
import { Dashboard } from './Dashboard';

// ─── Helpers ────────────────────────────────────────────────────

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderDashboard() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mockUseSelectedRepo.mockReturnValue({
    selectedRepo: '',
    setSelectedRepo: vi.fn(),
  });
  mockUseRepositories.mockReturnValue({ data: [], isLoading: false });
  mockUseStats.mockReturnValue({ data: undefined, isLoading: false });
});

// ═══════════════════════════════════════════════════════════════════
// Dashboard page
// ═══════════════════════════════════════════════════════════════════

describe('Dashboard page', () => {
  it('renders without crashing (empty state)', () => {
    renderDashboard();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('No Data Yet')).toBeInTheDocument();
  });

  it('renders stats when repo is selected and data is loaded', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/app',
      setSelectedRepo: vi.fn(),
    });
    mockUseStats.mockReturnValue({
      data: {
        totalReviews: 42,
        passed: 30,
        failed: 12,
        passRate: 71.4,
        reviewsByDay: [],
      },
      isLoading: false,
    });

    renderDashboard();

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('71.4%')).toBeInTheDocument();
  });

  it('renders loading spinner when stats are loading', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/app',
      setSelectedRepo: vi.fn(),
    });
    mockUseStats.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = renderDashboard();

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });
});
