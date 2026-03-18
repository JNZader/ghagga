/**
 * Repo settings API routes: GET /api/settings, PUT /api/settings
 *
 * Also includes:
 *   POST /api/providers/validate (provider key validation)
 *   POST /api/settings/copy-to-global (copy repo config to installation-level)
 */

import type { SaaSProvider } from 'ghagga-core';
import { toolRegistry } from 'ghagga-core';
import type { Database, DbProviderChainEntry, RepoSettings } from 'ghagga-db';
import {
  DEFAULT_REPO_SETTINGS,
  decrypt,
  encrypt,
  getInstallationSettings,
  getInstallationSettingsBatch,
  getRepoByFullName,
  getRepositoryById,
  updateDelegatedCiPolicy,
  updateRepoSettings,
  upsertInstallationSettings,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
import { validateProviderKey } from '../../lib/provider-models.js';
import type { AuthUser } from '../../middleware/auth.js';
import { buildProviderChainView, generateErrorId, logger, maskApiKey } from './utils.js';

// ─── Zod Schemas ────────────────────────────────────────────────

const RepoSettingsSchema = z
  .object({
    enableSemgrep: z.boolean().optional(),
    enableTrivy: z.boolean().optional(),
    enableCpd: z.boolean().optional(),
    enableMemory: z.boolean().optional(),
    aiReviewEnabled: z.boolean().optional(),
    reviewLevel: z.enum(['soft', 'normal', 'strict']).optional(),
    customRules: z.union([z.string(), z.array(z.string())]).optional(),
    ignorePatterns: z.array(z.string()).optional(),
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    enableBlastRadius: z.boolean().optional(),
  })
  .strict();

const DelegatedCiJobSchema = z.object({
  jobKey: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200),
  classification: z.enum(['safe/delegable', 'sensitive/no-delegable']),
  profile: z.enum(['node-lint', 'node-unit', 'python-lint', 'python-pytest', 'go-test']),
  enabled: z.boolean(),
  allowArtifacts: z.union([z.literal(false), z.array(z.string())]),
  allowCache: z.boolean(),
  maxDurationMinutes: z.number().int().min(1).max(30).optional(),
  rationale: z.string().max(500).optional(),
});

const DelegatedCiPolicySchema = z
  .object({
    enabled: z.boolean(),
    allowManualTrigger: z.boolean().optional(),
    allowPullRequestTrigger: z.boolean().optional(),
    jobs: z.array(DelegatedCiJobSchema).max(10),
  })
  .nullable();

/** Map of deprecated boolean field names to their tool names */
const DEPRECATED_TOOL_BOOLEANS: Record<string, string> = {
  enableSemgrep: 'semgrep',
  enableTrivy: 'trivy',
  enableCpd: 'cpd',
};

/** Get all valid tool names from the registry */
function getValidToolNames(): Set<string> {
  return new Set(toolRegistry.getAll().map((t) => t.name));
}

/** Get the registered tools list for API responses */
function getRegisteredToolsList() {
  return toolRegistry.getAll().map((t) => ({
    name: t.name,
    displayName: t.displayName,
    category: t.category,
    tier: t.tier,
  }));
}

export function createSettingsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/settings ────────────────────────────────────────
  router.get('/api/settings', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');

    if (!repoFullName) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'Missing required query parameter: repo' },
        400,
      );
    }

    try {
      const repo = await getRepoByFullName(db, repoFullName);

      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      const settings = repo.settings as RepoSettings;
      const chain = (repo.providerChain ?? []) as DbProviderChainEntry[];

      // Build view: mask keys, never expose encrypted values
      const providerChainView = buildProviderChainView(chain);

      // Fetch global settings for reference
      const globalRow = await getInstallationSettings(db, repo.installationId);
      let globalSettings: Record<string, unknown> | undefined;
      if (globalRow) {
        const gChain = (globalRow.providerChain ?? []) as DbProviderChainEntry[];
        const gSettings = (globalRow.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings;
        globalSettings = {
          providerChain: buildProviderChainView(gChain),
          aiReviewEnabled: globalRow.aiReviewEnabled,
          reviewMode: globalRow.reviewMode,
          enableSemgrep: gSettings.enableSemgrep,
          enableTrivy: gSettings.enableTrivy,
          enableCpd: gSettings.enableCpd,
          enableMemory: gSettings.enableMemory,
          customRules: (gSettings.customRules ?? []).join('\n'),
          ignorePatterns: gSettings.ignorePatterns ?? [],
          enabledTools: gSettings.enabledTools ?? [],
          disabledTools: gSettings.disabledTools ?? [],
          enableBlastRadius: gSettings.enableBlastRadius ?? false,
        };
      }

      return c.json({
        data: {
          repoId: repo.id,
          repoFullName: repo.fullName,
          useGlobalSettings: repo.useGlobalSettings,
          aiReviewEnabled: repo.aiReviewEnabled,
          providerChain: providerChainView,
          reviewMode: repo.reviewMode,
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
          delegatedCiPolicy: repo.delegatedCiPolicy ?? null,
          globalSettings,
        },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to fetch settings',
      );
      return c.json({ error: 'FETCH_FAILED', message: 'Failed to fetch settings', errorId }, 500);
    }
  });

  // ── PUT /api/settings ───────────────────────────────────────
  router.put('/api/settings', async (c) => {
    const user = c.get('user') as AuthUser;

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const repoFullName = body.repoFullName as string | undefined;
    if (!repoFullName) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Missing repoFullName' }, 400);
    }

    // Validate settings fields with Zod (if any settings-related fields are present)
    const settingsFields: Record<string, unknown> = {};
    const SETTINGS_KEYS = [
      'enableSemgrep',
      'enableTrivy',
      'enableCpd',
      'enableMemory',
      'aiReviewEnabled',
      'reviewLevel',
      'customRules',
      'ignorePatterns',
      'enabledTools',
      'disabledTools',
      'enableBlastRadius',
    ];
    for (const key of SETTINGS_KEYS) {
      if (key in body) {
        settingsFields[key] = body[key];
      }
    }

    if (Object.keys(settingsFields).length > 0) {
      const parsed = RepoSettingsSchema.safeParse(settingsFields);
      if (!parsed.success) {
        return c.json(
          {
            error: 'VALIDATION_ERROR',
            message: 'Invalid settings',
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }

      // Validate tool names against the registry
      const validToolNames = getValidToolNames();
      const toolArrayFields = ['enabledTools', 'disabledTools'] as const;
      for (const field of toolArrayFields) {
        const tools = parsed.data[field];
        if (tools && tools.length > 0) {
          const invalidTools = tools.filter((t: string) => !validToolNames.has(t));
          if (invalidTools.length > 0) {
            return c.json(
              {
                error: 'VALIDATION_ERROR',
                message: `Unknown tool name(s): ${invalidTools.join(', ')}`,
                details: invalidTools.map((name: string) => ({
                  path: field,
                  message: `Unknown tool: "${name}"`,
                })),
              },
              400,
            );
          }
        }
      }
    }

    try {
      const repo = await getRepoByFullName(db, repoFullName);
      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      // Validate no Ollama in the chain
      const incomingChain = (body.providerChain ?? []) as Array<{
        provider: string;
        model: string;
        apiKey?: string;
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

      // Merge API keys: preserve existing encrypted keys when not provided
      const existingChain = (repo.providerChain ?? []) as DbProviderChainEntry[];

      // Bug 2 fix: load global/installation chain as fallback source for keys
      // When a repo switches from Global→Custom, it may not have its own keys yet.
      const globalRow = await getInstallationSettings(db, repo.installationId);
      const globalChain = (globalRow?.providerChain ?? []) as DbProviderChainEntry[];

      const mergedChain: DbProviderChainEntry[] = incomingChain.map((entry) => {
        if (entry.apiKey) {
          // New key provided → encrypt it
          return {
            provider: entry.provider as SaaSProvider,
            model: entry.model,
            encryptedApiKey: encrypt(entry.apiKey),
          };
        }

        if (entry.provider === 'github') {
          // GitHub Models doesn't need an API key
          return {
            provider: 'github' as const,
            model: entry.model,
            encryptedApiKey: null,
          };
        }

        // No key provided → try repo's own chain first, then fall back to global chain.
        // This handles the Global→Custom transition: the repo never had its own key,
        // but the user pre-filled from global and expects it to be inherited/copied.
        const existing = existingChain.find((e) => e.provider === entry.provider);
        if (existing?.encryptedApiKey) {
          return {
            provider: entry.provider as SaaSProvider,
            model: entry.model,
            encryptedApiKey: existing.encryptedApiKey,
          };
        }

        const fromGlobal = globalChain.find((e) => e.provider === entry.provider);
        return {
          provider: entry.provider as SaaSProvider,
          model: entry.model,
          encryptedApiKey: fromGlobal?.encryptedApiKey ?? null,
        };
      });

      // Build settings update
      const currentSettings = (repo.settings ?? {}) as RepoSettings;
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

      // ── Bidirectional translation: old booleans → new arrays ──
      // If old boolean fields were sent, sync them into disabledTools
      for (const [boolField, toolName] of Object.entries(DEPRECATED_TOOL_BOOLEANS)) {
        if (typeof body[boolField] === 'boolean' && !Array.isArray(body.disabledTools)) {
          // Only translate if the new array fields weren't explicitly sent
          const disabled = settingsUpdate.disabledTools ?? [];
          if (body[boolField] === false && !disabled.includes(toolName)) {
            settingsUpdate.disabledTools = [...disabled, toolName];
          } else if (body[boolField] === true) {
            settingsUpdate.disabledTools = disabled.filter((t) => t !== toolName);
          }
        }
      }

      // ── Bidirectional translation: new arrays → old booleans ──
      // If disabledTools was sent, sync back to old boolean fields
      if (Array.isArray(body.disabledTools)) {
        const disabled = body.disabledTools as string[];
        settingsUpdate.enableSemgrep = !disabled.includes('semgrep');
        settingsUpdate.enableTrivy = !disabled.includes('trivy');
        settingsUpdate.enableCpd = !disabled.includes('cpd');
      }

      await updateRepoSettings(db, repo.id, {
        settings: settingsUpdate,
        reviewMode: typeof body.reviewMode === 'string' ? body.reviewMode : undefined,
        aiReviewEnabled:
          typeof body.aiReviewEnabled === 'boolean' ? body.aiReviewEnabled : undefined,
        providerChain: mergedChain,
        useGlobalSettings:
          typeof body.useGlobalSettings === 'boolean' ? body.useGlobalSettings : undefined,
      });

      // ── Delegated CI Policy (repo-only, not inherited) ────────
      if ('delegatedCiPolicy' in body) {
        const parsed = DelegatedCiPolicySchema.safeParse(body.delegatedCiPolicy);
        if (!parsed.success) {
          return c.json(
            {
              error: 'VALIDATION_ERROR',
              message: 'Invalid delegatedCiPolicy',
              details: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
            400,
          );
        }
        await updateDelegatedCiPolicy(db, repo.id, parsed.data);
      }

      logger.info(
        { repo: repoFullName, user: user.githubLogin, chainLength: mergedChain.length },
        'Settings updated',
      );
      return c.json({ data: { message: 'Settings updated' } });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to update settings',
      );
      return c.json({ error: 'UPDATE_FAILED', message: 'Failed to update settings', errorId }, 500);
    }
  });

  // ── GET /api/providers/keys ─────────────────────────────────
  //
  // Returns all saved (masked) API keys for the authenticated user,
  // grouped by provider, across all their installations.
  // Used by the frontend key-selector dropdown in ProviderEntry.
  //
  // Security: only hasApiKey + maskedApiKey are returned — never raw or encrypted values.
  router.get('/api/providers/keys', async (c) => {
    const user = c.get('user') as AuthUser;

    try {
      // Single batch query — avoids N+1 when user has multiple installations.
      const rows = await getInstallationSettingsBatch(db, user.installationIds);

      const keysByProvider: Record<string, { maskedApiKey: string; source: 'global' }> = {};

      for (const row of rows) {
        const chain = (row.providerChain ?? []) as DbProviderChainEntry[];
        for (const entry of chain) {
          // First occurrence per provider wins (primary installation takes precedence).
          if (entry.encryptedApiKey && !keysByProvider[entry.provider]) {
            // Mask directly — avoids the buildProviderChainView([entry])[0] wrapper overhead.
            const masked = maskApiKey(decrypt(entry.encryptedApiKey));
            keysByProvider[entry.provider] = { maskedApiKey: masked, source: 'global' };
          }
        }
      }

      return c.json({ data: keysByProvider });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, user: user.githubLogin }, 'Failed to fetch available keys');
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch available keys', errorId },
        500,
      );
    }
  });

  // ── POST /api/settings/copy-to-global ──────────────────────
  //
  // Copies a repo's provider chain, review mode, and tool toggles
  // to the installation-level (global) settings so all repos
  // using "Global" inherit them.
  router.post('/api/settings/copy-to-global', async (c) => {
    const user = c.get('user') as AuthUser;

    let body: { repoId?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const repoId = body.repoId;
    if (typeof repoId !== 'number') {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Missing or invalid repoId' }, 400);
    }

    try {
      const repo = await getRepositoryById(db, repoId);
      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      const repoSettings = (repo.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings;
      const repoChain = (repo.providerChain ?? []) as DbProviderChainEntry[];

      // Upsert into installation_settings, copying the repo's config
      await upsertInstallationSettings(db, repo.installationId, {
        providerChain: repoChain,
        aiReviewEnabled: repo.aiReviewEnabled,
        reviewMode: repo.reviewMode,
        settings: {
          enableSemgrep: repoSettings.enableSemgrep,
          enableTrivy: repoSettings.enableTrivy,
          enableCpd: repoSettings.enableCpd,
          enableMemory: repoSettings.enableMemory,
          enableBlastRadius: repoSettings.enableBlastRadius,
          customRules: repoSettings.customRules,
          ignorePatterns: repoSettings.ignorePatterns,
          reviewLevel: repoSettings.reviewLevel,
          enabledTools: repoSettings.enabledTools,
          disabledTools: repoSettings.disabledTools,
        },
      });

      logger.info(
        { repoId, repo: repo.fullName, user: user.githubLogin },
        'Copied repo settings to global',
      );
      return c.json({ data: { message: 'Settings copied to global' } });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repoId, user: user.githubLogin },
        'Failed to copy settings to global',
      );
      return c.json(
        { error: 'COPY_FAILED', message: 'Failed to copy settings to global', errorId },
        500,
      );
    }
  });

  // ── POST /api/providers/validate ────────────────────────────
  router.post('/api/providers/validate', async (c) => {
    const user = c.get('user') as AuthUser;

    let body: { provider?: string; apiKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const provider = body.provider;
    if (!provider) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Missing provider field' }, 400);
    }

    if (provider === 'ollama') {
      return c.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Ollama is not available in the SaaS dashboard. Use CLI or Action instead.',
        },
        400,
      );
    }

    const validProviders = [
      'anthropic',
      'openai',
      'google',
      'github',
      'qwen',
      'groq',
      'cerebras',
      'deepseek',
      'openrouter',
    ];
    if (!validProviders.includes(provider)) {
      return c.json({ error: 'VALIDATION_ERROR', message: `Unknown provider: ${provider}` }, 400);
    }

    // For GitHub Models, use the user's session token
    let apiKey = body.apiKey;
    if (provider === 'github') {
      const authHeader = c.req.header('Authorization') ?? '';
      apiKey = authHeader.replace(/^Bearer\s+/i, '');
    } else if (!apiKey) {
      // No key provided — try to resolve from the user's saved installation chain.
      // This allows re-validation (to fetch available models) without re-entering the key.
      const rows = await getInstallationSettingsBatch(db, user.installationIds);
      for (const row of rows) {
        const chain = (row.providerChain ?? []) as DbProviderChainEntry[];
        const entry = chain.find((e) => e.provider === provider);
        if (entry?.encryptedApiKey) {
          apiKey = decrypt(entry.encryptedApiKey);
          break;
        }
      }

      if (!apiKey) {
        return c.json(
          { error: 'VALIDATION_ERROR', message: 'Missing apiKey for non-GitHub provider' },
          400,
        );
      }
    }

    try {
      const result = await validateProviderKey(provider as SaaSProvider, apiKey ?? '');
      return c.json(result);
    } catch (err) {
      logger.error({ err, provider, user: user.githubLogin }, 'Provider validation error');
      return c.json({ valid: false, models: [], error: 'Validation request failed' });
    }
  });

  return router;
}
