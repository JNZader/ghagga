/**
 * Tests for the Issue Triage approval page.
 * Covers: list render, loading/empty/error, detail open, edit save,
 * approve (with confirm), reject (with confirm), and XSS-safety (untrusted
 * body/title rendered as plain text, never as HTML).
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/Toast';

// ─── Mock the api hooks ─────────────────────────────────────────

const mockUseIssueDrafts = vi.fn();
const mockEditMutate = vi.fn();
const mockApproveMutate = vi.fn();
const mockRejectMutate = vi.fn();
const mockEditReset = vi.fn();
const mockApproveReset = vi.fn();
const mockRejectReset = vi.fn();

vi.mock('@/lib/api', () => ({
  useIssueDrafts: (...a: unknown[]) => mockUseIssueDrafts(...a),
  useEditIssueDraft: () => ({
    mutate: mockEditMutate,
    reset: mockEditReset,
    isPending: false,
    error: null,
  }),
  useApproveIssueDraft: () => ({
    mutate: mockApproveMutate,
    reset: mockApproveReset,
    isPending: false,
    error: null,
  }),
  useRejectIssueDraft: () => ({
    mutate: mockRejectMutate,
    reset: mockRejectReset,
    isPending: false,
    error: null,
  }),
}));

import { IssueTriage } from './IssueTriage';

// ─── Test data ──────────────────────────────────────────────────

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    repositoryId: 7,
    issueNumber: 42,
    issueTitle: 'App crashes on startup',
    status: 'DRAFT' as const,
    draftKind: 'ANALYSIS' as const,
    body: 'Root cause: null deref in init().',
    sources: [],
    dedupMatches: [],
    tokensUsed: 0,
    postedCommentId: null,
    createdAt: '2026-01-15T10:30:00Z',
    updatedAt: '2026-01-15T10:30:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <IssueTriage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseIssueDrafts.mockReturnValue({ data: [makeDraft()], isLoading: false, isError: false });
});

// ─── List ───────────────────────────────────────────────────────

describe('IssueTriage list', () => {
  it('renders drafts in the table', () => {
    renderPage();
    expect(screen.getByText('App crashes on startup')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    mockUseIssueDrafts.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderPage();
    expect(screen.queryByText('App crashes on startup')).not.toBeInTheDocument();
  });

  it('shows empty state', () => {
    mockUseIssueDrafts.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.getByText('No drafts found.')).toBeInTheDocument();
  });

  it('shows error state', () => {
    mockUseIssueDrafts.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderPage();
    expect(screen.getByText(/Failed to load drafts/)).toBeInTheDocument();
  });
});

// ─── Detail + interactions ──────────────────────────────────────

describe('IssueTriage detail', () => {
  it('opens the detail panel on row click and shows the editable body', () => {
    renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    const textarea = screen.getByLabelText('Edit comment body') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Root cause: null deref in init().');
  });

  it('saves an edited body via useEditIssueDraft', () => {
    renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    const textarea = screen.getByLabelText('Edit comment body');
    fireEvent.change(textarea, { target: { value: 'Edited body' } });
    fireEvent.click(screen.getByText('Save edits'));
    expect(mockEditMutate).toHaveBeenCalledWith({ id: 9, body: 'Edited body' }, expect.any(Object));
  });

  it('approves through the confirm dialog (calls approve mutate)', () => {
    renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    fireEvent.click(screen.getByText('Approve & post'));
    // Confirm dialog appears; click its confirm button.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('Approve & post'));
    expect(mockApproveMutate).toHaveBeenCalledWith({ id: 9 }, expect.any(Object));
  });

  it('rejects through the confirm dialog (calls reject mutate, never approve)', () => {
    renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    fireEvent.click(screen.getByText('Reject'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('Reject'));
    expect(mockRejectMutate).toHaveBeenCalledWith({ id: 9 }, expect.any(Object));
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });

  it('a decided (POSTED) draft is read-only — no edit/approve/reject controls', () => {
    mockUseIssueDrafts.mockReturnValue({
      data: [makeDraft({ status: 'POSTED', postedCommentId: 1 })],
      isLoading: false,
      isError: false,
    });
    renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    expect(screen.queryByLabelText('Edit comment body')).not.toBeInTheDocument();
    expect(screen.queryByText('Approve & post')).not.toBeInTheDocument();
  });

  it('renders an injection-laden body as PLAIN TEXT (no HTML injection)', () => {
    const evil = '<img src=x onerror=alert(1)>**not bold**';
    mockUseIssueDrafts.mockReturnValue({
      data: [makeDraft({ body: evil })],
      isLoading: false,
      isError: false,
    });
    const { container } = renderPage();
    fireEvent.click(screen.getByText('App crashes on startup'));
    // The body lives in a textarea value verbatim — never parsed as HTML, so no
    // <img> element is created from the untrusted string.
    const textarea = screen.getByLabelText('Edit comment body') as HTMLTextAreaElement;
    expect(textarea.value).toBe(evil);
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
