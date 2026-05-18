import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/Card';
import { useRepositories, useStats } from '@/lib/api';
import { useSelectedRepo } from '@/lib/repo-context';
import type { Stats } from '@/lib/types';

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <Card>
      <p className="text-sm text-text-secondary">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${color}`}>{value}</p>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 text-5xl">📊</div>
      <h2 className="mb-2 text-xl font-semibold text-text-primary">No Data Yet</h2>
      <p className="max-w-md text-text-secondary">
        Select a repository above to view review statistics, or install GHAGGA on a repository to
        start reviewing PRs.
      </p>
    </div>
  );
}

function StatsOverview({ stats }: { stats: Stats }) {
  const passRate = stats.passRate ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total Reviews" value={stats.totalReviews ?? 0} color="text-text-primary" />
      <StatCard label="Passed" value={stats.passed ?? 0} color="text-green-400" />
      <StatCard label="Failed" value={stats.failed ?? 0} color="text-red-400" />
      <StatCard label="Pass Rate" value={`${passRate.toFixed(1)}%`} color="text-primary-400" />
    </div>
  );
}

function ReviewChart({ data }: { data: Stats['reviewsByDay'] }) {
  if (!data || data.length === 0) return null;

  return (
    <Card className="mt-6">
      <h3 className="mb-4 text-lg font-semibold text-text-primary">Reviews Over Time</h3>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="colorPassed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorFailed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
            <XAxis
              dataKey="date"
              stroke="#8b949e"
              tick={{ fill: '#8b949e', fontSize: 12 }}
              tickFormatter={(value: string) => {
                const d = new Date(value);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
            />
            <YAxis
              stroke="#8b949e"
              tick={{ fill: '#8b949e', fontSize: 12 }}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#161b22',
                border: '1px solid #30363d',
                borderRadius: '8px',
                color: '#e6edf3',
              }}
            />
            <Area
              type="monotone"
              dataKey="passed"
              stroke="#22c55e"
              fillOpacity={1}
              fill="url(#colorPassed)"
              name="Passed"
            />
            <Area
              type="monotone"
              dataKey="failed"
              stroke="#ef4444"
              fillOpacity={1}
              fill="url(#colorFailed)"
              name="Failed"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function Dashboard() {
  const { selectedRepo, setSelectedRepo } = useSelectedRepo();
  const { data: repos, isLoading: reposLoading } = useRepositories();
  const { data: stats, isLoading: statsLoading } = useStats(selectedRepo);

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
          <p className="mt-1 text-text-secondary">Overview of your code review activity</p>
        </div>

        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="select-field w-64"
          disabled={reposLoading}
        >
          <option value="">Select a repository</option>
          {repos?.map((repo) => (
            <option key={repo.id} value={repo.fullName}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </div>

      {/* Content */}
      {!selectedRepo ? (
        <EmptyState />
      ) : statsLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : stats ? (
        <>
          <StatsOverview stats={stats} />
          <ReviewChart data={stats.reviewsByDay ?? []} />
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
