/**
 * Dashboard API routes — barrel module.
 *
 * Composes all domain-specific sub-routers into a single router
 * that can be mounted exactly like the old monolithic api.ts.
 *
 * All routes require authentication via the auth middleware.
 * Users can only access data from installations they belong to.
 */

import type { Database } from 'ghagga-db';
import { Hono } from 'hono';
import { createInstallationsRouter } from './installations.js';
import { createMemoryRouter } from './memory.js';
import { createRepositoriesRouter } from './repositories.js';
import { createReviewsRouter } from './reviews.js';
import { createRunnerRouter } from './runner.js';
import { createSettingsRouter } from './settings.js';
import { createStatsCostRouter } from './stats-cost.js';

export { buildProviderChainView } from './utils.js';

export function createApiRouter(db: Database) {
  const router = new Hono();

  router.route('/', createReviewsRouter(db));
  router.route('/', createRepositoriesRouter(db));
  router.route('/', createInstallationsRouter(db));
  router.route('/', createSettingsRouter(db));
  router.route('/', createMemoryRouter(db));
  router.route('/', createRunnerRouter(db));
  router.route('/', createStatsCostRouter(db));

  return router;
}
