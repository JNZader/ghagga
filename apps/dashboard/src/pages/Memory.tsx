import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ObservationDetailModal } from '@/components/ObservationDetailModal';
import { SeverityBadge } from '@/components/SeverityBadge';
import { useToast } from '@/components/Toast';
import {
  ApiError,
  useBatchDeleteObservations,
  useCleanupEmptySessions,
  useClearRepoMemory,
  useDeleteObservation,
  useDeleteSession,
  useMemorySessions,
  useObservations,
  usePurgeAllMemory,
  useRepositories,
} from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSelectedRepo } from '@/lib/repo-context';
import type { MemorySession, Observation } from '@/lib/types';
import { formatRelativeTime, isValidSeverity, severityWeight } from '@/lib/utils';

// ─── Constants ──────────────────────────────────────────────────

/** Max file path chips shown before "+N more" indicator */
const MAX_FILE_PATHS_SHOWN = 3;

type SortOption = 'newest' | 'oldest' | 'severity' | 'revisions';

const sortLabels: Record<SortOption, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  severity: 'Severity',
  revisions: 'Most revised',
};

// ─── Observation Type Config ────────────────────────────────────

const observationTypeConfig: Record<Observation['type'], { label: string; classes: string }> = {
  pattern: {
    label: 'Pattern',
    classes: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  },
  bugfix: {
    label: 'Bug Fix',
    classes: 'bg-red-500/15 text-red-400 border-red-500/25',
  },
  learning: {
    label: 'Learning',
    classes: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  },
  decision: {
    label: 'Decision',
    classes: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  },
  architecture: {
    label: 'Architecture',
    classes: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
  },
  config: {
    label: 'Config',
    classes: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  },
  discovery: {
    label: 'Discovery',
    classes: 'bg-green-500/15 text-green-400 border-green-500/25',
  },
};

// ─── Sub-components ─────────────────────────────────────────────

function TypeBadge({ type }: { type: Observation['type'] }) {
  const config = observationTypeConfig[type];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        config.classes,
      )}
    >
      {config.label}
    </span>
  );
}

function SessionItem({
  session,
  isActive,
  onClick,
  onDelete,
  isMutating,
}: {
  session: MemorySession;
  isActive: boolean;
  onClick: () => void;
  onDelete: (session: MemorySession) => void;
  isMutating: boolean;
}) {
  const hasSeverityCounts =
    session.criticalCount > 0 || session.highCount > 0 || session.mediumCount > 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative w-full rounded-lg border px-4 py-3 text-left transition-colors',
        isActive
          ? 'border-primary-500/50 bg-primary-600/10'
          : 'border-surface-border bg-surface-card hover:bg-surface-hover',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-primary-400">PR #{session.prNumber}</span>
          {session.prNumber > 0 && (
            <a
              href={`https://github.com/${session.project}/pull/${session.prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-text-muted underline-offset-2 hover:text-primary-400 hover:underline"
              title={`Open PR #${session.prNumber} on GitHub`}
            >
              <LinkIcon className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">{session.observationCount} obs</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onDelete(session);
              }
            }}
            title="Delete session"
            aria-label="Delete session"
            className={cn(
              'rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100',
              isMutating && 'pointer-events-none opacity-50',
            )}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>

      {/* Severity summary chips */}
      {hasSeverityCounts && (
        <div className="mt-1.5 flex items-center gap-1.5" data-testid="session-severity-summary">
          {session.criticalCount > 0 && (
            <span className="rounded-full bg-red-600/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              {session.criticalCount} critical
            </span>
          )}
          {session.highCount > 0 && (
            <span className="rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">
              {session.highCount} high
            </span>
          )}
          {session.mediumCount > 0 && (
            <span className="rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
              {session.mediumCount} medium
            </span>
          )}
        </div>
      )}

      <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{session.summary}</p>
      <p className="mt-1 text-xs text-text-muted">
        {new Date(session.createdAt).toLocaleDateString()}
      </p>
    </button>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4', className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
      />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4', className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-5 w-5', className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    </svg>
  );
}

function ObservationCard({
  observation,
  onDelete,
  onClick,
  isDeleting,
  isSelected,
  onToggleSelect,
}: {
  observation: Observation;
  onDelete: (obs: Observation) => void;
  onClick: (obs: Observation) => void;
  isDeleting: boolean;
  isSelected?: boolean;
  onToggleSelect?: (obs: Observation) => void;
}) {
  const visiblePaths = observation.filePaths.slice(0, MAX_FILE_PATHS_SHOWN);
  const extraPathCount = observation.filePaths.length - MAX_FILE_PATHS_SHOWN;

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary-500/30">
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="relative flex items-start gap-3" onClick={() => onClick(observation)}>
        {onToggleSelect && (
          <div className="flex items-start pt-0.5">
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={() => onToggleSelect(observation)}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded-sm border-surface-border"
              aria-label={`Select observation: ${observation.title}`}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <TypeBadge type={observation.type} />
          {isValidSeverity(observation.severity) && (
            <SeverityBadge severity={observation.severity} />
          )}
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-medium text-text-primary">{observation.title}</h4>
          <p className="mt-2 whitespace-pre-wrap font-mono text-sm text-text-secondary line-clamp-4">
            {observation.content}
          </p>
          {observation.filePaths.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {visiblePaths.map((path: string) => (
                <span
                  key={path}
                  className="rounded-sm bg-surface-bg px-2 py-1 font-mono text-xs text-text-secondary"
                >
                  {path}
                </span>
              ))}
              {extraPathCount > 0 && (
                <span className="rounded-sm bg-surface-bg px-2 py-1 text-xs text-text-muted">
                  +{extraPathCount} more
                </span>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
            <span title={new Date(observation.createdAt).toLocaleString()}>
              {formatRelativeTime(observation.createdAt)}
            </span>
            {observation.revisionCount > 1 && (
              <span className="rounded-full border border-surface-border bg-surface-bg px-1.5 py-0.5 text-[10px]">
                {observation.revisionCount} revisions
              </span>
            )}
          </div>
        </div>

        {/* Delete button (top-right) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(observation);
          }}
          disabled={isDeleting}
          title="Delete observation"
          aria-label={`Delete observation: ${observation.title}`}
          className="absolute right-0 top-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
        >
          <TrashIcon />
        </button>
      </div>
    </Card>
  );
}

// ─── Stats Bar ──────────────────────────────────────────────────

function StatsBar({ observations }: { observations: Observation[] }) {
  const stats = useMemo(() => {
    const total = observations.length;
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const obs of observations) {
      if (obs.severity) {
        bySeverity[obs.severity] = (bySeverity[obs.severity] ?? 0) + 1;
      }
      byType[obs.type] = (byType[obs.type] ?? 0) + 1;
    }

    return { total, bySeverity, byType };
  }, [observations]);

  if (stats.total === 0) return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-surface-border bg-surface-card px-4 py-3"
      data-testid="stats-bar"
    >
      <span className="text-sm font-medium text-text-primary">
        {stats.total} observation{stats.total !== 1 ? 's' : ''}
      </span>
      <span className="text-surface-border">|</span>
      {/* Severity chips */}
      {Object.entries(stats.bySeverity)
        .sort(([a], [b]) => severityWeight(b) - severityWeight(a))
        .map(([severity, _count]) =>
          isValidSeverity(severity) ? (
            <SeverityBadge key={severity} severity={severity} className="gap-1" />
          ) : null,
        )
        .filter(Boolean).length > 0 && (
        <>
          {Object.entries(stats.bySeverity)
            .sort(([a], [b]) => severityWeight(b) - severityWeight(a))
            .map(([severity, count]) =>
              isValidSeverity(severity) ? (
                <span
                  key={severity}
                  className="inline-flex items-center gap-1 text-xs text-text-muted"
                >
                  <SeverityBadge severity={severity} />
                  <span>{count}</span>
                </span>
              ) : null,
            )}
          <span className="text-surface-border">|</span>
        </>
      )}
      {/* Type chips */}
      {Object.entries(stats.byType).map(([type, count]) => {
        const config = observationTypeConfig[type as Observation['type']];
        if (!config) return null;
        return (
          <span key={type} className="inline-flex items-center gap-1 text-xs text-text-muted">
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                config.classes,
              )}
            >
              {config.label}
            </span>
            <span>{count}</span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Virtualized Observation List ────────────────────────────────

/** Estimated height of a single ObservationCard in pixels */
const OBSERVATION_CARD_HEIGHT_ESTIMATE = 160;

/** Only virtualize when the list exceeds this threshold */
const VIRTUALIZATION_THRESHOLD = 20;

function VirtualizedObservationList({
  observations,
  onDelete,
  onClick,
  isDeleting,
  selectedIds,
  onToggleSelect,
}: {
  observations: Observation[];
  onDelete: (obs: Observation) => void;
  onClick: (obs: Observation) => void;
  isDeleting: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (obs: Observation) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const shouldVirtualize = observations.length > VIRTUALIZATION_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: observations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => OBSERVATION_CARD_HEIGHT_ESTIMATE,
    overscan: 5,
    enabled: shouldVirtualize,
  });

  // For small lists, render all items directly (also works in jsdom tests)
  if (!shouldVirtualize) {
    return (
      <div
        className="space-y-4"
        data-testid="observation-list"
        role="list"
        aria-label="Observations"
      >
        {observations.map((obs) => (
          <div key={obs.id} role="listitem">
            <ObservationCard
              observation={obs}
              onDelete={onDelete}
              onClick={onClick}
              isDeleting={isDeleting}
              isSelected={selectedIds?.has(obs.id)}
              onToggleSelect={onToggleSelect}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      data-testid="virtualized-observation-list"
      className="max-h-[70vh] overflow-y-auto"
      role="list"
      aria-label="Observations"
    >
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const obs = observations[virtualItem.index];
          return (
            <div
              key={obs.id}
              role="listitem"
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-4"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <ObservationCard
                observation={obs}
                onDelete={onDelete}
                onClick={onClick}
                isDeleting={isDeleting}
                isSelected={selectedIds?.has(obs.id)}
                onToggleSelect={onToggleSelect}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Hooks ──────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return error.message || 'Not found — it may have already been deleted.';
    return error.message || 'An error occurred';
  }
  if (error instanceof Error) {
    if (error.message.includes('fetch') || error.message.includes('network'))
      return 'Network error. Please check your connection and try again.';
    return error.message;
  }
  return 'An unexpected error occurred';
}

// ─── Main Component ─────────────────────────────────────────────

export function Memory() {
  const { selectedRepo, setSelectedRepo } = useSelectedRepo();
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const { addToast } = useToast();

  // ── Filter & sort state ───────────────────────────────────────
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('newest');

  // ── Data queries ──────────────────────────────────────────────
  const { data: repos } = useRepositories();
  const { data: sessions, isLoading: sessionsLoading } = useMemorySessions(selectedRepo);
  const { data: observations, isLoading: observationsLoading } = useObservations(
    selectedSessionId ?? 0,
  );

  // ── Selection state for batch delete ──────────────────────────
  const [selectedObsIds, setSelectedObsIds] = useState<Set<number>>(new Set());
  const [showBatchDeleteObsDialog, setShowBatchDeleteObsDialog] = useState(false);

  // ── Mutations ─────────────────────────────────────────────────
  const deleteObservation = useDeleteObservation();
  const batchDeleteObservations = useBatchDeleteObservations();
  const clearRepoMemory = useClearRepoMemory();
  const purgeAllMemory = usePurgeAllMemory();
  const deleteSession = useDeleteSession();
  const cleanupEmptySessions = useCleanupEmptySessions();

  const isMutating =
    deleteObservation.isPending ||
    batchDeleteObservations.isPending ||
    clearRepoMemory.isPending ||
    purgeAllMemory.isPending ||
    deleteSession.isPending ||
    cleanupEmptySessions.isPending;

  // ── Dialog state ──────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<Observation | null>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<MemorySession | null>(null);
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // ── Detail modal state ────────────────────────────────────────
  const [selectedObservation, setSelectedObservation] = useState<Observation | null>(null);

  // Reset session when repo changes
  const prevRepo = useRef(selectedRepo);
  useEffect(() => {
    if (prevRepo.current !== selectedRepo) {
      setSelectedSessionId(null);
      prevRepo.current = selectedRepo;
    }
  }, [selectedRepo]);

  // ── Clear observation selection on filter/session changes ─────
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset selection when filter values change
  useEffect(() => {
    setSelectedObsIds(new Set());
  }, [selectedSessionId, severityFilter, sortOption, search]);

  // ── Computed values ───────────────────────────────────────────
  const totalObservationCount = sessions?.reduce((sum, s) => sum + s.observationCount, 0) ?? 0;

  const hasEmptySessions = sessions?.some((s) => s.observationCount === 0) ?? false;

  // Filter observations by search + severity
  const filteredObservations = useMemo(() => {
    let filtered = observations ?? [];

    // Text search filter
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      filtered = filtered.filter(
        (obs) =>
          obs.title.toLowerCase().includes(q) ||
          obs.content.toLowerCase().includes(q) ||
          obs.type.toLowerCase().includes(q) ||
          obs.filePaths.some((p: string) => p.toLowerCase().includes(q)),
      );
    }

    // Severity filter
    if (severityFilter !== 'all') {
      filtered = filtered.filter((obs) => obs.severity === severityFilter);
    }

    // Sort
    const sorted = [...filtered];
    switch (sortOption) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case 'severity':
        sorted.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity));
        break;
      case 'revisions':
        sorted.sort((a, b) => b.revisionCount - a.revisionCount);
        break;
    }

    return sorted;
  }, [observations, debouncedSearch, severityFilter, sortOption]);

  // Filter sessions by search
  const filteredSessions = sessions?.filter((session) => {
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return session.summary.toLowerCase().includes(q) || String(session.prNumber).includes(q);
  });

  // ── Selection helpers ─────────────────────────────────────────
  const allObsSelected =
    filteredObservations.length > 0 &&
    filteredObservations.every((obs) => selectedObsIds.has(obs.id));
  const someObsSelected =
    filteredObservations.some((obs) => selectedObsIds.has(obs.id)) && !allObsSelected;

  function toggleSelectAllObs() {
    if (allObsSelected) {
      setSelectedObsIds(new Set());
    } else {
      setSelectedObsIds(new Set(filteredObservations.map((obs) => obs.id)));
    }
  }

  function toggleSelectOneObs(obs: Observation) {
    setSelectedObsIds((prev) => {
      const next = new Set(prev);
      if (next.has(obs.id)) {
        next.delete(obs.id);
      } else {
        next.add(obs.id);
      }
      return next;
    });
  }

  // ── Handlers ──────────────────────────────────────────────────

  function handleBatchDeleteObservations() {
    batchDeleteObservations.mutate(
      { ids: Array.from(selectedObsIds) },
      {
        onSuccess: (data) => {
          setShowBatchDeleteObsDialog(false);
          setSelectedObsIds(new Set());
          addToast({
            message: `Deleted ${data.deletedCount} observation${data.deletedCount === 1 ? '' : 's'}`,
            type: 'success',
          });
        },
        onError: (error) => {
          setDialogError(getErrorMessage(error));
        },
      },
    );
  }

  function handleDeleteObservation() {
    if (!deleteTarget) return;
    setDialogError(null);

    deleteObservation.mutate(
      { observationId: deleteTarget.id },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          addToast({ message: 'Observation deleted', type: 'success' });
        },
        onError: (error) => {
          setDialogError(getErrorMessage(error));
        },
      },
    );
  }

  function handleClearRepo() {
    if (!selectedRepo) return;
    setDialogError(null);

    clearRepoMemory.mutate(
      { project: selectedRepo },
      {
        onSuccess: (data) => {
          setShowClearDialog(false);
          addToast({
            message: `Cleared ${data.cleared} observations from ${selectedRepo}`,
            type: 'success',
          });
        },
        onError: (error) => {
          setDialogError(getErrorMessage(error));
        },
      },
    );
  }

  function handlePurgeAll() {
    setDialogError(null);

    purgeAllMemory.mutate(undefined, {
      onSuccess: (data) => {
        setShowPurgeDialog(false);
        addToast({
          message: `Purged ${data.cleared} observations from all repositories`,
          type: 'success',
          duration: 5000,
        });
      },
      onError: (error) => {
        setDialogError(getErrorMessage(error));
      },
    });
  }

  function handleDeleteSession() {
    if (!deleteSessionTarget) return;
    setDialogError(null);

    deleteSession.mutate(
      { sessionId: deleteSessionTarget.id },
      {
        onSuccess: () => {
          const deletedId = deleteSessionTarget.id;
          setDeleteSessionTarget(null);
          if (selectedSessionId === deletedId) {
            setSelectedSessionId(null);
          }
          addToast({ message: 'Session deleted', type: 'success' });
        },
        onError: (error) => {
          setDialogError(getErrorMessage(error));
        },
      },
    );
  }

  function handleCleanupEmptySessions() {
    setDialogError(null);

    cleanupEmptySessions.mutate(
      { project: selectedRepo || undefined },
      {
        onSuccess: (data) => {
          setShowCleanupDialog(false);
          addToast({
            message: `Removed ${data.deletedCount} empty session${data.deletedCount === 1 ? '' : 's'}`,
            type: 'success',
          });
        },
        onError: (error) => {
          setDialogError(getErrorMessage(error));
        },
      },
    );
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Memory</h1>
          <p className="mt-1 text-text-secondary">Browse learned patterns and observations</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Clear Memory button (Tier 2) — visible when repo selected */}
          {selectedRepo && (
            <button
              onClick={() => {
                setDialogError(null);
                setShowClearDialog(true);
              }}
              disabled={isMutating}
              className="flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              <TrashIcon />
              Clear Memory
            </button>
          )}

          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="select-field w-64"
          >
            <option value="">Select a repository</option>
            {repos?.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!selectedRepo ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 text-5xl">🧠</div>
          <h2 className="mb-2 text-xl font-semibold text-text-primary">Select a Repository</h2>
          <p className="max-w-md text-text-secondary">
            Choose a repository to browse memory sessions and observations learned from past
            reviews.
          </p>
        </div>
      ) : (
        <>
          {/* Search + Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search sessions and observations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field w-full max-w-md"
            />
            {selectedSessionId && (
              <>
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="select-field"
                  aria-label="Filter by severity"
                >
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="info">Info</option>
                </select>
                <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as SortOption)}
                  className="select-field"
                  aria-label="Sort observations"
                >
                  {(Object.entries(sortLabels) as [SortOption, string][]).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="flex gap-6">
            {/* Sessions sidebar */}
            <div className="w-72 shrink-0 space-y-2">
              {hasEmptySessions && (
                <button
                  onClick={() => {
                    setDialogError(null);
                    setShowCleanupDialog(true);
                  }}
                  disabled={isMutating}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-primary-500/30 hover:text-primary-400 disabled:opacity-50"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  Clean up empty sessions
                </button>
              )}
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
                </div>
              ) : (filteredSessions?.length ?? 0) === 0 ? (
                <p className="py-8 text-center text-sm text-text-secondary">
                  No memory stored for this repository.
                </p>
              ) : (
                filteredSessions?.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={selectedSessionId === session.id}
                    onClick={() => setSelectedSessionId(session.id)}
                    onDelete={(s) => {
                      setDialogError(null);
                      setDeleteSessionTarget(s);
                    }}
                    isMutating={isMutating}
                  />
                ))
              )}
            </div>

            {/* Observations main area */}
            <div className="flex-1">
              {!selectedSessionId ? (
                <div className="flex items-center justify-center py-20 text-center">
                  <p className="text-text-secondary">
                    Select a session from the left to view its observations.
                  </p>
                </div>
              ) : observationsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
                </div>
              ) : filteredObservations.length === 0 ? (
                <div className="flex items-center justify-center py-20 text-center">
                  <p className="text-text-secondary">No observations in this session.</p>
                </div>
              ) : (
                <>
                  {/* Select-all + batch delete bar */}
                  <div className="mb-4 flex items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
                      <input
                        type="checkbox"
                        checked={allObsSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someObsSelected;
                        }}
                        onChange={toggleSelectAllObs}
                        className="h-4 w-4 rounded-sm border-surface-border"
                        aria-label="Select all observations"
                      />
                      Select all
                    </label>
                    {selectedObsIds.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowBatchDeleteObsDialog(true)}
                        className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                      >
                        Delete Selected ({selectedObsIds.size})
                      </button>
                    )}
                  </div>
                  <StatsBar observations={filteredObservations} />
                  <VirtualizedObservationList
                    observations={filteredObservations}
                    onDelete={(o) => {
                      setDialogError(null);
                      setDeleteTarget(o);
                    }}
                    onClick={(o) => setSelectedObservation(o)}
                    isDeleting={isMutating}
                    selectedIds={selectedObsIds}
                    onToggleSelect={toggleSelectOneObs}
                  />
                </>
              )}
            </div>
          </div>

          {/* Danger Zone — Purge All Memory (Tier 3) */}
          <div className="mt-12 rounded-lg border border-red-500/30 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <WarningIcon className="text-red-400" />
                <div>
                  <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
                  <p className="text-sm text-text-secondary">
                    Permanently delete all memory across all repositories.
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setDialogError(null);
                  setShowPurgeDialog(true);
                }}
                disabled={isMutating}
                className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                <WarningIcon className="h-4 w-4" />
                Purge All Memory
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Observation detail modal ───────────────────────────── */}
      <ObservationDetailModal
        observation={selectedObservation}
        onClose={() => setSelectedObservation(null)}
      />

      {/* ── Tier 1: Delete single observation ──────────────────── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={handleDeleteObservation}
        onCancel={() => {
          if (!deleteObservation.isPending) {
            setDeleteTarget(null);
            setDialogError(null);
          }
        }}
        title="Delete observation"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.title}"? This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={deleteObservation.isPending}
        error={dialogError}
      />

      {/* ── Tier 2: Clear repo memory ─────────────────────────── */}
      <ConfirmDialog
        open={showClearDialog}
        onConfirm={handleClearRepo}
        onCancel={() => {
          if (!clearRepoMemory.isPending) {
            setShowClearDialog(false);
            setDialogError(null);
          }
        }}
        title={`Clear all memory for ${selectedRepo}`}
        description={`This will delete all ${totalObservationCount} observations for this repository. This action cannot be undone.`}
        confirmLabel="Clear Memory"
        confirmVariant="danger"
        confirmText={selectedRepo}
        confirmPlaceholder={`Type "${selectedRepo}" to confirm`}
        isLoading={clearRepoMemory.isPending}
        error={dialogError}
      />

      {/* ── Tier 3: Purge all memory ──────────────────────────── */}
      <ConfirmDialog
        open={showPurgeDialog}
        onConfirm={handlePurgeAll}
        onCancel={() => {
          if (!purgeAllMemory.isPending) {
            setShowPurgeDialog(false);
            setDialogError(null);
          }
        }}
        title="Purge all memory"
        description={`This will permanently delete ALL ${totalObservationCount} observations across ALL your repositories. This action cannot be undone.`}
        confirmLabel="Purge All"
        confirmVariant="danger"
        confirmText="DELETE ALL"
        confirmPlaceholder='Type "DELETE ALL" to confirm'
        countdownSeconds={5}
        isLoading={purgeAllMemory.isPending}
        error={dialogError}
      />

      {/* ── Delete session ─────────────────────────────────────── */}
      <ConfirmDialog
        open={deleteSessionTarget !== null}
        onConfirm={handleDeleteSession}
        onCancel={() => {
          if (!deleteSession.isPending) {
            setDeleteSessionTarget(null);
            setDialogError(null);
          }
        }}
        title="Delete session"
        description={
          deleteSessionTarget
            ? deleteSessionTarget.observationCount > 0
              ? `This will delete the session for PR #${deleteSessionTarget.prNumber} and its ${deleteSessionTarget.observationCount} observation${deleteSessionTarget.observationCount === 1 ? '' : 's'}. This cannot be undone.`
              : `Delete empty session for PR #${deleteSessionTarget.prNumber}?`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmText={
          deleteSessionTarget && deleteSessionTarget.observationCount > 0
            ? `PR #${deleteSessionTarget.prNumber}`
            : undefined
        }
        confirmPlaceholder={
          deleteSessionTarget && deleteSessionTarget.observationCount > 0
            ? `Type "PR #${deleteSessionTarget.prNumber}" to confirm`
            : undefined
        }
        isLoading={deleteSession.isPending}
        error={dialogError}
      />

      {/* ── Cleanup empty sessions ─────────────────────────────── */}
      <ConfirmDialog
        open={showCleanupDialog}
        onConfirm={handleCleanupEmptySessions}
        onCancel={() => {
          if (!cleanupEmptySessions.isPending) {
            setShowCleanupDialog(false);
            setDialogError(null);
          }
        }}
        title="Clean up empty sessions"
        description="Remove all sessions that have no observations. This cannot be undone."
        confirmLabel="Clean Up"
        confirmVariant="danger"
        isLoading={cleanupEmptySessions.isPending}
        error={dialogError}
      />

      {/* ── Batch Delete Selected Observations (Tier 1) ────────── */}
      <ConfirmDialog
        open={showBatchDeleteObsDialog}
        title={`Delete ${selectedObsIds.size} observation${selectedObsIds.size === 1 ? '' : 's'}?`}
        description="This will permanently delete the selected observations. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={batchDeleteObservations.isPending}
        error={dialogError}
        onConfirm={handleBatchDeleteObservations}
        onCancel={() => {
          if (!batchDeleteObservations.isPending) {
            setShowBatchDeleteObsDialog(false);
            setDialogError(null);
          }
        }}
      />
    </div>
  );
}
