/**
 * Minimal delegated CI run history component (MVP placeholder).
 * Displays runs in a simple table using the useDelegatedCiRuns hook.
 */

import { useDelegatedCiRuns } from '@/lib/api';
import { useSelectedRepo } from '@/lib/repo-context';
import type { DelegatedCiRunView } from '@/lib/types';
import { Card, CardHeader } from './Card';

const STATE_STYLES: Record<string, string> = {
  completed: 'bg-green-500/20 text-green-400',
  running: 'bg-blue-500/20 text-blue-400',
  dispatched: 'bg-blue-500/20 text-blue-300',
  approved: 'bg-yellow-500/20 text-yellow-400',
  failed: 'bg-red-500/20 text-red-400',
  rejected: 'bg-red-500/20 text-red-300',
  timed_out: 'bg-orange-500/20 text-orange-400',
};

function StateBadge({ state }: { state: DelegatedCiRunView['state'] }) {
  const style = STATE_STYLES[state] ?? 'bg-surface-border text-text-muted';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {state.replace('_', ' ')}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function DelegatedCiRuns() {
  const { selectedRepo } = useSelectedRepo();
  const { data, isLoading, isError } = useDelegatedCiRuns(selectedRepo);

  if (!selectedRepo) {
    return null;
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader title="Delegated CI Runs" />
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader title="Delegated CI Runs" />
        <p className="text-sm text-red-400">Failed to load delegated CI runs.</p>
      </Card>
    );
  }

  const runs = data?.runs ?? [];

  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Delegated CI Runs"
          description="No delegated CI runs yet for this repository"
        />
        <p className="text-sm text-text-muted">
          Delegated CI runs will appear here once a policy is configured and jobs are triggered.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="none">
      <div className="p-6 pb-0">
        <CardHeader
          title="Delegated CI Runs"
          description={`${data?.total ?? runs.length} total run${(data?.total ?? runs.length) !== 1 ? 's' : ''}`}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y border-surface-border bg-surface-bg text-xs uppercase text-text-muted">
            <tr>
              <th className="px-4 py-2">Job</th>
              <th className="px-4 py-2">PR</th>
              <th className="px-4 py-2">State</th>
              <th className="px-4 py-2">Profile</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {runs.map((run) => (
              <tr key={run.id} className="text-text-secondary hover:bg-surface-bg/50">
                <td className="px-4 py-2.5 font-medium text-text-primary">{run.jobKey}</td>
                <td className="px-4 py-2.5">{run.prNumber ? `#${run.prNumber}` : '—'}</td>
                <td className="px-4 py-2.5">
                  <StateBadge state={run.state} />
                </td>
                <td className="px-4 py-2.5">
                  <code className="rounded bg-surface-bg px-1.5 py-0.5 text-xs">{run.profile}</code>
                </td>
                <td className="px-4 py-2.5 text-text-muted">{formatDate(run.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
