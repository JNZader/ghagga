// ─── Delegated CI: Execution Profiles ───────────────────────────
//
// Registry of curated execution profiles for the MVP.
// Each profile defines the runtime, command template, timeout limits,
// and allowed artifact kinds for a specific CI task type.
//
// This module is pure — no side effects, no DB access.

/** Definition of a curated execution profile for delegated CI MVP */
export interface ExecutionProfile {
  id: string;
  displayName: string;
  runtime: 'node' | 'python' | 'go';
  command: string;
  defaultTimeoutMinutes: number;
  maxTimeoutMinutes: number;
  requiresSecrets: false; // MVP: always false (safety boundary)
  allowedArtifactKinds: readonly string[];
}

/** All supported MVP execution profiles, keyed by profile ID */
const profiles: [string, ExecutionProfile][] = [
  [
    'node-lint',
    {
      id: 'node-lint',
      displayName: 'Node.js Lint',
      runtime: 'node',
      command: 'npm run lint',
      defaultTimeoutMinutes: 5,
      maxTimeoutMinutes: 10,
      requiresSecrets: false,
      allowedArtifactKinds: ['junit'],
    },
  ],
  [
    'node-unit',
    {
      id: 'node-unit',
      displayName: 'Node.js Unit Tests',
      runtime: 'node',
      command: 'npm test',
      defaultTimeoutMinutes: 10,
      maxTimeoutMinutes: 30,
      requiresSecrets: false,
      allowedArtifactKinds: ['junit', 'coverage-summary'],
    },
  ],
  [
    'python-lint',
    {
      id: 'python-lint',
      displayName: 'Python Lint',
      runtime: 'python',
      command: 'ruff check .',
      defaultTimeoutMinutes: 5,
      maxTimeoutMinutes: 10,
      requiresSecrets: false,
      allowedArtifactKinds: ['junit'],
    },
  ],
  [
    'python-pytest',
    {
      id: 'python-pytest',
      displayName: 'Python Pytest',
      runtime: 'python',
      command: 'pytest',
      defaultTimeoutMinutes: 10,
      maxTimeoutMinutes: 30,
      requiresSecrets: false,
      allowedArtifactKinds: ['junit', 'coverage-summary'],
    },
  ],
  [
    'go-test',
    {
      id: 'go-test',
      displayName: 'Go Test',
      runtime: 'go',
      command: 'go test ./...',
      defaultTimeoutMinutes: 10,
      maxTimeoutMinutes: 30,
      requiresSecrets: false,
      allowedArtifactKinds: ['junit', 'coverage-summary'],
    },
  ],
];

/** Registry of all supported MVP execution profiles (immutable) */
export const EXECUTION_PROFILES: ReadonlyMap<string, ExecutionProfile> = new Map(profiles);

/** Check if a profile ID is supported in the MVP registry */
export function isSupportedProfile(profileId: string): boolean {
  return EXECUTION_PROFILES.has(profileId);
}

/** Get a profile by ID, or null if unsupported */
export function getProfile(profileId: string): ExecutionProfile | null {
  return EXECUTION_PROFILES.get(profileId) ?? null;
}
