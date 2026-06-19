/**
 * Integration tests for Memory page with management capabilities.
 * Tests delete buttons, confirmation dialogs (all 3 tiers),
 * success/error flows, empty states, and loading states.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/Toast';

// ─── Mock modules ───────────────────────────────────────────────

const mockUseRepositories = vi.fn();
const mockUseMemorySessions = vi.fn();
const mockUseObservations = vi.fn();

const mockDeleteMutate = vi.fn();
const mockClearMutate = vi.fn();
const mockPurgeMutate = vi.fn();

const mockUseDeleteObservation = vi.fn();
const mockUseClearRepoMemory = vi.fn();
const mockUsePurgeAllMemory = vi.fn();
const mockUseDeleteSession = vi.fn();
const mockUseCleanupEmptySessions = vi.fn();
const mockBatchDeleteObsMutate = vi.fn();
const mockBatchDeleteObsReset = vi.fn();
const mockUseBatchDeleteObservations = vi.fn();

vi.mock('@/lib/api', () => ({
  useRepositories: () => mockUseRepositories(),
  useMemorySessions: () => mockUseMemorySessions(),
  useObservations: () => mockUseObservations(),
  useDeleteObservation: () => mockUseDeleteObservation(),
  useBatchDeleteObservations: () => mockUseBatchDeleteObservations(),
  useClearRepoMemory: () => mockUseClearRepoMemory(),
  usePurgeAllMemory: () => mockUsePurgeAllMemory(),
  useDeleteSession: () => mockUseDeleteSession(),
  useCleanupEmptySessions: () => mockUseCleanupEmptySessions(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  },
}));

const mockUseSelectedRepo = vi.fn();

vi.mock('@/lib/repo-context', () => ({
  useSelectedRepo: () => mockUseSelectedRepo(),
}));

// Import after mocks
import { Memory } from './Memory';

// ─── Helpers ────────────────────────────────────────────────────

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderMemory() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Memory />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const sampleObservations = [
  {
    id: 42,
    sessionId: 1,
    type: 'pattern' as const,
    title: 'OAuth token refresh patterns',
    content: 'Always check token expiry before making API calls.',
    filePaths: ['src/auth.ts'],
    severity: 'high' as string | null,
    topicKey: 'auth-token-refresh' as string | null,
    revisionCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 43,
    sessionId: 1,
    type: 'bugfix' as const,
    title: 'Race condition in async handlers',
    content: 'Use mutex pattern for shared resources.',
    filePaths: [],
    severity: 'critical' as string | null,
    topicKey: null as string | null,
    revisionCount: 3,
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
  },
];

const sampleSessions = [
  {
    id: 1,
    project: 'acme/widgets',
    prNumber: 42,
    summary: 'Learned async patterns',
    createdAt: '2026-01-01T00:00:00Z',
    observationCount: 5,
    criticalCount: 1,
    highCount: 2,
    mediumCount: 0,
  },
  {
    id: 2,
    project: 'acme/widgets',
    prNumber: 43,
    summary: 'Bug fix patterns',
    createdAt: '2026-01-02T00:00:00Z',
    observationCount: 3,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 1,
  },
];

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mockUseSelectedRepo.mockReturnValue({
    selectedRepo: '',
    setSelectedRepo: vi.fn(),
  });
  mockUseRepositories.mockReturnValue({ data: [], isLoading: false });
  mockUseMemorySessions.mockReturnValue({ data: undefined, isLoading: false });
  mockUseObservations.mockReturnValue({ data: undefined, isLoading: false });
  mockUseDeleteObservation.mockReturnValue({
    mutate: mockDeleteMutate,
    isPending: false,
  });
  mockUseBatchDeleteObservations.mockReturnValue({
    mutate: mockBatchDeleteObsMutate,
    reset: mockBatchDeleteObsReset,
    isPending: false,
    error: null,
  });
  mockUseClearRepoMemory.mockReturnValue({
    mutate: mockClearMutate,
    isPending: false,
  });
  mockUsePurgeAllMemory.mockReturnValue({
    mutate: mockPurgeMutate,
    isPending: false,
  });
  mockUseDeleteSession.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mockUseCleanupEmptySessions.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
});

// ═══════════════════════════════════════════════════════════════════
// Basic rendering (backward compat)
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — basic rendering', () => {
  it('renders without crashing (no repo selected)', () => {
    renderMemory();

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Select a Repository')).toBeInTheDocument();
  });

  it('renders session list when repo is selected', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });

    renderMemory();

    expect(screen.getByText('PR #42')).toBeInTheDocument();
    expect(screen.getByText('Learned async patterns')).toBeInTheDocument();
  });

  it('shows empty state when sessions list is empty', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderMemory();

    expect(screen.getByText('No memory stored for this repository.')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 1: Delete single observation
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — Tier 1 (delete observation)', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });
  });

  it('renders delete buttons on observation cards when a session is selected', () => {
    renderMemory();

    // Click a session to select it
    fireEvent.click(screen.getByText('PR #42'));

    const deleteButtons = screen.getAllByTitle('Delete observation');
    expect(deleteButtons.length).toBe(2);
  });

  it('opens Tier 1 confirmation dialog when delete is clicked', () => {
    renderMemory();

    fireEvent.click(screen.getByText('PR #42'));

    // Default sort is newest-first, so observation 43 (Race condition) is first, 42 (OAuth) is second
    const deleteButtons = screen.getAllByTitle('Delete observation');
    fireEvent.click(deleteButtons[1]); // index 1 = OAuth (id 42)

    expect(screen.getByText('Delete observation')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Are you sure you want to delete "OAuth token refresh patterns"? This action cannot be undone.',
      ),
    ).toBeInTheDocument();
  });

  it('calls delete mutation when confirm is clicked', () => {
    renderMemory();

    fireEvent.click(screen.getByText('PR #42'));

    // Default sort is newest-first, so observation 43 is first (index 0)
    const deleteButtons = screen.getAllByTitle('Delete observation');
    fireEvent.click(deleteButtons[0]); // index 0 = Race condition (id 43)

    // Click the "Delete" button in the dialog
    const confirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(confirmBtn);

    expect(mockDeleteMutate).toHaveBeenCalledWith(
      { observationId: 43 },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('closes modal on cancel without making API call', () => {
    renderMemory();

    fireEvent.click(screen.getByText('PR #42'));

    const deleteButtons = screen.getAllByTitle('Delete observation');
    fireEvent.click(deleteButtons[0]);

    // Click cancel
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });

  it('shows success toast after delete succeeds', () => {
    // Make mutate call the onSuccess immediately
    mockDeleteMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });

    renderMemory();

    fireEvent.click(screen.getByText('PR #42'));

    const deleteButtons = screen.getAllByTitle('Delete observation');
    fireEvent.click(deleteButtons[0]);

    const confirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(confirmBtn);

    expect(screen.getByText('Observation deleted')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 2: Clear repo memory
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — Tier 2 (clear repo memory)', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
  });

  it('shows "Clear Memory" button when repo is selected', () => {
    renderMemory();

    expect(screen.getByText('Clear Memory')).toBeInTheDocument();
  });

  it('does not show "Clear Memory" button when no repo is selected', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: '',
      setSelectedRepo: vi.fn(),
    });

    renderMemory();

    expect(screen.queryByText('Clear Memory')).not.toBeInTheDocument();
  });

  it('opens Tier 2 dialog with text input when Clear Memory is clicked', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Clear Memory'));

    expect(screen.getByText('Clear all memory for acme/widgets')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmation text')).toBeInTheDocument();
  });

  it('confirm button is disabled until text matches repo name', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Clear Memory'));

    // "Clear Memory" appears as both the trigger button and the dialog confirm label
    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    expect(dialogConfirmBtn).toBeDisabled();

    // Type wrong text
    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'wrong' },
    });
    expect(dialogConfirmBtn).toBeDisabled();

    // Type correct text
    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });
    expect(dialogConfirmBtn).not.toBeDisabled();
  });

  it('calls clear mutation when confirmed with matching text', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Clear Memory'));

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });

    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(dialogConfirmBtn);

    expect(mockClearMutate).toHaveBeenCalledWith(
      { project: 'acme/widgets' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows success toast after clear succeeds', () => {
    mockClearMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (data: { cleared: number }) => void }) => {
        opts.onSuccess({ cleared: 15 });
      },
    );

    renderMemory();

    fireEvent.click(screen.getByText('Clear Memory'));

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'acme/widgets' },
    });

    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(dialogConfirmBtn);

    expect(screen.getByText('Cleared 15 observations from acme/widgets')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier 3: Purge all memory
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — Tier 3 (purge all memory)', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "Purge All Memory" button in Danger Zone', () => {
    renderMemory();

    expect(screen.getByText('Purge All Memory')).toBeInTheDocument();
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('opens Tier 3 dialog with countdown when Purge All Memory is clicked', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Purge All Memory'));

    expect(screen.getByText('Purge all memory')).toBeInTheDocument();
    expect(screen.getByText('Purge All (5s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmation text')).toBeInTheDocument();
  });

  it('confirm button requires both text match and countdown completion', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Purge All Memory'));

    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;

    // Type correct text, but countdown still active
    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });
    expect(dialogConfirmBtn).toBeDisabled();

    // Wait for countdown
    act(() => vi.advanceTimersByTime(5000));

    expect(dialogConfirmBtn).not.toBeDisabled();
  });

  it('calls purge mutation when both conditions are met and button clicked', () => {
    renderMemory();

    fireEvent.click(screen.getByText('Purge All Memory'));

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    act(() => vi.advanceTimersByTime(5000));

    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(dialogConfirmBtn);

    expect(mockPurgeMutate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it('shows success toast after purge succeeds', () => {
    mockPurgeMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (data: { cleared: number }) => void }) => {
        opts.onSuccess({ cleared: 50 });
      },
    );

    renderMemory();

    fireEvent.click(screen.getByText('Purge All Memory'));

    fireEvent.change(screen.getByLabelText('Confirmation text'), {
      target: { value: 'DELETE ALL' },
    });

    act(() => vi.advanceTimersByTime(5000));

    const dialogConfirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(dialogConfirmBtn);

    expect(screen.getByText('Purged 50 observations from all repositories')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Empty states
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — empty states', () => {
  it('shows empty session message when sessions are empty', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderMemory();

    expect(screen.getByText('No memory stored for this repository.')).toBeInTheDocument();
  });

  it('shows empty observations message when session has no observations', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: [
        {
          id: 1,
          project: 'acme/widgets',
          prNumber: 42,
          summary: 'Empty session',
          createdAt: '2026-01-01T00:00:00Z',
          observationCount: 0,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
        },
      ],
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderMemory();

    // Select the session
    fireEvent.click(screen.getByText('PR #42'));

    expect(screen.getByText('No observations in this session.')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — error handling', () => {
  it('shows error message in dialog when delete fails', () => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });

    mockDeleteMutate.mockImplementation(
      (_vars: unknown, opts: { onError: (error: Error) => void }) => {
        opts.onError(new Error('Network error'));
      },
    );

    renderMemory();

    fireEvent.click(screen.getByText('PR #42'));

    const deleteButtons = screen.getAllByTitle('Delete observation');
    fireEvent.click(deleteButtons[0]);

    const confirmBtn = screen.getByRole('dialog').querySelector('button:last-child')!;
    fireEvent.click(confirmBtn);

    // Dialog should remain open with error message
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 6: ObservationCard enhancements
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — ObservationCard enhancements', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });
  });

  it('renders severity badge on observation cards with valid severity', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // sampleObservations have 'high' and 'critical' severity
    // 'High' and 'Critical' also appear as filter dropdown options, so use getAllByText
    const highElements = screen.getAllByText('High');
    expect(highElements.length).toBeGreaterThanOrEqual(2); // badge + dropdown option
    const criticalElements = screen.getAllByText('Critical');
    expect(criticalElements.length).toBeGreaterThanOrEqual(2); // badge + dropdown option
  });

  it('does not render severity badge for observations with null severity', () => {
    const obsWithNullSeverity = [
      {
        ...sampleObservations[0],
        severity: null as string | null,
      },
    ];
    mockUseObservations.mockReturnValue({
      data: obsWithNullSeverity,
      isLoading: false,
    });

    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // The type badge 'Pattern' appears on the card and may appear in stats bar
    const patternElements = screen.getAllByText('Pattern');
    expect(patternElements.length).toBeGreaterThanOrEqual(1);
    // 'High' should only appear in the dropdown option, not as a severity badge
    const highElements = screen.getAllByText('High');
    expect(highElements.length).toBe(1); // only the dropdown option
  });

  it('renders revision count badge when revisionCount > 1', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // sampleObservations[1] has revisionCount: 3
    expect(screen.getByText('3 revisions')).toBeInTheDocument();
  });

  it('does not render revision badge when revisionCount is 1', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // sampleObservations[0] has revisionCount: 1 — no "1 revisions" badge
    expect(screen.queryByText('1 revisions')).not.toBeInTheDocument();
    expect(screen.queryByText('1 revision')).not.toBeInTheDocument();
  });

  it('truncates file paths beyond MAX_FILE_PATHS_SHOWN', () => {
    const obsWithManyPaths = [
      {
        ...sampleObservations[0],
        filePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      },
    ];
    mockUseObservations.mockReturnValue({
      data: obsWithManyPaths,
      isLoading: false,
    });

    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // First 3 paths visible, "+2 more" indicator
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
    expect(screen.getByText('src/c.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/d.ts')).not.toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('opens detail modal when observation card is clicked', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Click the observation card content (not the delete button)
    fireEvent.click(screen.getByText('OAuth token refresh patterns'));

    // Detail modal should be open with aria role dialog
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('auth-token-refresh')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 7: SessionItem enhancements
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — SessionItem enhancements', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
  });

  it('renders PR link for sessions with prNumber > 0', () => {
    renderMemory();

    const prLink = screen.getByTitle('Open PR #42 on GitHub');
    expect(prLink).toBeInTheDocument();
    expect(prLink).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/42');
    expect(prLink).toHaveAttribute('target', '_blank');
  });

  it('does not render PR link for sessions with prNumber 0', () => {
    mockUseMemorySessions.mockReturnValue({
      data: [
        {
          ...sampleSessions[0],
          prNumber: 0,
        },
      ],
      isLoading: false,
    });

    renderMemory();

    expect(screen.queryByTitle('Open PR #0 on GitHub')).not.toBeInTheDocument();
  });

  it('renders severity summary chips for sessions with severity counts', () => {
    renderMemory();

    // Both sessions may have severity summaries visible
    const summaries = screen.getAllByTestId('session-severity-summary');
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    // Session 1: 1 critical, 2 high
    expect(screen.getByText('1 critical')).toBeInTheDocument();
    expect(screen.getByText('2 high')).toBeInTheDocument();
  });

  it('does not render severity summary when all counts are 0', () => {
    mockUseMemorySessions.mockReturnValue({
      data: [
        {
          ...sampleSessions[0],
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
        },
      ],
      isLoading: false,
    });

    renderMemory();

    expect(screen.queryByTestId('session-severity-summary')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 9: Stats bar
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — StatsBar', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });
  });

  it('renders stats bar when observations are present', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    const statsBar = screen.getByTestId('stats-bar');
    expect(statsBar).toBeInTheDocument();
    expect(screen.getByText('2 observations')).toBeInTheDocument();
  });

  it('does not render stats bar when observations list is empty', () => {
    mockUseObservations.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    expect(screen.queryByTestId('stats-bar')).not.toBeInTheDocument();
  });

  it('shows type breakdown chips in stats bar', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // We have 1 pattern and 1 bugfix — these labels appear on both cards and stats bar
    const statsBar = screen.getByTestId('stats-bar');
    expect(statsBar).toBeInTheDocument();
    // 'Pattern' appears on the card type badge AND in the stats bar — at least 2
    const patternElements = screen.getAllByText('Pattern');
    expect(patternElements.length).toBeGreaterThanOrEqual(2);
    const bugfixElements = screen.getAllByText('Bug Fix');
    expect(bugfixElements.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 10: Severity filter & sort options
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — severity filter & sort', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });
  });

  it('shows severity filter dropdown when session is selected', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    expect(screen.getByLabelText('Filter by severity')).toBeInTheDocument();
  });

  it('does not show severity filter when no session is selected', () => {
    renderMemory();

    expect(screen.queryByLabelText('Filter by severity')).not.toBeInTheDocument();
  });

  it('filters observations by severity', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Filter to 'critical' — only the bugfix (id 43) has severity 'critical'
    fireEvent.change(screen.getByLabelText('Filter by severity'), {
      target: { value: 'critical' },
    });

    expect(screen.getByText('Race condition in async handlers')).toBeInTheDocument();
    expect(screen.queryByText('OAuth token refresh patterns')).not.toBeInTheDocument();
  });

  it('shows sort dropdown when session is selected', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    expect(screen.getByLabelText('Sort observations')).toBeInTheDocument();
  });

  it('sorts observations by severity (most severe first)', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    fireEvent.change(screen.getByLabelText('Sort observations'), {
      target: { value: 'severity' },
    });

    // 'critical' (weight 5) should come before 'high' (weight 4)
    const cards = screen.getAllByTitle('Delete observation');
    expect(cards.length).toBe(2);
    // The first delete button should be on the 'critical' card (Race condition)
    // Verify order by checking which title appears first in the document
    const titles = screen.getAllByRole('heading', { level: 4 });
    expect(titles[0].textContent).toBe('Race condition in async handlers');
    expect(titles[1].textContent).toBe('OAuth token refresh patterns');
  });

  it('sorts observations by revisions (most revised first)', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    fireEvent.change(screen.getByLabelText('Sort observations'), {
      target: { value: 'revisions' },
    });

    // Observation id 43 has revisionCount: 3, id 42 has revisionCount: 1
    const titles = screen.getAllByRole('heading', { level: 4 });
    expect(titles[0].textContent).toBe('Race condition in async handlers');
    expect(titles[1].textContent).toBe('OAuth token refresh patterns');
  });

  it('sorts observations oldest first', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    fireEvent.change(screen.getByLabelText('Sort observations'), {
      target: { value: 'oldest' },
    });

    const titles = screen.getAllByRole('heading', { level: 4 });
    expect(titles[0].textContent).toBe('OAuth token refresh patterns'); // 2026-01-01
    expect(titles[1].textContent).toBe('Race condition in async handlers'); // 2026-01-02
  });

  it('defaults to newest first sort', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Default sort is 'newest' — 2026-01-02 before 2026-01-01
    const titles = screen.getAllByRole('heading', { level: 4 });
    expect(titles[0].textContent).toBe('Race condition in async handlers');
    expect(titles[1].textContent).toBe('OAuth token refresh patterns');
  });

  it('combines severity filter and sort together', () => {
    // Set up 3 observations to test combo
    const threeObs = [
      ...sampleObservations,
      {
        id: 44,
        sessionId: 1,
        type: 'learning' as const,
        title: 'Logging best practices',
        content: 'Always use structured logging.',
        filePaths: [],
        severity: 'high' as string | null,
        topicKey: null as string | null,
        revisionCount: 2,
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
      },
    ];
    mockUseObservations.mockReturnValue({
      data: threeObs,
      isLoading: false,
    });

    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Filter to 'high' only
    fireEvent.change(screen.getByLabelText('Filter by severity'), {
      target: { value: 'high' },
    });

    // Sort by oldest first
    fireEvent.change(screen.getByLabelText('Sort observations'), {
      target: { value: 'oldest' },
    });

    // Only 'high' severity: OAuth (2026-01-01) and Logging (2026-01-03)
    // Oldest first: OAuth first, then Logging
    expect(screen.queryByText('Race condition in async handlers')).not.toBeInTheDocument();
    const titles = screen.getAllByRole('heading', { level: 4 });
    expect(titles.length).toBe(2);
    expect(titles[0].textContent).toBe('OAuth token refresh patterns');
    expect(titles[1].textContent).toBe('Logging best practices');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Selection & Batch Delete Observations
// ═══════════════════════════════════════════════════════════════════

describe('Memory page — selection & batch delete', () => {
  beforeEach(() => {
    mockUseSelectedRepo.mockReturnValue({
      selectedRepo: 'acme/widgets',
      setSelectedRepo: vi.fn(),
    });
    mockUseMemorySessions.mockReturnValue({
      data: sampleSessions,
      isLoading: false,
    });
    mockUseObservations.mockReturnValue({
      data: sampleObservations,
      isLoading: false,
    });
  });

  it('renders checkboxes for each observation card', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // 2 observations → 2 per-observation checkboxes + 1 select-all = 3
    // (plus the "Also clear memory" checkbox is NOT visible here)
    const checkboxes = screen.getAllByRole('checkbox');
    // select-all + 2 per-observation
    expect(checkboxes.length).toBe(3);
  });

  it('select-all selects all visible observations', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    const selectAll = screen.getByLabelText('Select all observations');
    fireEvent.click(selectAll);

    // All checkboxes should be checked
    const checkboxes = screen.getAllByRole('checkbox');
    for (const cb of checkboxes) {
      expect(cb).toBeChecked();
    }
  });

  it('deselect-all via select-all checkbox clears selection', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    const selectAll = screen.getByLabelText('Select all observations');
    fireEvent.click(selectAll);
    fireEvent.click(selectAll);

    const checkboxes = screen.getAllByRole('checkbox');
    for (const cb of checkboxes) {
      expect(cb).not.toBeChecked();
    }
  });

  it('"Delete Selected" button shows count when items selected', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Initially no "Delete Selected" button
    expect(screen.queryByText(/Delete Selected \(/)).not.toBeInTheDocument();

    // Select one observation
    const obs1Checkbox = screen.getByLabelText(
      'Select observation: Race condition in async handlers',
    );
    fireEvent.click(obs1Checkbox);

    expect(screen.getByText('Delete Selected (1)')).toBeInTheDocument();
  });

  it('"Delete Selected" is hidden when nothing is selected', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    expect(screen.queryByText(/Delete Selected \(/)).not.toBeInTheDocument();
  });

  it('confirming batch delete calls the batch delete API', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Select all observations
    const selectAll = screen.getByLabelText('Select all observations');
    fireEvent.click(selectAll);

    // Click "Delete Selected (2)"
    fireEvent.click(screen.getByText('Delete Selected (2)'));

    // Dialog should open
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.length).toBeGreaterThanOrEqual(1);

    // Find the dialog with the batch delete title
    expect(screen.getByText('Delete 2 observations?')).toBeInTheDocument();

    // Confirm (Tier 1 — no text input needed)
    // The last dialog's confirm button
    const dialog = dialogs[dialogs.length - 1];
    const buttons = within(dialog).getAllByRole('button');
    const confirmBtn = buttons[buttons.length - 1]; // Last button is confirm
    fireEvent.click(confirmBtn);

    expect(mockBatchDeleteObsMutate).toHaveBeenCalledTimes(1);
    const callArgs = mockBatchDeleteObsMutate.mock.calls[0];
    expect(callArgs[0].ids).toHaveLength(2);
    expect(callArgs[0].ids).toContain(42);
    expect(callArgs[0].ids).toContain(43);
  });

  it('selection clears after successful batch delete', () => {
    mockBatchDeleteObsMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (data: { deletedCount: number }) => void }) => {
        opts.onSuccess({ deletedCount: 2 });
      },
    );

    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Select all
    const selectAll = screen.getByLabelText('Select all observations');
    fireEvent.click(selectAll);

    // Batch delete
    fireEvent.click(screen.getByText('Delete Selected (2)'));
    const dialogs = screen.getAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    const buttons = within(dialog).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    // Selection should be cleared — "Delete Selected" button gone
    expect(screen.queryByText(/Delete Selected \(/)).not.toBeInTheDocument();

    // Success toast
    expect(screen.getByText('Deleted 2 observations')).toBeInTheDocument();
  });

  it('selection clears on severity filter change', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Select an observation
    const obs1Checkbox = screen.getByLabelText(
      'Select observation: Race condition in async handlers',
    );
    fireEvent.click(obs1Checkbox);
    expect(screen.getByText('Delete Selected (1)')).toBeInTheDocument();

    // Change severity filter
    fireEvent.change(screen.getByLabelText('Filter by severity'), {
      target: { value: 'critical' },
    });

    // Selection should be cleared
    expect(screen.queryByText(/Delete Selected \(/)).not.toBeInTheDocument();
  });

  it('selection clears on sort change', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    // Select an observation
    const obs1Checkbox = screen.getByLabelText(
      'Select observation: Race condition in async handlers',
    );
    fireEvent.click(obs1Checkbox);
    expect(screen.getByText('Delete Selected (1)')).toBeInTheDocument();

    // Change sort
    fireEvent.change(screen.getByLabelText('Sort observations'), {
      target: { value: 'oldest' },
    });

    // Selection should be cleared
    expect(screen.queryByText(/Delete Selected \(/)).not.toBeInTheDocument();
  });

  it('clicking checkbox does not open detail modal', () => {
    renderMemory();
    fireEvent.click(screen.getByText('PR #42'));

    const obs1Checkbox = screen.getByLabelText(
      'Select observation: Race condition in async handlers',
    );
    fireEvent.click(obs1Checkbox);

    // The detail modal should NOT open — no topic key or extra detail visible
    // The observation detail modal shows content that wouldn't normally be visible
    expect(screen.queryByText('auth-token-refresh')).not.toBeInTheDocument();
  });
});
