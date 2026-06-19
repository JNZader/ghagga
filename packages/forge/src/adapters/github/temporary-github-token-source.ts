/**
 * TemporaryGitHubTokenSource — a MINIMAL {@link ForgeCredentialProvider}
 * implementation for P1.
 *
 * ⚠️ TEMPORARY — MUST BE REPLACED by `GitHubAppCredentialProvider` in P2 BEFORE
 * archive. Do NOT fossilize this as a second, parallel auth path. This exists
 * ONLY so P1's task 1.4 (review.ts rewire) can depend on the
 * {@link ForgeCredentialProvider} PORT today, making P2's task 2.3 a 1-line DI
 * swap (replace this class with the real provider — no call-site changes).
 *
 * WHAT IT DOES NOT DO (deliberately): no TTL cache, no singleflight, no
 * proactive refresh. Those belong to P2's `GitHubAppCredentialProvider`. This
 * class simply mints a fresh installation token on every `getToken()` call via
 * the injected mint function — preserving the current review.ts behavior, which
 * calls `getInstallationToken` directly each time it needs a token.
 *
 * DEPENDENCY INVERSION (boundary rule R-AGNOSTIC): like the adapter, this class
 * does NOT import `apps/server`. The real `getInstallationToken` from
 * `apps/server/src/github/client.ts` is injected as {@link GitHubInstallationTokenMint}.
 */

import type { ForgeCredentialProvider } from '../../ports/credential-provider.js';
import type { GitHubInstallationTokenMint } from './github-client-port.js';

/** Construction options for {@link TemporaryGitHubTokenSource}. */
export interface TemporaryGitHubTokenSourceDeps {
  /** Injected installation-token mint (real impl = client.getInstallationToken). */
  mint: GitHubInstallationTokenMint;
  /** GitHub App installation id. */
  installationId: number;
  /** GitHub App id. */
  appId: string;
  /** GitHub App private key (PEM). */
  privateKey: string;
  /** Optional repository-id scoping for the minted token. */
  repositoryIds?: number[];
}

/**
 * P1 credential provider that mints a fresh GitHub installation token per call.
 *
 * @see {@link ForgeCredentialProvider} — the port it implements.
 */
export class TemporaryGitHubTokenSource implements ForgeCredentialProvider {
  readonly #mint: GitHubInstallationTokenMint;
  readonly #installationId: number;
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #repositoryIds?: number[];

  constructor(deps: TemporaryGitHubTokenSourceDeps) {
    this.#mint = deps.mint;
    this.#installationId = deps.installationId;
    this.#appId = deps.appId;
    this.#privateKey = deps.privateKey;
    this.#repositoryIds = deps.repositoryIds;
  }

  /**
   * Mint and return a fresh installation token. No caching (see class note —
   * caching/refresh is P2's GitHubAppCredentialProvider responsibility).
   */
  async getToken(): Promise<string> {
    return this.#mint(
      this.#installationId,
      this.#appId,
      this.#privateKey,
      this.#repositoryIds && this.#repositoryIds.length > 0
        ? { repositoryIds: this.#repositoryIds }
        : undefined,
    );
  }
}
