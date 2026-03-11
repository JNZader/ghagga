/**
 * Environment variable validation — fail-fast at startup.
 *
 * Checks that all critical env vars are present before the server
 * initialises anything (database, GitHub App, webhooks, encryption).
 * If any are missing the process exits immediately with a clear message.
 */

import { logger } from './logger.js';

/**
 * Env vars that MUST be set for the server to function.
 * Optional vars (RENDER_EXTERNAL_URL, REDIS_URL, PORT, etc.) are not checked.
 */
export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'ENCRYPTION_KEY',
] as const;

/**
 * Returns the list of required env vars that are missing or empty.
 *
 * Exported separately so tests can assert on the detection logic
 * without triggering `process.exit`.
 */
export function getMissingEnvVars(env: Record<string, string | undefined> = process.env): string[] {
  return REQUIRED_ENV_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
}

/**
 * Validate that every required env var is present.
 * Logs the missing names and calls `process.exit(1)` if any are absent.
 *
 * Must be called synchronously at the top of `index.ts`, before any
 * initialisation (database, Hono app, etc.).
 */
export function validateEnvironment(env: Record<string, string | undefined> = process.env): void {
  const missing = getMissingEnvVars(env);

  if (missing.length > 0) {
    logger.fatal(
      { missing },
      `Missing required environment variable(s): ${missing.join(', ')}. Server cannot start.`,
    );
    process.exit(1);
  }
}
