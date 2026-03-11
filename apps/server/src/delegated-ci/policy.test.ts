// ─── Delegated CI: Policy Evaluator Tests ───────────────────────
//
// Pure-function unit tests for classification mapping, rejection
// reasons, and the normalizePolicy helper.

import { describe, expect, it } from 'vitest';
import type { DelegatedCiJobPolicy, DelegatedCiPolicy } from './policy.js';
import { evaluateAllJobs, evaluateJob, normalizePolicy } from './policy.js';
import { EXECUTION_PROFILES, getProfile, isSupportedProfile } from './profiles.js';

// ─── Test Helpers ───────────────────────────────────────────────

function makeJob(overrides: Partial<DelegatedCiJobPolicy> = {}): DelegatedCiJobPolicy {
  return {
    jobKey: 'lint',
    displayName: 'Lint',
    classification: 'safe/delegable',
    profile: 'node-lint',
    enabled: true,
    allowArtifacts: false,
    allowCache: false,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<DelegatedCiPolicy> = {}): DelegatedCiPolicy {
  return {
    enabled: true,
    jobs: [makeJob()],
    ...overrides,
  };
}

// ─── Profiles Registry ──────────────────────────────────────────

describe('Execution Profiles', () => {
  it('has exactly 5 MVP profiles', () => {
    expect(EXECUTION_PROFILES.size).toBe(5);
  });

  it.each([
    'node-lint',
    'node-unit',
    'python-lint',
    'python-pytest',
    'go-test',
  ])('supports profile "%s"', (id) => {
    expect(isSupportedProfile(id)).toBe(true);
  });

  it('returns false for unsupported profiles', () => {
    expect(isSupportedProfile('docker-build')).toBe(false);
    expect(isSupportedProfile('')).toBe(false);
    expect(isSupportedProfile('NODE-LINT')).toBe(false);
  });

  it('getProfile returns profile for valid ID', () => {
    const profile = getProfile('node-lint');
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe('node-lint');
    expect(profile?.runtime).toBe('node');
    expect(profile?.requiresSecrets).toBe(false);
  });

  it('getProfile returns null for invalid ID', () => {
    expect(getProfile('unknown')).toBeNull();
  });

  it('all profiles have requiresSecrets = false (MVP safety boundary)', () => {
    for (const [, profile] of EXECUTION_PROFILES) {
      expect(profile.requiresSecrets).toBe(false);
    }
  });

  it('all profiles have positive timeout limits', () => {
    for (const [, profile] of EXECUTION_PROFILES) {
      expect(profile.defaultTimeoutMinutes).toBeGreaterThan(0);
      expect(profile.maxTimeoutMinutes).toBeGreaterThanOrEqual(profile.defaultTimeoutMinutes);
    }
  });

  it('all profiles have non-empty allowedArtifactKinds', () => {
    for (const [, profile] of EXECUTION_PROFILES) {
      expect(profile.allowedArtifactKinds.length).toBeGreaterThan(0);
    }
  });
});

// ─── evaluateJob ────────────────────────────────────────────────

describe('evaluateJob', () => {
  // ── 1. Policy null → delegated_ci_disabled ──

  describe('when policy is null', () => {
    it('rejects with delegated_ci_disabled', () => {
      const result = evaluateJob(null, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'delegated_ci_disabled',
      });
    });

    it('includes a descriptive reason detail', () => {
      const result = evaluateJob(null, 'any-job');
      expect(result.reasonDetail).toBeTruthy();
      expect(result.reasonDetail).toContain('policy');
    });
  });

  // ── 2. Policy disabled → delegated_ci_disabled ──

  describe('when policy is disabled', () => {
    it('rejects with delegated_ci_disabled', () => {
      const policy = makePolicy({ enabled: false });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'delegated_ci_disabled',
      });
    });
  });

  // ── 3. Job not in policy → job_not_configured ──

  describe('when job is not in policy', () => {
    it('rejects with job_not_configured', () => {
      const policy = makePolicy({ jobs: [] });
      const result = evaluateJob(policy, 'missing-job');
      expect(result).toMatchObject({
        jobKey: 'missing-job',
        approved: false,
        reasonCode: 'job_not_configured',
      });
      expect(result.reasonDetail).toContain('missing-job');
    });

    it('rejects when other jobs exist but not the requested one', () => {
      const policy = makePolicy({ jobs: [makeJob({ jobKey: 'other' })] });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('job_not_configured');
    });
  });

  // ── 4. Job disabled → job_disabled ──

  describe('when job is disabled', () => {
    it('rejects with job_disabled', () => {
      const policy = makePolicy({
        jobs: [makeJob({ enabled: false })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'job_disabled',
        classification: 'safe/delegable',
        profile: 'node-lint',
      });
    });
  });

  // ── 5. Job classified as sensitive → job_sensitive ──

  describe('when job is classified as sensitive', () => {
    it('rejects with job_sensitive', () => {
      const policy = makePolicy({
        jobs: [makeJob({ classification: 'sensitive/no-delegable' })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'job_sensitive',
        classification: 'sensitive/no-delegable',
      });
      expect(result.reasonDetail).toContain('sensitive/no-delegable');
    });
  });

  // ── 6. Unsupported profile → profile_unsupported ──

  describe('when profile is unsupported', () => {
    it('rejects with profile_unsupported', () => {
      const policy = makePolicy({
        // Cast to bypass type checking since we're testing invalid input
        jobs: [makeJob({ profile: 'docker-build' as DelegatedCiJobPolicy['profile'] })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'profile_unsupported',
      });
      expect(result.reasonDetail).toContain('docker-build');
    });
  });

  // ── 7. Duration exceeded → duration_exceeded ──

  describe('when maxDurationMinutes exceeds profile limit', () => {
    it('rejects with duration_exceeded', () => {
      const profile = getProfile('node-lint');
      expect(profile).not.toBeNull();

      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            maxDurationMinutes: profile?.maxTimeoutMinutes + 1,
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'duration_exceeded',
      });
      expect(result.reasonDetail).toContain(String(profile?.maxTimeoutMinutes));
    });

    it('allows maxDurationMinutes equal to profile limit', () => {
      const profile = getProfile('node-lint');
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            maxDurationMinutes: profile?.maxTimeoutMinutes,
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });

    it('allows job without maxDurationMinutes set', () => {
      const policy = makePolicy({
        jobs: [makeJob({ maxDurationMinutes: undefined })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });
  });

  // ── 8. Artifact policy violation → artifact_policy_violation ──

  describe('when artifact kinds are invalid for the profile', () => {
    it('rejects with artifact_policy_violation', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            allowArtifacts: ['junit', 'docker-image'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: false,
        reasonCode: 'artifact_policy_violation',
      });
      expect(result.reasonDetail).toContain('docker-image');
    });

    it('allows valid artifact kinds for the profile', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            allowArtifacts: ['junit'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });

    it('allows allowArtifacts = false (artifacts disabled)', () => {
      const policy = makePolicy({
        jobs: [makeJob({ allowArtifacts: false })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });

    it('allows empty artifact array', () => {
      const policy = makePolicy({
        jobs: [makeJob({ allowArtifacts: [] })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });

    it('rejects when multiple invalid artifact kinds are present', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            allowArtifacts: ['sarif', 'binary', 'docker-image'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('artifact_policy_violation');
      expect(result.reasonDetail).toContain('sarif');
      expect(result.reasonDetail).toContain('binary');
      expect(result.reasonDetail).toContain('docker-image');
    });
  });

  // ── 9. Happy path → approved ──

  describe('when all checks pass', () => {
    it('approves a valid safe/delegable job', () => {
      const policy = makePolicy();
      const result = evaluateJob(policy, 'lint');
      expect(result).toMatchObject({
        jobKey: 'lint',
        approved: true,
        classification: 'safe/delegable',
        profile: 'node-lint',
        reasonCode: null,
        reasonDetail: null,
      });
    });

    it('approves with different valid profiles', () => {
      const profiles: DelegatedCiJobPolicy['profile'][] = [
        'node-unit',
        'python-lint',
        'python-pytest',
        'go-test',
      ];

      for (const profile of profiles) {
        const policy = makePolicy({
          jobs: [makeJob({ jobKey: `job-${profile}`, profile })],
        });
        const result = evaluateJob(policy, `job-${profile}`);
        expect(result.approved).toBe(true);
        expect(result.profile).toBe(profile);
      }
    });

    it('approves with valid artifacts and duration within limits', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-unit',
            allowArtifacts: ['junit', 'coverage-summary'],
            maxDurationMinutes: 15,
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });
  });

  // ── enabled precedence (design audit fix H-10) ──

  describe('enabled precedence rules', () => {
    it('policy disabled + job enabled = not delegable', () => {
      const policy = makePolicy({
        enabled: false,
        jobs: [makeJob({ enabled: true })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('delegated_ci_disabled');
    });

    it('policy enabled + job disabled = not delegable', () => {
      const policy = makePolicy({
        enabled: true,
        jobs: [makeJob({ enabled: false })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('job_disabled');
    });

    it('policy enabled + job enabled = delegable (if all other checks pass)', () => {
      const policy = makePolicy({
        enabled: true,
        jobs: [makeJob({ enabled: true })],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.approved).toBe(true);
    });
  });

  // ── Rejection order: first check that fails wins ──

  describe('rejection order (first failure wins)', () => {
    it('delegated_ci_disabled takes priority over everything', () => {
      const policy = makePolicy({
        enabled: false,
        jobs: [
          makeJob({
            enabled: false,
            classification: 'sensitive/no-delegable',
            profile: 'docker-build' as DelegatedCiJobPolicy['profile'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.reasonCode).toBe('delegated_ci_disabled');
    });

    it('job_disabled takes priority over job_sensitive', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            enabled: false,
            classification: 'sensitive/no-delegable',
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.reasonCode).toBe('job_disabled');
    });

    it('job_sensitive takes priority over profile_unsupported', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            classification: 'sensitive/no-delegable',
            profile: 'docker-build' as DelegatedCiJobPolicy['profile'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.reasonCode).toBe('job_sensitive');
    });

    it('profile_unsupported takes priority over duration_exceeded', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'docker-build' as DelegatedCiJobPolicy['profile'],
            maxDurationMinutes: 999,
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.reasonCode).toBe('profile_unsupported');
    });

    it('duration_exceeded takes priority over artifact_policy_violation', () => {
      const policy = makePolicy({
        jobs: [
          makeJob({
            profile: 'node-lint',
            maxDurationMinutes: 999,
            allowArtifacts: ['invalid-kind'],
          }),
        ],
      });
      const result = evaluateJob(policy, 'lint');
      expect(result.reasonCode).toBe('duration_exceeded');
    });
  });
});

// ─── evaluateAllJobs ────────────────────────────────────────────

describe('evaluateAllJobs', () => {
  it('returns empty array for null policy', () => {
    expect(evaluateAllJobs(null)).toEqual([]);
  });

  it('returns empty array for disabled policy', () => {
    const policy = makePolicy({ enabled: false });
    expect(evaluateAllJobs(policy)).toEqual([]);
  });

  it('returns empty array for policy with no jobs', () => {
    const policy = makePolicy({ jobs: [] });
    expect(evaluateAllJobs(policy)).toEqual([]);
  });

  it('returns results for all configured jobs', () => {
    const policy = makePolicy({
      jobs: [
        makeJob({ jobKey: 'lint', profile: 'node-lint' }),
        makeJob({ jobKey: 'test', profile: 'node-unit' }),
        makeJob({
          jobKey: 'deploy',
          classification: 'sensitive/no-delegable',
          profile: 'node-lint',
        }),
      ],
    });

    const results = evaluateAllJobs(policy);
    expect(results).toHaveLength(3);

    const lintResult = results.find((r) => r.jobKey === 'lint');
    expect(lintResult?.approved).toBe(true);

    const testResult = results.find((r) => r.jobKey === 'test');
    expect(testResult?.approved).toBe(true);

    const deployResult = results.find((r) => r.jobKey === 'deploy');
    expect(deployResult?.approved).toBe(false);
    expect(deployResult?.reasonCode).toBe('job_sensitive');
  });

  it('evaluates each job independently', () => {
    const policy = makePolicy({
      jobs: [
        makeJob({ jobKey: 'ok-job', enabled: true }),
        makeJob({ jobKey: 'disabled-job', enabled: false }),
        makeJob({ jobKey: 'sensitive-job', classification: 'sensitive/no-delegable' }),
      ],
    });

    const results = evaluateAllJobs(policy);
    const approvedJobs = results.filter((r) => r.approved);
    const rejectedJobs = results.filter((r) => !r.approved);

    expect(approvedJobs).toHaveLength(1);
    expect(approvedJobs[0].jobKey).toBe('ok-job');
    expect(rejectedJobs).toHaveLength(2);
  });
});

// ─── normalizePolicy ────────────────────────────────────────────

describe('normalizePolicy', () => {
  // ── Null/undefined/invalid input ──

  it('returns null for null input', () => {
    expect(normalizePolicy(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizePolicy(undefined)).toBeNull();
  });

  it('returns null for string input', () => {
    expect(normalizePolicy('not an object')).toBeNull();
  });

  it('returns null for number input', () => {
    expect(normalizePolicy(42)).toBeNull();
  });

  it('returns null for array input', () => {
    expect(normalizePolicy([1, 2, 3])).toBeNull();
  });

  it('returns null for boolean input', () => {
    expect(normalizePolicy(true)).toBeNull();
  });

  // ── Empty object ──

  it('normalizes empty object with safe defaults', () => {
    const result = normalizePolicy({});
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(false);
    expect(result?.jobs).toEqual([]);
  });

  // ── Full valid policy ──

  it('normalizes a complete valid policy', () => {
    const raw = {
      enabled: true,
      allowManualTrigger: true,
      allowPullRequestTrigger: false,
      jobs: [
        {
          jobKey: 'lint',
          displayName: 'Lint',
          classification: 'safe/delegable',
          profile: 'node-lint',
          enabled: true,
          allowArtifacts: false,
          allowCache: false,
        },
      ],
    };

    const result = normalizePolicy(raw);
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(true);
    expect(result?.allowManualTrigger).toBe(true);
    expect(result?.allowPullRequestTrigger).toBe(false);
    expect(result?.jobs).toHaveLength(1);
    expect(result?.jobs[0].jobKey).toBe('lint');
  });

  // ── Partial policy ──

  it('defaults enabled to false when missing', () => {
    const result = normalizePolicy({ jobs: [] });
    expect(result?.enabled).toBe(false);
  });

  it('defaults enabled to false for non-boolean value', () => {
    const result = normalizePolicy({ enabled: 'yes', jobs: [] });
    expect(result?.enabled).toBe(false);
  });

  it('omits allowManualTrigger when not boolean', () => {
    const result = normalizePolicy({ enabled: true, allowManualTrigger: 'yes', jobs: [] });
    expect(result?.allowManualTrigger).toBeUndefined();
  });

  it('defaults jobs to empty array when missing', () => {
    const result = normalizePolicy({ enabled: true });
    expect(result?.jobs).toEqual([]);
  });

  it('defaults jobs to empty array for non-array value', () => {
    const result = normalizePolicy({ enabled: true, jobs: 'not-an-array' });
    expect(result?.jobs).toEqual([]);
  });

  // ── Job normalization ──

  it('defaults job classification to sensitive/no-delegable', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test' }],
    });
    expect(result?.jobs[0].classification).toBe('sensitive/no-delegable');
  });

  it('defaults job enabled to false (safe default)', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test' }],
    });
    expect(result?.jobs[0].enabled).toBe(false);
  });

  it('defaults job allowArtifacts to false', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test' }],
    });
    expect(result?.jobs[0].allowArtifacts).toBe(false);
  });

  it('defaults job allowCache to false', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test' }],
    });
    expect(result?.jobs[0].allowCache).toBe(false);
  });

  it('uses jobKey as displayName when displayName is missing', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'my-test' }],
    });
    expect(result?.jobs[0].displayName).toBe('my-test');
  });

  it('defaults jobKey to "unknown" when missing', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{}],
    });
    expect(result?.jobs[0].jobKey).toBe('unknown');
  });

  it('preserves valid classification value', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', classification: 'safe/delegable' }],
    });
    expect(result?.jobs[0].classification).toBe('safe/delegable');
  });

  it('filters out null entries in jobs array', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [null, { jobKey: 'valid' }, undefined, 42, 'string'],
    });
    expect(result?.jobs).toHaveLength(1);
    expect(result?.jobs[0].jobKey).toBe('valid');
  });

  it('normalizes allowArtifacts array by filtering non-string values', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', allowArtifacts: ['junit', 42, null, 'coverage-summary'] }],
    });
    expect(result?.jobs[0].allowArtifacts).toEqual(['junit', 'coverage-summary']);
  });

  it('skips maxDurationMinutes when not a positive number', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', maxDurationMinutes: -5 }],
    });
    expect(result?.jobs[0].maxDurationMinutes).toBeUndefined();
  });

  it('preserves maxDurationMinutes when valid', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', maxDurationMinutes: 15 }],
    });
    expect(result?.jobs[0].maxDurationMinutes).toBe(15);
  });

  it('skips rationale when not a string', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', rationale: 123 }],
    });
    expect(result?.jobs[0].rationale).toBeUndefined();
  });

  it('preserves rationale when valid', () => {
    const result = normalizePolicy({
      enabled: true,
      jobs: [{ jobKey: 'test', rationale: 'Only runs linting, no secrets needed' }],
    });
    expect(result?.jobs[0].rationale).toBe('Only runs linting, no secrets needed');
  });
});

// ─── Integration: normalizePolicy + evaluateJob ─────────────────

describe('normalizePolicy → evaluateJob integration', () => {
  it('normalized policy with valid job passes evaluation', () => {
    const normalized = normalizePolicy({
      enabled: true,
      jobs: [
        {
          jobKey: 'lint',
          displayName: 'Lint',
          classification: 'safe/delegable',
          profile: 'node-lint',
          enabled: true,
          allowArtifacts: false,
          allowCache: false,
        },
      ],
    });

    const result = evaluateJob(normalized, 'lint');
    expect(result.approved).toBe(true);
  });

  it('normalized partial policy defaults to safe rejection', () => {
    // Missing fields → defaults to disabled, sensitive classification
    const normalized = normalizePolicy({
      jobs: [{ jobKey: 'test' }],
    });

    const result = evaluateJob(normalized, 'test');
    expect(result.approved).toBe(false);
    // Policy defaults to enabled=false → delegated_ci_disabled
    expect(result.reasonCode).toBe('delegated_ci_disabled');
  });

  it('null input to normalizePolicy → null → evaluateJob rejects', () => {
    const normalized = normalizePolicy(null);
    const result = evaluateJob(normalized, 'any');
    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('delegated_ci_disabled');
  });
});
