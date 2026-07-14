/**
 * Forge adapter factory — dispatches on `config.forge`. Unrecognized forges
 * are rejected at config-validation time by `TriageConfigSchema`'s
 * `forge: z.enum(['gitlab','github'])` (see ../config/schema.ts), NOT here;
 * the `default` branch below is an exhaustiveness safety net only, not a
 * reachable runtime path for a schema-validated config.
 */

import { createGitHubAdapter } from './github.js';
import { createGitLabAdapter } from './gitlab.js';
import type { ForgeAdapter } from './port.js';

export { createGitHubAdapter } from './github.js';
export { createGitLabAdapter } from './gitlab.js';
export type { ForgeAdapter, ForgeComment, ForgeIssue, ForgeIssueFilter } from './port.js';

export interface ForgeAdapterConfig {
  forge: 'gitlab' | 'github';
  repo: string;
}

export function createForgeAdapter(config: ForgeAdapterConfig): ForgeAdapter {
  switch (config.forge) {
    case 'gitlab':
      return createGitLabAdapter(config);
    case 'github':
      return createGitHubAdapter(config);
    default: {
      const unrecognized: never = config.forge;
      throw new Error(`Unrecognized forge: ${String(unrecognized)}`);
    }
  }
}
