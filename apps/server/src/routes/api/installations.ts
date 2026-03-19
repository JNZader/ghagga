/**
 * Installation-related API routes:
 *   GET /api/installations
 *   GET /api/installation-settings
 *   PUT /api/installation-settings
 */

import type { SaaSProvider } from 'ghagga-core';
import { OPENCODE_ENV_BY_PREFIX, toolRegistry } from 'ghagga-core';
import type { Database, DbProviderChainEntry, RepoSettings } from 'ghagga-db';
import {
  DEFAULT_REPO_SETTINGS,
  encrypt,
  getInstallationById,
  getInstallationSettings,
  upsertInstallationSettings,
} from 'ghagga-db';
import { Hono } from 'hono';
import type { AuthUser } from '../../middleware/auth.js';
import { buildProviderChainView, generateErrorId, logger } from './utils.js';

function getRegisteredToolsList() {
  return toolRegistry.getAll().map((t) => ({
    name: t.name,
    displayName: t.displayName,
    category: t.category,
    tier: t.tier,
  }));
}

export function createInstallationsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/installations ──────────────────────────────────
  router.get('/api/installations', async (c) => {
    const user = c.get('user') as AuthUser;

    try {
      const installationsRaw = await Promise.all(
        user.installationIds.map((id) => getInstallationById(db, id)),
      );
      const results = installationsRaw
        .filter((inst): inst is NonNullable<typeof inst> => inst != null)
        .map((inst) => ({
          id: inst.id,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
        }));
      return c.json({ data: results });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, user: user.githubLogin }, 'Failed to fetch installations');
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch installations', errorId },
        500,
      );
    }
  });

  // ── GET /api/installation-settings ─────────────────────────
  router.get('/api/installation-settings', async (c) => {
    const user = c.get('user') as AuthUser;
    const installationId = parseInt(c.req.query('installation_id') ?? '', 10);

    if (Number.isNaN(installationId)) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'Missing or invalid installation_id parameter' },
        400,
      );
    }

    if (!user.installationIds.includes(installationId)) {
      return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
    }

    try {
      const inst = await getInstallationById(db, installationId);
      const row = await getInstallationSettings(db, installationId);

      if (row) {
        const chain = (row.providerChain ?? []) as DbProviderChainEntry[];
        const settings = (row.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings;

        return c.json({
          data: {
            installationId,
            accountLogin: inst?.accountLogin ?? '',
            providerChain: buildProviderChainView(chain),
            aiReviewEnabled: row.aiReviewEnabled,
            reviewMode: row.reviewMode,
            enableSemgrep: settings.enableSemgrep,
            enableTrivy: settings.enableTrivy,
            enableCpd: settings.enableCpd,
            enableMemory: settings.enableMemory,
            customRules: (settings.customRules ?? []).join('\n'),
            ignorePatterns: settings.ignorePatterns ?? [],
            enabledTools: settings.enabledTools ?? [],
            disabledTools: settings.disabledTools ?? [],
            enableBlastRadius: settings.enableBlastRadius ?? false,
            registeredTools: getRegisteredToolsList(),
          },
        });
      }

      // No settings exist yet — return defaults
      return c.json({
        data: {
          installationId,
          accountLogin: inst?.accountLogin ?? '',
          providerChain: [],
          aiReviewEnabled: true,
          reviewMode: 'simple',
          enableSemgrep: true,
          enableTrivy: true,
          enableCpd: true,
          enableMemory: true,
          customRules: '',
          ignorePatterns: DEFAULT_REPO_SETTINGS.ignorePatterns,
          enabledTools: [],
          disabledTools: [],
          enableBlastRadius: false,
          registeredTools: getRegisteredToolsList(),
        },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, installationId, user: user.githubLogin },
        'Failed to fetch installation settings',
      );
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch installation settings', errorId },
        500,
      );
    }
  });

  // ── PUT /api/installation-settings ─────────────────────────
  router.put('/api/installation-settings', async (c) => {
    const user = c.get('user') as AuthUser;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const installationId = body.installationId as number | undefined;
    if (!installationId || typeof installationId !== 'number') {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'Missing or invalid installationId' },
        400,
      );
    }

    if (!user.installationIds.includes(installationId)) {
      return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
    }

    try {
      // Validate and merge provider chain
      const incomingChain = (body.providerChain ?? []) as Array<{
        provider: string;
        model: string;
        apiKey?: string;
        cliModel?: string;
        gatewayUrl?: string;
      }>;

      const VALID_SAAS_PROVIDERS = [
        'anthropic',
        'openai',
        'google',
        'github',
        'qwen',
        'groq',
        'cerebras',
        'deepseek',
        'openrouter',
        'cli-bridge',
        'gateway',
      ];
      for (const entry of incomingChain) {
        if (!VALID_SAAS_PROVIDERS.includes(entry.provider)) {
          return c.json(
            {
              error: 'VALIDATION_ERROR',
              message: `Provider '${entry.provider}' is not available in the SaaS dashboard`,
            },
            400,
          );
        }
      }

      // Strip cliModel for gateway entries (not applicable) and gatewayUrl for non-gateway
      for (const entry of incomingChain) {
        if (entry.provider === 'gateway') {
          entry.cliModel = undefined;
        } else {
          entry.gatewayUrl = undefined;
        }
      }

      // Validate cliModel for cli-bridge entries
      for (const entry of incomingChain) {
        if (entry.provider !== 'cli-bridge') continue;

        if (entry.model === 'opencode') {
          // cliModel is REQUIRED for opencode
          if (!entry.cliModel?.trim()) {
            return c.json(
              {
                error: 'VALIDATION_ERROR',
                message:
                  "cliModel is required when CLI tool is 'opencode'. Expected format: 'provider/model' (e.g., 'anthropic/claude-sonnet-4-5').",
              },
              400,
            );
          }
          // Validate provider/model format
          if (!/^[^/]+\/.+$/.test(entry.cliModel)) {
            return c.json(
              {
                error: 'VALIDATION_ERROR',
                message: `Invalid cliModel format: '${entry.cliModel}'. Expected 'provider/model' (e.g., 'anthropic/claude-sonnet-4-5').`,
              },
              400,
            );
          }
          // Validate provider prefix is supported
          const prefix = entry.cliModel.split('/')[0]!;
          if (!(prefix in OPENCODE_ENV_BY_PREFIX)) {
            const supported = Object.keys(OPENCODE_ENV_BY_PREFIX).join(', ');
            return c.json(
              {
                error: 'VALIDATION_ERROR',
                message: `Unsupported OpenCode provider prefix: '${prefix}'. Supported: ${supported}.`,
              },
              400,
            );
          }
        } else {
          // For non-opencode tools (auto, gemini, copilot), strip cliModel
          entry.cliModel = undefined;
        }
      }

      // Merge API keys: build a Map of all known keys by provider,
      // then resolve each entry from the map. When a new key is provided,
      // update the map so subsequent entries of the same provider reuse it.
      const existingRow = await getInstallationSettings(db, installationId);
      const existingChain = existingRow
        ? ((existingRow.providerChain ?? []) as DbProviderChainEntry[])
        : [];

      const keysByProvider = new Map<string, string>();
      for (const e of existingChain) {
        if (e.encryptedApiKey) {
          keysByProvider.set(e.provider, e.encryptedApiKey);
        }
      }

      // Debug: log what we received and what we have in the map
      logger.info(
        {
          incomingProviders: incomingChain.map((e) => ({
            provider: e.provider,
            model: e.model,
            hasApiKey: !!e.apiKey,
            apiKeyLength: e.apiKey?.length ?? 0,
          })),
          existingProviders: [...keysByProvider.keys()],
        },
        'Chain merge debug',
      );

      const mergedChain: DbProviderChainEntry[] = incomingChain.map((entry, idx) => {
        // Resolve cliModel: only meaningful for cli-bridge entries
        const cliModel = entry.provider === 'cli-bridge' ? entry.cliModel : undefined;
        // Resolve gatewayUrl: only meaningful for gateway entries
        const gatewayUrl = entry.provider === 'gateway' ? entry.gatewayUrl : undefined;

        if (entry.apiKey) {
          const encrypted = encrypt(entry.apiKey);
          keysByProvider.set(entry.provider, encrypted);
          logger.info({ idx, provider: entry.provider, action: 'NEW_KEY' }, 'Chain entry: new key');
          const result: DbProviderChainEntry = {
            provider: entry.provider as SaaSProvider,
            model: entry.model,
            encryptedApiKey: encrypted,
          };
          if (cliModel) result.cliModel = cliModel;
          if (gatewayUrl) result.gatewayUrl = gatewayUrl;
          return result;
        }
        if (entry.provider === 'github') {
          return {
            provider: entry.provider as SaaSProvider,
            model: entry.model,
            encryptedApiKey: null,
          };
        }
        const resolved = keysByProvider.get(entry.provider) ?? null;
        logger.info(
          { idx, provider: entry.provider, action: resolved ? 'RESOLVED_FROM_MAP' : 'NULL_KEY' },
          'Chain entry: resolved',
        );
        const result: DbProviderChainEntry = {
          provider: entry.provider as SaaSProvider,
          model: entry.model,
          encryptedApiKey: resolved,
        };
        if (cliModel) result.cliModel = cliModel;
        if (gatewayUrl) result.gatewayUrl = gatewayUrl;
        return result;
      });

      // Build settings JSONB
      const currentSettings = existingRow
        ? ((existingRow.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings)
        : DEFAULT_REPO_SETTINGS;

      const settingsUpdate: RepoSettings = {
        enableSemgrep:
          typeof body.enableSemgrep === 'boolean'
            ? body.enableSemgrep
            : currentSettings.enableSemgrep,
        enableTrivy:
          typeof body.enableTrivy === 'boolean' ? body.enableTrivy : currentSettings.enableTrivy,
        enableCpd: typeof body.enableCpd === 'boolean' ? body.enableCpd : currentSettings.enableCpd,
        enableMemory:
          typeof body.enableMemory === 'boolean' ? body.enableMemory : currentSettings.enableMemory,
        customRules:
          typeof body.customRules === 'string'
            ? (body.customRules as string)
                .split('\n')
                .map((r: string) => r.trim())
                .filter(Boolean)
            : currentSettings.customRules,
        ignorePatterns: Array.isArray(body.ignorePatterns)
          ? (body.ignorePatterns as string[])
          : currentSettings.ignorePatterns,
        reviewLevel:
          typeof body.reviewLevel === 'string'
            ? (body.reviewLevel as RepoSettings['reviewLevel'])
            : currentSettings.reviewLevel,
        enabledTools: Array.isArray(body.enabledTools)
          ? (body.enabledTools as string[])
          : currentSettings.enabledTools,
        disabledTools: Array.isArray(body.disabledTools)
          ? (body.disabledTools as string[])
          : currentSettings.disabledTools,
        enableBlastRadius:
          typeof body.enableBlastRadius === 'boolean'
            ? body.enableBlastRadius
            : currentSettings.enableBlastRadius,
      };

      await upsertInstallationSettings(db, installationId, {
        providerChain: mergedChain,
        aiReviewEnabled:
          typeof body.aiReviewEnabled === 'boolean' ? body.aiReviewEnabled : undefined,
        reviewMode: typeof body.reviewMode === 'string' ? body.reviewMode : undefined,
        settings: settingsUpdate,
      });

      logger.info(
        { installationId, user: user.githubLogin, chainLength: mergedChain.length },
        'Installation settings updated',
      );
      return c.json({ data: { message: 'Installation settings updated' } });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, installationId, user: user.githubLogin },
        'Failed to update installation settings',
      );
      return c.json(
        { error: 'UPDATE_FAILED', message: 'Failed to update installation settings', errorId },
        500,
      );
    }
  });

  return router;
}
