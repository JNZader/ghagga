/**
 * Plugin registry initialization.
 *
 * Imports all tool plugins and registers them with the singleton toolRegistry.
 * Call `initializeDefaultTools()` to populate the registry.
 *
 * Phase 2: semgrep, trivy, cpd (always-on)
 * Phase 3: gitleaks, shellcheck, markdownlint, lizard (always-on)
 * Phase 4: ruff, bandit, golangci-lint (auto-detect)
 * Phase 5: biome, pmd, psalm, clippy, hadolint (auto-detect)
 * Phase 6: zizmor (auto-detect — CI/CD security)
 */

import { toolRegistry } from '../registry.js';
// Phase 4: auto-detect (Python + Go)
import { banditPlugin } from './bandit.js';
// Phase 5: auto-detect (remaining)
import { biomePlugin } from './biome.js';
import { clippyPlugin } from './clippy.js';
// Phase 2: always-on (adapted)
import { cpdPlugin } from './cpd.js';
// Phase 3: always-on (new)
import { gitleaksPlugin } from './gitleaks.js';
import { golangciLintPlugin } from './golangci-lint.js';
import { hadolintPlugin } from './hadolint.js';
import { lizardPlugin } from './lizard.js';
import { markdownlintPlugin } from './markdownlint.js';
import { pmdPlugin } from './pmd.js';
import { psalmPlugin } from './psalm.js';
import { ruffPlugin } from './ruff.js';
import { semgrepPlugin } from './semgrep.js';
import { shellcheckPlugin } from './shellcheck.js';
import { trivyPlugin } from './trivy.js';
// Phase 6: auto-detect (CI/CD security)
import { zizmorPlugin } from './zizmor.js';

/** All built-in plugins. Grows as more phases are implemented. */
const DEFAULT_PLUGINS = [
  // Phase 2: always-on (adapted)
  semgrepPlugin,
  trivyPlugin,
  cpdPlugin,
  // Phase 3: always-on (new)
  gitleaksPlugin,
  shellcheckPlugin,
  markdownlintPlugin,
  lizardPlugin,
  // Phase 4: auto-detect (Python + Go)
  ruffPlugin,
  banditPlugin,
  golangciLintPlugin,
  // Phase 5: auto-detect (remaining)
  biomePlugin,
  pmdPlugin,
  psalmPlugin,
  clippyPlugin,
  hadolintPlugin,
  // Phase 6: auto-detect (CI/CD security)
  zizmorPlugin,
];

let initialized = false;

/**
 * Register all default tool plugins with the registry.
 * Safe to call multiple times — only registers once.
 */
export function initializeDefaultTools(): void {
  if (initialized) return;

  for (const plugin of DEFAULT_PLUGINS) {
    toolRegistry.register(plugin);
  }

  initialized = true;
}

/**
 * Reset the initialization flag (for tests).
 * @internal
 */
export function resetInitialization(): void {
  initialized = false;
}

export { banditPlugin } from './bandit.js';
// Phase 5
export { biomePlugin } from './biome.js';
export { clippyPlugin } from './clippy.js';
// Re-export plugins for direct access
export { cpdPlugin } from './cpd.js';
// Phase 3
export { gitleaksPlugin } from './gitleaks.js';
export { golangciLintPlugin } from './golangci-lint.js';
export { hadolintPlugin } from './hadolint.js';
export { lizardPlugin } from './lizard.js';
export { markdownlintPlugin } from './markdownlint.js';
export { pmdPlugin } from './pmd.js';
export { psalmPlugin } from './psalm.js';
// Phase 4
export { ruffPlugin } from './ruff.js';
export { semgrepPlugin } from './semgrep.js';
export { shellcheckPlugin } from './shellcheck.js';
export { trivyPlugin } from './trivy.js';
// Phase 6
export { zizmorPlugin } from './zizmor.js';
