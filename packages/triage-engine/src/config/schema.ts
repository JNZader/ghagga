/**
 * TriageConfig — zod schema for the config-driven triage engine.
 *
 * The engine derives ALL project-specific behavior (forge, repo, code root,
 * module map, synonyms, stopwords, app base URL, login recipe) from a single
 * validated config object. No project-specific literal (repo names,
 * languages, dirs, stopwords) is hardcoded in engine source — see design.md
 * "Config-Driven Engine" requirement.
 */

import { z } from 'zod';

// ─── loginRecipe (discriminated union) ─────────────────────────

const LoginStepSchema = z.object({
  action: z.enum(['goto', 'fill', 'click']),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
});

const LoginRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('steps'), steps: z.array(LoginStepSchema) }),
  z.object({ kind: z.literal('storageState'), path: z.string() }),
]);

export type LoginStep = z.infer<typeof LoginStepSchema>;
export type LoginRecipe = z.infer<typeof LoginRecipeSchema>;

// ─── TriageConfig ───────────────────────────────────────────────

export const TriageConfigSchema = z.object({
  forge: z.enum(['gitlab', 'github']),
  repo: z.string().min(1, 'repo is required (owner/name)'),
  codeRoot: z.string().min(1, 'codeRoot is required (absolute path to target repo)'),
  moduleMap: z.record(z.string(), z.array(z.string())).optional(),
  synonyms: z.record(z.string(), z.array(z.string())).optional(),
  stopwords: z.array(z.string()).optional(),
  language: z.enum(['go', 'ts', 'js', 'py', 'rust', 'java']).default('go'),
  graphExpand: z.boolean().default(false),
  models: z.object({
    rerank: z.string().min(1),
    analysis: z.string().min(1),
    reproduce: z.string().min(1).optional(),
  }),
  app: z
    .object({
      baseURL: z.string().url(),
      loginRecipe: LoginRecipeSchema,
    })
    .optional(),
  clientReplyPolicy: z
    .object({
      language: z.string(),
      jargonBan: z.array(z.string()).optional(),
    })
    .optional(),
});

export type TriageConfig = z.infer<typeof TriageConfigSchema>;
