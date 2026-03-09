// ─── Delegated CI: Policy Evaluator ─────────────────────────────
//
// Pure-function module for evaluating whether CI jobs can be delegated.
// No DB access, no side effects — takes a policy object and returns
// evaluation results with approval status and rejection reasons.

import { getProfile, isSupportedProfile } from './profiles.js';

// ─── Local Types (mirror of DB/shared types, avoids coupling) ───

/** Classification of a job for delegation eligibility */
export type DelegatedCiClassification = 'safe/delegable' | 'sensitive/no-delegable';

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

/** Repository-scoped delegated CI policy */
export interface DelegatedCiPolicy {
  enabled: boolean;
  allowManualTrigger?: boolean;
  allowPullRequestTrigger?: boolean;
  jobs: DelegatedCiJobPolicy[];
}

// ─── Rejection Reason Codes ─────────────────────────────────────

export type RejectionReasonCode =
  | 'delegated_ci_disabled'
  | 'job_not_configured'
  | 'job_disabled'
  | 'job_sensitive'
  | 'profile_unsupported'
  | 'artifact_policy_violation'
  | 'duration_exceeded';

// ─── Evaluation Result ──────────────────────────────────────────

/** Result of evaluating a single job for delegation eligibility */
export interface JobEvaluationResult {
  jobKey: string;
  approved: boolean;
  classification: DelegatedCiClassification | null;
  profile: string | null;
  reasonCode: RejectionReasonCode | null;
  reasonDetail: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────

function rejected(
  jobKey: string,
  reasonCode: RejectionReasonCode,
  reasonDetail: string,
  classification: DelegatedCiClassification | null = null,
  profile: string | null = null,
): JobEvaluationResult {
  return { jobKey, approved: false, classification, profile, reasonCode, reasonDetail };
}

function approved(
  jobKey: string,
  classification: DelegatedCiClassification,
  profile: string,
): JobEvaluationResult {
  return { jobKey, approved: true, classification, profile, reasonCode: null, reasonDetail: null };
}

// ─── Core Evaluator ─────────────────────────────────────────────

/**
 * Evaluate whether a specific job can be delegated.
 *
 * Checks are applied in strict order (first failure wins):
 * 1. Policy exists and is enabled
 * 2. Job exists in the policy
 * 3. Job is enabled
 * 4. Job classification is safe/delegable
 * 5. Profile is supported in the MVP registry
 * 6. Duration does not exceed profile max
 * 7. Artifact kinds are valid for the profile
 */
export function evaluateJob(policy: DelegatedCiPolicy | null, jobKey: string): JobEvaluationResult {
  // 1. Policy must exist
  if (policy === null) {
    return rejected(jobKey, 'delegated_ci_disabled', 'No delegated CI policy configured');
  }

  // 2. Policy must be enabled
  if (!policy.enabled) {
    return rejected(
      jobKey,
      'delegated_ci_disabled',
      'Delegated CI is disabled for this repository',
    );
  }

  // 3. Job must exist in the policy
  const job = policy.jobs.find((j) => j.jobKey === jobKey);
  if (!job) {
    return rejected(
      jobKey,
      'job_not_configured',
      `Job '${jobKey}' is not configured in the policy`,
    );
  }

  // 4. Job must be enabled
  if (!job.enabled) {
    return rejected(
      jobKey,
      'job_disabled',
      `Job '${jobKey}' is disabled`,
      job.classification,
      job.profile,
    );
  }

  // 5. Job must be classified as safe/delegable
  if (job.classification !== 'safe/delegable') {
    return rejected(
      jobKey,
      'job_sensitive',
      `Job '${jobKey}' is classified as '${job.classification}' and cannot be delegated`,
      job.classification,
      job.profile,
    );
  }

  // 6. Profile must be supported in MVP registry
  if (!isSupportedProfile(job.profile)) {
    return rejected(
      jobKey,
      'profile_unsupported',
      `Profile '${job.profile}' is not supported in the current MVP`,
      job.classification,
      job.profile,
    );
  }

  const profile = getProfile(job.profile);
  // Safety: if isSupportedProfile returned true, getProfile won't be null
  // but we guard anyway for type safety
  if (!profile) {
    return rejected(
      jobKey,
      'profile_unsupported',
      `Profile '${job.profile}' could not be loaded`,
      job.classification,
      job.profile,
    );
  }

  // 7. Duration must not exceed profile max
  if (job.maxDurationMinutes !== undefined && job.maxDurationMinutes > profile.maxTimeoutMinutes) {
    return rejected(
      jobKey,
      'duration_exceeded',
      `maxDurationMinutes (${job.maxDurationMinutes}) exceeds profile limit (${profile.maxTimeoutMinutes})`,
      job.classification,
      job.profile,
    );
  }

  // 8. Artifact kinds must be valid for the profile
  if (Array.isArray(job.allowArtifacts) && job.allowArtifacts.length > 0) {
    const allowedKinds = new Set(profile.allowedArtifactKinds);
    const invalidKinds = job.allowArtifacts.filter((kind) => !allowedKinds.has(kind));
    if (invalidKinds.length > 0) {
      return rejected(
        jobKey,
        'artifact_policy_violation',
        `Artifact kinds [${invalidKinds.join(', ')}] are not allowed for profile '${job.profile}'`,
        job.classification,
        job.profile,
      );
    }
  }

  // All checks passed
  return approved(jobKey, job.classification, job.profile);
}

/**
 * Evaluate all configured jobs in a policy.
 * Returns evaluation results for every job in the policy's jobs array.
 * If policy is null or disabled, returns an empty array.
 */
export function evaluateAllJobs(policy: DelegatedCiPolicy | null): JobEvaluationResult[] {
  if (policy === null || !policy.enabled) {
    return [];
  }

  return policy.jobs.map((job) => evaluateJob(policy, job.jobKey));
}

// ─── Policy Normalizer ──────────────────────────────────────────

/**
 * Normalize a raw policy object, applying defaults for missing fields.
 * Returns null if the input is null, undefined, or not a valid object.
 *
 * This is useful when reading policy from JSONB storage where the shape
 * may be partial or missing entirely.
 */
export function normalizePolicy(raw: unknown): DelegatedCiPolicy | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // 'enabled' must be explicitly true to be enabled; default to false
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : false;

  const allowManualTrigger =
    typeof obj.allowManualTrigger === 'boolean' ? obj.allowManualTrigger : undefined;

  const allowPullRequestTrigger =
    typeof obj.allowPullRequestTrigger === 'boolean' ? obj.allowPullRequestTrigger : undefined;

  // Normalize jobs array
  const rawJobs = Array.isArray(obj.jobs) ? obj.jobs : [];
  const jobs: DelegatedCiJobPolicy[] = rawJobs
    .filter((j): j is Record<string, unknown> => j !== null && typeof j === 'object')
    .map((j) => normalizeJobPolicy(j));

  return {
    enabled,
    ...(allowManualTrigger !== undefined && { allowManualTrigger }),
    ...(allowPullRequestTrigger !== undefined && { allowPullRequestTrigger }),
    jobs,
  };
}

/**
 * Normalize a single job policy entry, applying safe defaults.
 */
function normalizeJobPolicy(raw: Record<string, unknown>): DelegatedCiJobPolicy {
  const jobKey = typeof raw.jobKey === 'string' ? raw.jobKey : 'unknown';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName : jobKey;

  // Default classification: sensitive/no-delegable (safe default)
  const classification: DelegatedCiClassification =
    raw.classification === 'safe/delegable' ? 'safe/delegable' : 'sensitive/no-delegable';

  // Default profile: first valid profile or fallback
  const profile = isValidProfile(raw.profile) ? (raw.profile as DelegatedCiProfile) : 'node-lint';

  // Default enabled: false (safe default)
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false;

  // Default allowArtifacts: false (safe default)
  const allowArtifacts = normalizeAllowArtifacts(raw.allowArtifacts);

  // Default allowCache: false
  const allowCache = typeof raw.allowCache === 'boolean' ? raw.allowCache : false;

  // Optional fields
  const maxDurationMinutes =
    typeof raw.maxDurationMinutes === 'number' && raw.maxDurationMinutes > 0
      ? raw.maxDurationMinutes
      : undefined;

  const rationale = typeof raw.rationale === 'string' ? raw.rationale : undefined;

  return {
    jobKey,
    displayName,
    classification,
    profile,
    enabled,
    allowArtifacts,
    allowCache,
    ...(maxDurationMinutes !== undefined && { maxDurationMinutes }),
    ...(rationale !== undefined && { rationale }),
  };
}

const VALID_PROFILES = new Set<string>([
  'node-lint',
  'node-unit',
  'python-lint',
  'python-pytest',
  'go-test',
]);

function isValidProfile(value: unknown): value is DelegatedCiProfile {
  return typeof value === 'string' && VALID_PROFILES.has(value);
}

function normalizeAllowArtifacts(value: unknown): false | string[] {
  if (value === false) return false;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return false;
}
