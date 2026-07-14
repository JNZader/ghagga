/**
 * REPRODUCE module — public barrel.
 *
 * `@playwright/test` stays an optional peer dependency: importing this
 * barrel does NOT eagerly load Playwright. Only calling `reproduce()`
 * triggers the lazy `import('@playwright/test')`.
 */

export type { ExecutableLocator, ExecutablePage } from './action-executor.js';
export { buildActionLocator, executeAction } from './action-executor.js';
export type { AttachedEvidence, EvidenceCapablePage } from './evidence.js';
export { attachEvidenceListeners, captureUIErrors } from './evidence.js';
export {
  isChromiumAvailable,
  PlaywrightNotInstalledError,
  type ReproduceIssueInput,
  type ReproduceOptions,
  reproduce,
} from './harness.js';
export type { LoginContext, LoginLocator, LoginPage, LoginResult } from './login.js';
export { runLoginRecipe } from './login.js';
export type { ReproAction } from './parse-action.js';
export { parseAction } from './parse-action.js';
export { extractRouteFromIssueBody } from './route.js';
export type { SnapshotLocator, SnapshotPage } from './snapshot.js';
export { captureScopedSnapshot } from './snapshot.js';
