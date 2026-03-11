import { Card, CardHeader } from '@/components/Card';
import type { DelegatedCiJobPolicy, DelegatedCiPolicy } from '@/lib/types';
import { DelegatedCiJobEntry } from './DelegatedCiJobEntry';

// ─── Types ──────────────────────────────────────────────────────

interface DelegatedCiEditorProps {
  value: DelegatedCiPolicy | null;
  onChange: (policy: DelegatedCiPolicy | null) => void;
}

// ─── Defaults ───────────────────────────────────────────────────

function createDefaultJob(): DelegatedCiJobPolicy {
  return {
    jobKey: '',
    displayName: '',
    profile: 'node-lint',
    classification: 'safe/delegable',
    enabled: true,
    allowArtifacts: false,
    allowCache: true,
  };
}

// ─── Component ──────────────────────────────────────────────────

export function DelegatedCiEditor({ value, onChange }: DelegatedCiEditorProps) {
  const isEnabled = value?.enabled;

  const handleToggle = (checked: boolean) => {
    if (checked) {
      if (value === null) {
        // Enable from null — create fresh policy
        onChange({
          enabled: true,
          allowPullRequestTrigger: true,
          allowManualTrigger: true,
          jobs: [],
        });
      } else {
        // Re-enable — preserve existing jobs
        onChange({ ...value, enabled: true });
      }
    } else if (value !== null) {
      // Disable — preserve jobs
      onChange({ ...value, enabled: false });
    }
  };

  const handleEntryChange = (index: number, entry: DelegatedCiJobPolicy) => {
    if (!value) return;
    const updated = [...value.jobs];
    updated[index] = entry;
    onChange({ ...value, jobs: updated });
  };

  const handleRemoveJob = (index: number) => {
    if (!value) return;
    onChange({ ...value, jobs: value.jobs.filter((_, i) => i !== index) });
  };

  const handleAddJob = () => {
    if (!value) return;
    onChange({ ...value, jobs: [...value.jobs, createDefaultJob()] });
  };

  const handleRemovePolicy = () => {
    if (window.confirm('Remove the entire Delegated CI configuration? This cannot be undone.')) {
      onChange(null);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardHeader
          title="Delegated CI"
          description="Run safe CI jobs directly from GHAGGA reviews (repo-scoped)"
        />
        <label className="flex cursor-pointer items-center gap-3">
          <span className="text-sm text-text-secondary">{isEnabled ? 'Enabled' : 'Disabled'}</span>
          <div className="relative">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => handleToggle(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-surface-border peer-checked:bg-primary-600 transition-colors" />
            <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
          </div>
        </label>
      </div>

      {/* Null state — no policy configured */}
      {value === null && (
        <p className="text-sm text-text-secondary">
          No delegated CI policy configured. Enable to configure CI jobs for this repository.
        </p>
      )}

      {/* Disabled state — policy exists but disabled */}
      {value !== null && !value.enabled && (
        <p className="text-sm text-text-secondary">
          Delegated CI is disabled. Enable to view and edit configuration.
        </p>
      )}

      {/* Enabled state — show full editor */}
      {value?.enabled && (
        <div className="mt-4 space-y-4">
          {/* Trigger Options */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3 transition-colors hover:border-surface-border/80">
              <input
                type="checkbox"
                checked={value.allowPullRequestTrigger ?? false}
                onChange={(e) => onChange({ ...value, allowPullRequestTrigger: e.target.checked })}
                className="h-4 w-4 accent-primary-600"
              />
              <span className="text-sm text-text-primary">Run on Pull Requests</span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border bg-surface-bg p-3 transition-colors hover:border-surface-border/80">
              <input
                type="checkbox"
                checked={value.allowManualTrigger ?? false}
                onChange={(e) => onChange({ ...value, allowManualTrigger: e.target.checked })}
                className="h-4 w-4 accent-primary-600"
              />
              <span className="text-sm text-text-primary">Allow Manual Trigger</span>
            </label>
          </div>

          {/* Jobs Section */}
          <div>
            <span className="mb-2 block text-sm font-medium text-text-primary">
              Jobs
              <span className="ml-2 font-normal text-text-secondary">({value.jobs.length})</span>
            </span>

            <div className="space-y-3">
              {value.jobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-surface-border p-6 text-center">
                  <p className="text-sm text-text-secondary">
                    Add at least one job for Delegated CI to function.
                  </p>
                </div>
              ) : (
                value.jobs.map((job, index) => (
                  <DelegatedCiJobEntry
                    key={`${job.jobKey || 'new'}-${index}`}
                    index={index}
                    job={job}
                    onChange={(updated) => handleEntryChange(index, updated)}
                    onRemove={() => handleRemoveJob(index)}
                  />
                ))
              )}

              {value.jobs.length < 10 ? (
                <button
                  type="button"
                  onClick={handleAddJob}
                  className="w-full rounded-lg border border-dashed border-surface-border px-4 py-2 text-sm text-text-secondary transition-colors hover:border-primary-600/50 hover:text-primary-400"
                >
                  + Add Job
                </button>
              ) : (
                <p className="text-center text-xs text-text-secondary">
                  Maximum of 10 jobs reached.
                </p>
              )}
            </div>
          </div>

          {/* Remove Policy */}
          <button
            type="button"
            onClick={handleRemovePolicy}
            className="text-sm text-red-400 hover:text-red-300 transition-colors"
          >
            Remove Delegated CI Configuration
          </button>
        </div>
      )}
    </Card>
  );
}
