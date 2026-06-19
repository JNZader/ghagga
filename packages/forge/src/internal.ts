/**
 * ghagga-forge/internal — INTERNAL (non-public) entry point.
 *
 * ⚠️ NOT part of the package's public API surface. Anything exported here is an
 * implementation detail that may change or be removed without a semver bump.
 * Only first-party GHAGGA code (e.g. apps/server review.ts in P1 task 1.4) may
 * import from `ghagga-forge/internal`.
 *
 * Currently exposes only the TEMPORARY P1 credential provider, which is kept off
 * the public surface so the temporary auth path does not ossify. See the
 * `TODO(P2-REMOVE)` marker on the class.
 */

export type { TemporaryGitHubTokenSourceDeps } from './adapters/github/temporary-github-token-source.js';
export { TemporaryGitHubTokenSource } from './adapters/github/temporary-github-token-source.js';
