import type {
  DelegatedCiClassification,
  DelegatedCiJobPolicy,
  DelegatedCiProfile,
} from '@/lib/types';

// ─── Types ──────────────────────────────────────────────────────

interface DelegatedCiJobEntryProps {
  index: number;
  job: DelegatedCiJobPolicy;
  onChange: (updated: DelegatedCiJobPolicy) => void;
  onRemove: () => void;
}

// ─── Options ────────────────────────────────────────────────────

const PROFILE_OPTIONS: { value: DelegatedCiProfile; label: string }[] = [
  { value: 'node-lint', label: 'Node.js Lint' },
  { value: 'node-unit', label: 'Node.js Unit Tests' },
  { value: 'python-lint', label: 'Python Lint' },
  { value: 'python-pytest', label: 'Python Pytest' },
  { value: 'go-test', label: 'Go Test' },
];

const CLASSIFICATION_OPTIONS: { value: DelegatedCiClassification; label: string }[] = [
  { value: 'safe/delegable', label: 'Safe / Delegable' },
  { value: 'sensitive/no-delegable', label: 'Sensitive / Not Delegable' },
];

// ─── Component ──────────────────────────────────────────────────

export function DelegatedCiJobEntry({ index, job, onChange, onRemove }: DelegatedCiJobEntryProps) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-bg/50 p-4">
      {/* Header: Index + Enabled toggle + Remove */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">
            {index + 1}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-3">
            <span className="text-sm text-text-secondary">
              {job.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <div className="relative">
              <input
                type="checkbox"
                checked={job.enabled}
                onChange={(e) => onChange({ ...job, enabled: e.target.checked })}
                className="peer sr-only"
              />
              <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
              <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
            </div>
          </label>
          <button
            type="button"
            onClick={onRemove}
            className="ml-2 rounded-sm p-1 text-text-secondary hover:bg-red-500/20 hover:text-red-400"
            title="Remove job"
          >
            &#10005;
          </button>
        </div>
      </div>

      {/* Fields Grid */}
      <div className={job.enabled ? undefined : 'opacity-60'}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Job Key */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Job Key</label>
            <input
              type="text"
              value={job.jobKey}
              onChange={(e) => onChange({ ...job, jobKey: e.target.value })}
              required
              maxLength={100}
              placeholder="e.g. lint-check"
              className="input-field"
            />
          </div>

          {/* Display Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Display Name
            </label>
            <input
              type="text"
              value={job.displayName}
              onChange={(e) => onChange({ ...job, displayName: e.target.value })}
              required
              maxLength={200}
              placeholder="e.g. ESLint Check"
              className="input-field"
            />
          </div>

          {/* Profile */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Profile</label>
            <select
              value={job.profile}
              onChange={(e) => onChange({ ...job, profile: e.target.value as DelegatedCiProfile })}
              className="select-field"
            >
              {PROFILE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Classification */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Classification
            </label>
            <select
              value={job.classification}
              onChange={(e) =>
                onChange({
                  ...job,
                  classification: e.target.value as DelegatedCiClassification,
                })
              }
              className="select-field"
            >
              {CLASSIFICATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Max Duration */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Max Duration (minutes)
            </label>
            <input
              type="number"
              value={job.maxDurationMinutes ?? ''}
              onChange={(e) =>
                onChange({
                  ...job,
                  maxDurationMinutes: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              min={1}
              max={30}
              placeholder="Profile default"
              className="input-field"
            />
            <p className="mt-1 text-xs text-text-secondary">Leave empty for profile default</p>
          </div>

          {/* Allow Cache */}
          <div className="flex items-center">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3 transition-colors hover:border-surface-border/80">
              <input
                type="checkbox"
                checked={job.allowCache}
                onChange={(e) => onChange({ ...job, allowCache: e.target.checked })}
                className="h-4 w-4 accent-primary-600"
              />
              <span className="text-sm text-text-primary">Allow Cache</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
