import { cn } from '@/lib/cn';
import type { ReviewStatus } from '@/lib/types';

interface StatusBadgeProps {
  status: ReviewStatus;
  className?: string;
}

const statusConfig: Record<ReviewStatus, { label: string; classes: string }> = {
  PASSED: {
    label: 'Passed',
    classes: 'bg-green-500/15 text-green-400 border-green-500/25',
  },
  FAILED: {
    label: 'Failed',
    classes: 'bg-red-500/15 text-red-400 border-red-500/25',
  },
  NEEDS_HUMAN_REVIEW: {
    label: 'Needs Review',
    classes: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  },
  SKIPPED: {
    label: 'Skipped',
    classes: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  },
  PARTIAL: {
    label: 'Partial',
    classes: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  // Defense-in-depth: fall back to a neutral badge if the server returns an
  // unknown status (e.g. a new value added before the dashboard ships).
  const config = statusConfig[status] ?? {
    label: status,
    classes: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        config.classes,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
