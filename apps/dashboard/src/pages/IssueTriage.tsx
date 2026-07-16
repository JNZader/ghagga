import { useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import {
  useApproveIssueDraft,
  useEditIssueDraft,
  useIssueDrafts,
  useRejectIssueDraft,
} from '@/lib/api';
import { cn } from '@/lib/cn';
import { ISSUE_DRAFT_STATUSES, type IssueDraft, type IssueDraftStatus } from '@/lib/types';

// ─── Draft status badge ─────────────────────────────────────────
// Local (not the shared StatusBadge, which is typed to ReviewStatus).

const STATUS_STYLES: Record<IssueDraftStatus, string> = {
  DRAFT: 'bg-amber-500/15 text-amber-400',
  APPROVED: 'bg-primary-600/15 text-primary-400',
  POSTED: 'bg-green-500/15 text-green-400',
  REJECTED: 'bg-red-500/15 text-red-400',
};

// APPROVED is a TRANSIENT "posting in progress" lock (the server claims the
// draft DRAFT→APPROVED before calling GitHub, then resolves it to POSTED or back
// to DRAFT on failure). It is NOT an actionable, stuck state — surface it as
// "Posting…" so a maintainer doesn't treat it as a draft awaiting a decision.
const STATUS_LABELS: Record<IssueDraftStatus, string> = {
  DRAFT: 'DRAFT',
  APPROVED: 'POSTING…',
  POSTED: 'POSTED',
  REJECTED: 'REJECTED',
};

function DraftStatusBadge({ status }: { status: IssueDraftStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function KindBadge({ kind }: { kind: IssueDraft['draftKind'] }) {
  return (
    <span className="inline-flex items-center rounded-full bg-surface-hover px-2.5 py-0.5 text-xs font-medium text-text-secondary">
      {kind}
    </span>
  );
}

// ─── Detail / edit / approve / reject panel ─────────────────────

interface DraftDetailProps {
  draft: IssueDraft;
  onClose: () => void;
  // Called after a successful edit-save with the persisted body, so the parent
  // can sync its `selected` draft. Without this the local `draft.body` stays at
  // the pre-save value, `bodyDirty` never clears, and the Save button re-fires
  // an identical PATCH (REL-001).
  onSaved: (body: string) => void;
}

function DraftDetail({ draft, onClose, onSaved }: DraftDetailProps) {
  // Local editable copy of the body. SECURITY: this is rendered/edited as PLAIN
  // TEXT only — the draft body is derived from UNTRUSTED issue text (the model's
  // analysis of a user-authored issue), so it MUST NOT be rendered as HTML.
  // There is no dangerouslySetInnerHTML and no markdown→HTML step anywhere on
  // this path; the body shows in a <textarea> (edit) and a <p whitespace-pre-wrap>
  // (read), exactly the safe path Reviews.tsx uses for review.summary.
  const [body, setBody] = useState(draft.body);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  const { addToast } = useToast();
  const editDraft = useEditIssueDraft();
  const approveDraft = useApproveIssueDraft();
  const rejectDraft = useRejectIssueDraft();

  // Reset the editable body whenever a different draft is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on draft identity change
  useEffect(() => {
    setBody(draft.body);
  }, [draft.id]);

  const isDecided = draft.status !== 'DRAFT';
  const bodyDirty = body !== draft.body;
  const busy = editDraft.isPending || approveDraft.isPending || rejectDraft.isPending;

  function handleSave() {
    editDraft.mutate(
      { id: draft.id, body },
      {
        onSuccess: () => {
          // Sync the parent's draft to the saved body so `bodyDirty` clears and
          // the Save button disables — a second click can't re-PATCH (REL-001).
          onSaved(body);
          addToast({ message: 'Draft saved', type: 'success' });
        },
        onError: (e) => addToast({ message: e.message, type: 'error' }),
      },
    );
  }

  function handleApprove() {
    // If the body was edited but not saved, persist it first so the posted
    // comment reflects what the maintainer sees.
    const post = () =>
      approveDraft.mutate(
        { id: draft.id },
        {
          onSuccess: () => {
            setShowApprove(false);
            addToast({ message: 'Draft approved and posted', type: 'success' });
            onClose();
          },
          onError: (e) => {
            setShowApprove(false);
            addToast({ message: e.message, type: 'error' });
          },
        },
      );

    if (bodyDirty) {
      // Persist the dirty edit FIRST, then post. If the PATCH fails we must NOT
      // proceed to approve and must NOT swallow the error — surface it and stop,
      // keeping the modal open so the maintainer sees what happened.
      editDraft.mutate(
        { id: draft.id, body },
        {
          onSuccess: post,
          onError: (e) => {
            setShowApprove(false);
            addToast({ message: e.message, type: 'error' });
          },
        },
      );
    } else {
      post();
    }
  }

  function handleReject() {
    rejectDraft.mutate(
      { id: draft.id },
      {
        onSuccess: () => {
          setShowReject(false);
          addToast({ message: 'Draft rejected', type: 'success' });
          onClose();
        },
        onError: (e) => {
          setShowReject(false);
          addToast({ message: e.message, type: 'error' });
        },
      },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <Card className="max-h-[85vh] w-full max-w-4xl overflow-y-auto" padding="lg">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <DraftStatusBadge status={draft.status} />
              <KindBadge kind={draft.draftKind} />
              <span className="text-sm text-text-secondary">Issue #{draft.issueNumber}</span>
            </div>
            <h2 className="mt-2 text-lg font-semibold text-text-primary">{draft.issueTitle}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              role="img"
            >
              <title>Close</title>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — editable (DRAFT) or read-only (decided). PLAIN TEXT only. */}
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-text-secondary">Comment body</h3>
          {isDecided ? (
            <p className="whitespace-pre-wrap rounded-lg border border-surface-border bg-surface-bg p-3 text-sm text-text-primary">
              {draft.body}
            </p>
          ) : (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="input-field w-full resize-y font-mono text-sm"
              aria-label="Edit comment body"
            />
          )}
        </div>

        {/* Dedup matches */}
        {draft.dedupMatches.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Possible duplicates</h3>
            <ul className="space-y-1 text-sm text-text-secondary">
              {draft.dedupMatches.map((m) => (
                <li key={m.observationId}>
                  {/* Titles are untrusted issue text → rendered as plain text. */}
                  <span className="text-text-primary">{m.title}</span>{' '}
                  <span className="text-text-muted">
                    (#{m.observationId}, overlap {m.score.toFixed(2)})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sources */}
        {draft.sources.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Sources</h3>
            <ul className="space-y-1 text-sm text-text-secondary">
              {draft.sources.map((s) => (
                <li key={`${s.type}-${s.ref}`}>
                  {/* Plain text — untrusted. */}
                  <span className="font-mono text-xs text-primary-400">{s.type}</span>{' '}
                  <span className="text-text-primary">{s.title}</span>{' '}
                  <span className="text-text-muted">{s.ref}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions (only for an open DRAFT) */}
        {!isDecided && (
          <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !bodyDirty}
              className="btn-secondary px-4 py-2 text-sm disabled:opacity-50"
            >
              Save edits
            </button>
            <button
              type="button"
              onClick={() => setShowReject(true)}
              disabled={busy}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setShowApprove(true)}
              disabled={busy}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
            >
              Approve &amp; post
            </button>
          </div>
        )}

        <ConfirmDialog
          open={showApprove}
          title="Approve and post comment?"
          description={`This posts the comment to issue #${draft.issueNumber} on GitHub. This cannot be undone.`}
          confirmLabel="Approve & post"
          isLoading={approveDraft.isPending || editDraft.isPending}
          error={approveDraft.error?.message ?? null}
          onConfirm={handleApprove}
          onCancel={() => {
            setShowApprove(false);
            approveDraft.reset();
          }}
        />

        <ConfirmDialog
          open={showReject}
          title="Reject this draft?"
          description="The draft is discarded and no comment is posted."
          confirmLabel="Reject"
          confirmVariant="danger"
          isLoading={rejectDraft.isPending}
          error={rejectDraft.error?.message ?? null}
          onConfirm={handleReject}
          onCancel={() => {
            setShowReject(false);
            rejectDraft.reset();
          }}
        />
      </Card>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────

export function IssueTriage() {
  const [statusFilter, setStatusFilter] = useState<IssueDraftStatus | ''>('DRAFT');
  const [selected, setSelected] = useState<IssueDraft | null>(null);

  const { data, isLoading, isError } = useIssueDrafts(statusFilter || undefined);
  const drafts = data ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Issue Triage</h1>
        <p className="mt-1 text-text-secondary">
          Review, edit, and approve AI-drafted issue replies before they post.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as IssueDraftStatus | '')}
          className="select-field w-44"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {ISSUE_DRAFT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border text-left">
                <th className="px-6 py-3 font-medium text-text-secondary">Status</th>
                <th className="px-6 py-3 font-medium text-text-secondary">Kind</th>
                <th className="px-6 py-3 font-medium text-text-secondary">Issue</th>
                <th className="px-6 py-3 font-medium text-text-secondary">Title</th>
                <th className="px-6 py-3 font-medium text-text-secondary">Created</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-red-400">
                    Failed to load drafts. Please try again.
                  </td>
                </tr>
              ) : drafts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-text-secondary">
                    No drafts found.
                  </td>
                </tr>
              ) : (
                drafts.map((draft) => (
                  <tr
                    key={draft.id}
                    onClick={() => setSelected(draft)}
                    className="cursor-pointer border-b border-surface-border/50 transition-colors hover:bg-surface-hover"
                  >
                    <td className="px-6 py-3">
                      <DraftStatusBadge status={draft.status} />
                    </td>
                    <td className="px-6 py-3">
                      <KindBadge kind={draft.draftKind} />
                    </td>
                    <td className="px-6 py-3 text-primary-400">#{draft.issueNumber}</td>
                    {/* Title is untrusted issue text → plain text cell. */}
                    <td className="max-w-md truncate px-6 py-3 text-text-primary">
                      {draft.issueTitle}
                    </td>
                    <td className="px-6 py-3 text-text-secondary">
                      {new Date(draft.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {selected && (
        <DraftDetail
          draft={selected}
          onClose={() => setSelected(null)}
          onSaved={(body) => setSelected((prev) => (prev ? { ...prev, body } : prev))}
        />
      )}
    </div>
  );
}
