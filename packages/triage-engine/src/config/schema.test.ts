/**
 * TriageConfig zod schema tests.
 *
 * Covers: valid config parsing, per-field rejection (forge, repo, loginRecipe
 * discriminated union variants), and default application.
 */

import { describe, expect, it } from 'vitest';
import { TriageConfigSchema } from './schema.js';

const baseValidConfig = {
  forge: 'gitlab' as const,
  repo: 'acme/widgets',
  codeRoot: '/abs/path/to/repo',
  models: { rerank: 'anthropic/claude-haiku', analysis: 'anthropic/claude-sonnet' },
};

describe('TriageConfigSchema', () => {
  describe('valid config', () => {
    it('parses a minimal valid config and applies defaults', () => {
      const result = TriageConfigSchema.parse(baseValidConfig);

      expect(result.forge).toBe('gitlab');
      expect(result.repo).toBe('acme/widgets');
      expect(result.language).toBe('go');
      expect(result.graphExpand).toBe(false);
    });

    it('parses a full config including app.loginRecipe (steps kind)', () => {
      const full = {
        ...baseValidConfig,
        moduleMap: { billing: ['src/billing'] },
        synonyms: { factura: ['invoice', 'bill'] },
        stopwords: ['el', 'la', 'de'],
        language: 'ts' as const,
        graphExpand: true,
        app: {
          baseURL: 'https://staging.example.com',
          loginRecipe: {
            kind: 'steps' as const,
            steps: [
              { action: 'goto' as const, url: '/login' },
              { action: 'fill' as const, label: 'Email', value: 'user@example.com' },
              { action: 'click' as const, role: 'button', name: 'Sign in' },
            ],
          },
        },
        clientReplyPolicy: { language: 'es', jargonBan: ['stack trace', 'null pointer'] },
      };

      const result = TriageConfigSchema.parse(full);

      expect(result.language).toBe('ts');
      expect(result.graphExpand).toBe(true);
      expect(result.app?.loginRecipe.kind).toBe('steps');
      if (result.app?.loginRecipe.kind === 'steps') {
        expect(result.app.loginRecipe.steps).toHaveLength(3);
      }
    });
  });

  describe('forge validation', () => {
    it('rejects an unrecognized forge value', () => {
      const invalid = { ...baseValidConfig, forge: 'bitbucket' };

      const result = TriageConfigSchema.safeParse(invalid);

      expect(result.success).toBe(false);
      if (!result.success) {
        const forgeIssue = result.error.issues.find((issue) => issue.path[0] === 'forge');
        expect(forgeIssue).toBeDefined();
      }
    });
  });

  describe('required fields', () => {
    it('rejects a config missing repo', () => {
      const { repo: _repo, ...withoutRepo } = baseValidConfig;

      const result = TriageConfigSchema.safeParse(withoutRepo);

      expect(result.success).toBe(false);
      if (!result.success) {
        const repoIssue = result.error.issues.find((issue) => issue.path[0] === 'repo');
        expect(repoIssue).toBeDefined();
      }
    });

    it('rejects a config missing models', () => {
      const { models: _models, ...withoutModels } = baseValidConfig;

      const result = TriageConfigSchema.safeParse(withoutModels);

      expect(result.success).toBe(false);
      if (!result.success) {
        const modelsIssue = result.error.issues.find((issue) => issue.path[0] === 'models');
        expect(modelsIssue).toBeDefined();
      }
    });
  });

  describe('models.reproduce (optional)', () => {
    it('parses a config with no models.reproduce field (backward-compatible)', () => {
      const result = TriageConfigSchema.parse(baseValidConfig);

      expect(result.models.reproduce).toBeUndefined();
    });

    it('parses a config with models.reproduce set', () => {
      const config = {
        ...baseValidConfig,
        models: { ...baseValidConfig.models, reproduce: 'opencode-go/kimi-k2.7-code' },
      };

      const result = TriageConfigSchema.parse(config);

      expect(result.models.reproduce).toBe('opencode-go/kimi-k2.7-code');
    });
  });

  describe('loginRecipe discriminated union', () => {
    it('accepts kind: none with no extra fields', () => {
      const config = {
        ...baseValidConfig,
        app: { baseURL: 'https://example.com', loginRecipe: { kind: 'none' } },
      };

      const result = TriageConfigSchema.parse(config);

      expect(result.app?.loginRecipe.kind).toBe('none');
    });

    it('accepts kind: storageState with a path', () => {
      const config = {
        ...baseValidConfig,
        app: {
          baseURL: 'https://example.com',
          loginRecipe: { kind: 'storageState', path: './.auth/session.storageState.json' },
        },
      };

      const result = TriageConfigSchema.parse(config);

      expect(result.app?.loginRecipe.kind).toBe('storageState');
      if (result.app?.loginRecipe.kind === 'storageState') {
        expect(result.app.loginRecipe.path).toBe('./.auth/session.storageState.json');
      }
    });

    it('rejects kind: storageState missing path', () => {
      const config = {
        ...baseValidConfig,
        app: {
          baseURL: 'https://example.com',
          loginRecipe: { kind: 'storageState' },
        },
      };

      const result = TriageConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
    });

    it('rejects an unrecognized loginRecipe kind', () => {
      const config = {
        ...baseValidConfig,
        app: {
          baseURL: 'https://example.com',
          loginRecipe: { kind: 'oauth-popup' },
        },
      };

      const result = TriageConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
    });
  });
});
