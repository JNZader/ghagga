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
  /**
   * Maps a module label (`módulo::x`) to the code scope LOCATE should scan for
   * that module. Each value is an array of entries, and each entry — all
   * relative to `codeRoot` — may be:
   *  - a **directory**, walked recursively (e.g. `apps/backend/internal/alerts`);
   *  - a **file path**, read directly (e.g. `apps/backend/internal/checklist.go`);
   *  - a **glob pattern** (contains `* ? [ ] { }`), resolved with `fs.globSync`
   *    (e.g. `apps/backend/internal/&#42;&#42;/checklist*.go`) — precise + fast when a
   *    module lives in a handful of named files rather than a whole directory.
   * Test files and noise dirs (node_modules, vendor, …) are excluded from ALL
   * entry kinds. Directory-only maps remain fully backward compatible.
   */
  moduleMap: z.record(z.string(), z.array(z.string())).optional(),
  /**
   * Maps a module label (the part after `módulo::`) to the in-app route
   * REPRODUCE should navigate when the issue body has no `Ruta:` line.
   * Overrides the default `/app/<module>` heuristic. Example:
   * `{ "equipos": "/app/tanques" }`.
   */
  moduleRoutes: z.record(z.string(), z.string()).optional(),
  synonyms: z.record(z.string(), z.array(z.string())).optional(),
  stopwords: z.array(z.string()).optional(),
  language: z.enum(['go', 'ts', 'js', 'py', 'rust', 'java']).default('go'),
  graphExpand: z.boolean().default(false),
  /**
   * Which CLI backend drives the triage LLM calls (rerank/analysis/reproduce)
   * through ghagga-core's cli-bridge. Defaults to 'opencode' when omitted (the
   * historical behavior — existing configs are unaffected). Use 'codex' to route
   * the gpt-5.x models via the codex CLI (its own local session, no API key),
   * which is more reliable than the intermittently-flaky opencode-go path.
   */
  cli: z.enum(['opencode', 'codex', 'claude', 'gemini', 'copilot']).optional(),
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
  /**
   * Memory-backed issue DEDUP (mirrors the server worker). When a memory store
   * is wired into the engine (the CLI does this for `ghagga triage`), each
   * issue is checked against prior triaged issues BEFORE the expensive LLM
   * analysis; a confident hit yields a cheap DUPLICATE draft instead.
   *
   * OMITTED ⇒ ENABLED when a memory store is available (the engine defaults
   * `enabled` to `true`). Dedup is always a no-op when no store is wired.
   * Set `{ "enabled": false }` to opt out even with a store present.
   */
  dedup: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
});

export type TriageConfig = z.infer<typeof TriageConfigSchema>;
