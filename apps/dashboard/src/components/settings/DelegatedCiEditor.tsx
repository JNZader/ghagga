import { useState } from 'react';
import { Card, CardHeader } from '@/components/Card';
import { useDiscoverCi } from '@/lib/api';
import type {
  DelegatedCiJobPolicy,
  DelegatedCiPolicy,
  DiscoveredCiJob,
  JobRecommendation,
} from '@/lib/types';
import { DelegatedCiJobEntry } from './DelegatedCiJobEntry';

// ─── Types ──────────────────────────────────────────────────────

interface DelegatedCiEditorProps {
  value: DelegatedCiPolicy | null;
  onChange: (policy: DelegatedCiPolicy | null) => void;
  repoId?: number;
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

function discoveredJobToPolicy(job: DiscoveredCiJob): DelegatedCiJobPolicy {
  return {
    jobKey: job.jobKey,
    displayName: job.displayName,
    profile: job.suggestedProfile,
    classification: 'safe/delegable',
    enabled: true,
    allowArtifacts: false,
    allowCache: true,
  };
}

// ─── Source Badge ───────────────────────────────────────────────

function SourceBadge({ source }: { source: DiscoveredCiJob['source'] }) {
  const styles: Record<string, string> = {
    'github-actions': 'bg-blue-500/20 text-blue-400',
    'package-json': 'bg-green-500/20 text-green-400',
    makefile: 'bg-yellow-500/20 text-yellow-400',
  };
  const labels: Record<string, string> = {
    'github-actions': 'Actions',
    'package-json': 'npm',
    makefile: 'Make',
  };

  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${styles[source] ?? ''}`}>
      {labels[source] ?? source}
    </span>
  );
}

// ─── Recommendation Badge ───────────────────────────────────────

function RecommendationBadge({ recommendation }: { recommendation?: JobRecommendation }) {
  if (!recommendation) return null;

  const { delegable, confidence } = recommendation;

  if (delegable && confidence !== 'low') {
    return (
      <span className="rounded-sm bg-green-500/20 px-1.5 py-0.5 text-xs font-medium text-green-400">
        Recommended
      </span>
    );
  }

  if (confidence === 'low') {
    return (
      <span className="rounded-sm bg-yellow-500/20 px-1.5 py-0.5 text-xs font-medium text-yellow-400">
        Review
      </span>
    );
  }

  return (
    <span className="rounded-sm bg-red-500/20 px-1.5 py-0.5 text-xs font-medium text-red-400">
      Not recommended
    </span>
  );
}

// ─── Profile Suggestion Note ────────────────────────────────────

function ProfileSuggestionNote({
  recommendation,
  currentProfile,
}: {
  recommendation?: JobRecommendation;
  currentProfile: string;
}) {
  if (!recommendation?.suggestedProfile) return null;
  if (recommendation.suggestedProfile === currentProfile) return null;

  return (
    <span className="text-xs text-yellow-400">
      Suggested profile: {recommendation.suggestedProfile}
    </span>
  );
}

function NoProfileNote({ recommendation }: { recommendation?: JobRecommendation }) {
  if (!recommendation) return null;
  // Show "no matching profile" when suggestedProfile is explicitly null
  // and the job is not delegable due to runtime mismatch
  if (recommendation.suggestedProfile !== null) return null;
  if (recommendation.delegable) return null;
  if (!recommendation.reason.includes('no matching execution profile')) return null;

  return <span className="text-xs text-red-400/80">No matching profile available</span>;
}

// ─── Component ──────────────────────────────────────────────────

export function DelegatedCiEditor({ value, onChange, repoId }: DelegatedCiEditorProps) {
  const isEnabled = value?.enabled;
  const [showDiscovery, setShowDiscovery] = useState(false);

  const {
    data: discoveredJobs,
    isLoading: isDiscovering,
    refetch: refetchDiscovery,
  } = useDiscoverCi(showDiscovery ? (repoId ?? null) : null);

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

  const handleDiscoverJobs = () => {
    setShowDiscovery(true);
    if (discoveredJobs) {
      void refetchDiscovery();
    }
  };

  const handleAddDiscoveredJob = (job: DiscoveredCiJob) => {
    if (!value) return;
    // Don't add duplicates
    if (value.jobs.some((j) => j.jobKey === job.jobKey)) return;
    onChange({ ...value, jobs: [...value.jobs, discoveredJobToPolicy(job)] });
  };

  const handleRemovePolicy = () => {
    if (window.confirm('Remove the entire Delegated CI configuration? This cannot be undone.')) {
      onChange(null);
    }
  };

  // Filter out already-added jobs from discovery list
  const existingJobKeys = new Set(value?.jobs.map((j) => j.jobKey) ?? []);
  const availableJobs = discoveredJobs?.filter((j) => !existingJobKeys.has(j.jobKey)) ?? [];

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

              {value.jobs.length < 10 && (
                <div className="flex gap-2">
                  {repoId && (
                    <button
                      type="button"
                      onClick={handleDiscoverJobs}
                      disabled={isDiscovering}
                      className="flex-1 rounded-lg border border-dashed border-primary-600/50 px-4 py-2 text-sm text-primary-400 transition-colors hover:border-primary-600 hover:bg-primary-600/10 disabled:opacity-50"
                    >
                      {isDiscovering ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-400 border-t-transparent" />
                          Scanning repository...
                        </span>
                      ) : (
                        'Discover Jobs from Repo'
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleAddJob}
                    className="flex-1 rounded-lg border border-dashed border-surface-border px-4 py-2 text-sm text-text-secondary transition-colors hover:border-primary-600/50 hover:text-primary-400"
                  >
                    + Add Custom Job
                  </button>
                </div>
              )}

              {value.jobs.length >= 10 && (
                <p className="text-center text-xs text-text-secondary">
                  Maximum of 10 jobs reached.
                </p>
              )}
            </div>
          </div>

          {/* Discovery Results */}
          {showDiscovery && !isDiscovering && discoveredJobs && (
            <div className="rounded-lg border border-primary-600/30 bg-primary-600/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-text-primary">
                  Discovered Jobs
                  <span className="ml-2 font-normal text-text-secondary">
                    ({availableJobs.length} available)
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowDiscovery(false)}
                  className="text-xs text-text-secondary hover:text-text-primary"
                >
                  Close
                </button>
              </div>

              {availableJobs.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  {discoveredJobs.length === 0
                    ? 'No CI jobs found in this repository.'
                    : 'All discovered jobs have already been added.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {availableJobs.map((job) => {
                    const isDiscouraged =
                      job.recommendation &&
                      !job.recommendation.delegable &&
                      job.recommendation.confidence !== 'low';

                    return (
                      <div
                        key={`${job.source}-${job.jobKey}`}
                        className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-bg p-3"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary">
                              {job.jobKey}
                            </span>
                            <SourceBadge source={job.source} />
                            <RecommendationBadge recommendation={job.recommendation} />
                            <span className="rounded-sm bg-surface-border/50 px-1.5 py-0.5 text-xs text-text-secondary">
                              {job.suggestedProfile}
                            </span>
                          </div>
                          {job.recommendation?.reason && (
                            <p className="mt-1 text-xs text-text-secondary">
                              {job.recommendation.reason}
                            </p>
                          )}
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-xs text-text-secondary">{job.sourceFile}</span>
                            {job.command && (
                              <code className="rounded-sm bg-surface-border/30 px-1 py-0.5 text-xs text-text-secondary">
                                {job.command}
                              </code>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <ProfileSuggestionNote
                              recommendation={job.recommendation}
                              currentProfile={job.suggestedProfile}
                            />
                            <NoProfileNote recommendation={job.recommendation} />
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddDiscoveredJob(job)}
                          disabled={value.jobs.length >= 10}
                          className={
                            isDiscouraged
                              ? 'ml-3 rounded-md bg-surface-border/20 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-border/30 disabled:opacity-50'
                              : 'ml-3 rounded-md bg-primary-600/20 px-3 py-1.5 text-xs font-medium text-primary-400 transition-colors hover:bg-primary-600/30 disabled:opacity-50'
                          }
                        >
                          {isDiscouraged ? 'Add anyway' : '+ Add'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
