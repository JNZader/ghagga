// ─── Delegated CI ───────────────────────────────────────────────

/** Classification of a job for delegation eligibility */
export type DelegatedCiClassification = 'safe/delegable' | 'sensitive/no-delegable';

/** Lifecycle state of a delegated CI run */
export type DelegatedCiRunState =
  | 'approved'
  | 'rejected'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out';

/** Supported curated execution profiles for MVP */
export type DelegatedCiProfile =
  | 'node-lint'
  | 'node-unit'
  | 'python-lint'
  | 'python-pytest'
  | 'go-test';

/** Per-job policy within a repository's delegated CI configuration */
export interface DelegatedCiJobPolicy {
  jobKey: string;
  displayName: string;
  classification: DelegatedCiClassification;
  profile: DelegatedCiProfile;
  enabled: boolean;
  allowArtifacts: false | string[];
  allowCache: boolean;
  maxDurationMinutes?: number;
  rationale?: string;
}

/** Repository-scoped delegated CI policy (not inherited from installation) */
export interface DelegatedCiPolicy {
  enabled: boolean;
  allowManualTrigger?: boolean;
  allowPullRequestTrigger?: boolean;
  jobs: DelegatedCiJobPolicy[];
}

// ─── CI Job Discovery ───────────────────────────────────────────

/** Source type for a discovered CI job */
export type DiscoveredCiSource = 'github-actions' | 'package-json' | 'makefile';

/** Runtime detected for a repository */
export type DiscoveredCiRuntime = 'node' | 'python' | 'go' | 'unknown';

/** A CI job discovered by scanning the repository */
export interface DiscoveredCiJob {
  source: DiscoveredCiSource;
  sourceFile: string;
  jobKey: string;
  displayName: string;
  command: string | null;
  suggestedProfile: DelegatedCiProfile;
  runtime: DiscoveredCiRuntime;
}
