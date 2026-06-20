/**
 * StaticTokenProvider — a fixed-token {@link ForgeCredentialProvider} for the CLI
 * path (SDD forge-agnostic task 2.2).
 *
 * Returns a long-lived token supplied up front (e.g. `GITHUB_TOKEN` / a PAT) with
 * NO cache and NO refresh — there is nothing to mint. It exists so the CLI (P3)
 * and GitLab-via-CLI (P4) can satisfy the SAME credential seam the server worker
 * uses, making the auth strategy a pure construction-site choice (R-TOKEN: "swap
 * App→Static requires no worker change").
 *
 * Forge-agnostic by construction: it takes the token as a plain string, so it is
 * not GitHub-specific despite living under adapters/github (the only current
 * consumer is the GitHub CLI path).
 */

import type { ForgeCredentialProvider } from '../../ports/credential-provider.js';

/** Fixed-token credential provider (no cache, no refresh). */
export class StaticTokenProvider implements ForgeCredentialProvider {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /** Return the fixed token. Always the same value; never mints or refreshes. */
  async getToken(): Promise<string> {
    return this.#token;
  }

  /**
   * No-op: a static provider has NO cache to drop. The fixed token cannot be
   * re-acquired (there is nothing to mint), so a 401/403 here is terminal — but
   * the method exists to satisfy the {@link ForgeCredentialProvider} port so the
   * SAME 401-recovery call-site works regardless of which provider is wired.
   */
  invalidate(): void {
    // intentionally empty — no cache, nothing to invalidate.
  }
}
