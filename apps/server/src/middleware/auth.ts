/**
 * Authentication middleware for the dashboard API.
 *
 * Verifies a GitHub personal access token by calling GET /user,
 * then looks up which installations the user has access to.
 * On first login, auto-discovers installations by matching the
 * user's GitHub login with installation account_login in our DB.
 */

import type { Database } from 'ghagga-db';
import {
  deleteStaleUserMappings,
  getInstallationsByAccountLogin,
  getInstallationsByUserId,
  getRawMappingsByUserId,
  upsertUserMapping,
} from 'ghagga-db';
import { createMiddleware } from 'hono/factory';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'auth' });

// ─── Types ──────────────────────────────────────────────────────

export interface AuthUser {
  githubUserId: number;
  githubLogin: string;
  installationIds: number[];
}

// Augment Hono's context variable map so c.get('user') is typed
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

// ─── Token Cache ────────────────────────────────────────────────

interface GitHubUser {
  id: number;
  login: string;
}

interface CachedUser {
  user: GitHubUser;
  expiresAt: number;
}

export const tokenCache = new Map<string, CachedUser>();
// Token cache TTL: balance between reducing GitHub API calls and
// limiting the window where a revoked token remains valid.
// 2 minutes is acceptable for a code review tool.
const CACHE_TTL_MS = 2 * 60 * 1000;

function getCachedUser(token: string): GitHubUser | null {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  tokenCache.delete(token);
  return null;
}

function cacheUser(token: string, user: GitHubUser): void {
  tokenCache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
  // Inline cleanup when cache is very large (immediate pressure relief)
  if (tokenCache.size > 1000) {
    cleanupExpiredTokens();
  }
}

/**
 * Remove all expired entries from the token cache.
 * Called both inline (when cache exceeds 1000) and periodically.
 */
export function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [key, value] of tokenCache) {
    if (value.expiresAt <= now) tokenCache.delete(key);
  }
}

// Periodic cleanup every 5 minutes so expired tokens don't accumulate
// in low-traffic deployments. `.unref()` prevents keeping the process alive.
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
export const cleanupInterval = setInterval(cleanupExpiredTokens, CLEANUP_INTERVAL_MS);
cleanupInterval.unref();

// ─── Middleware ──────────────────────────────────────────────────

/**
 * Create the auth middleware.
 * Requires a database instance for looking up user-installation mappings.
 */
export function authMiddleware(db: Database) {
  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice('Bearer '.length);

    if (!token) {
      return c.json({ error: 'Missing token' }, 401);
    }

    // Verify token: check cache first, then call GitHub API
    let githubUserId: number;
    let githubLogin: string;

    const cachedUser = getCachedUser(token);
    if (cachedUser) {
      githubUserId = cachedUser.id;
      githubLogin = cachedUser.login;
    } else {
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        if (!response.ok) {
          logger.warn({ status: response.status }, 'Token verification failed');
          return c.json({ error: 'Invalid or expired token' }, 401);
        }

        const userData = (await response.json()) as {
          id: number;
          login: string;
          expires_at?: string;
        };

        // Belt-and-suspenders: reject tokens with an expired expires_at field.
        // GitHub API would likely reject expired tokens anyway, but this catches
        // edge cases where a stale response is cached or token just expired.
        if (userData.expires_at && new Date(userData.expires_at) < new Date()) {
          logger.warn(
            { expiresAt: userData.expires_at },
            'Token has expired (expires_at in the past)',
          );
          return c.json({ error: 'Token has expired' }, 401);
        }

        githubUserId = userData.id;
        githubLogin = userData.login;

        // Cache the verified user
        cacheUser(token, { id: githubUserId, login: githubLogin });
      } catch (err) {
        logger.error({ err }, 'Failed to call GitHub /user API');
        return c.json(
          { error: 'GitHub API is temporarily unavailable. Please try again later.' },
          503,
          { 'Retry-After': '30' },
        );
      }
    }

    // Look up which installations the user has access to
    try {
      // Step 1: Get raw mappings (includes stale ones pointing to inactive installations)
      const rawMappings = await getRawMappingsByUserId(db, githubUserId);

      let userInstallations: Awaited<ReturnType<typeof getInstallationsByUserId>>;

      if (rawMappings.length === 0) {
        // No mappings at all → auto-discover
        logger.info(
          { githubLogin, githubUserId },
          'No mappings found, auto-discovering installations',
        );
        userInstallations = await discoverAndMapInstallations(db, githubUserId, githubLogin);
      } else {
        // Step 2: Get active installations (JOIN filters by is_active = true)
        userInstallations = await getInstallationsByUserId(db, githubUserId);

        // Step 3: Detect stale mappings
        const activeInstallationIds = new Set(userInstallations.map((inst) => inst.id));
        const staleMappings = rawMappings.filter(
          (m) => !activeInstallationIds.has(m.installationId),
        );

        if (staleMappings.length > 0) {
          const staleIds = staleMappings.map((m) => m.id);
          logger.info(
            { githubLogin, githubUserId, staleIds, staleMappingCount: staleIds.length },
            'Cleaning up stale user-installation mappings',
          );
          await deleteStaleUserMappings(db, staleIds);

          // Step 4: If no active installations remain, re-discover
          if (userInstallations.length === 0) {
            logger.info(
              { githubLogin, githubUserId },
              'All mappings were stale, re-discovering installations',
            );
            userInstallations = await discoverAndMapInstallations(db, githubUserId, githubLogin);
          }
        }
      }

      const installationIds = userInstallations.map((inst) => inst.id);
      logger.debug({ githubLogin, installationIds }, 'User authenticated');

      c.set('user', {
        githubUserId,
        githubLogin,
        installationIds,
      });
    } catch (err) {
      logger.error({ err, githubLogin, githubUserId }, 'Error looking up user installations');
      return c.json({ error: 'Internal server error' }, 500);
    }

    await next();
  });
}

// ─── Auto-Discovery ─────────────────────────────────────────────

/**
 * Find installations in our DB whose account_login matches the
 * user's GitHub login, and create the user-installation mappings.
 */
async function discoverAndMapInstallations(
  db: Database,
  githubUserId: number,
  githubLogin: string,
) {
  try {
    const matchedInstallations = await getInstallationsByAccountLogin(db, githubLogin);

    if (matchedInstallations.length === 0) {
      logger.warn({ githubLogin }, 'No installations found for account');
      return [];
    }

    for (const installation of matchedInstallations) {
      logger.info(
        { githubLogin, installationId: installation.id, account: installation.accountLogin },
        'Creating user-installation mapping',
      );
      await upsertUserMapping(db, {
        githubUserId,
        githubLogin,
        installationId: installation.id,
      });
    }

    return matchedInstallations;
  } catch (err) {
    logger.error({ err, githubLogin }, 'Error discovering installations');
    return [];
  }
}
