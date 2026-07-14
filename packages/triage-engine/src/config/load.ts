/**
 * Config resolution + loading for the triage engine.
 *
 * Resolution precedence (per design.md "CLI surface"):
 *   1. explicit `--config` path
 *   2. `$GHAGGA_TRIAGE_CONFIG` env var
 *   3. `<cwd>/.ghagga/triage.config.json` (default)
 *
 * Loading reads the resolved path (JSON only for now — `.ts` config support
 * is deferred to the CLI wiring phase) and validates it against
 * `TriageConfigSchema`, throwing a descriptive error on any failure so no
 * pipeline stage starts with an invalid config.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TriageConfig, TriageConfigSchema } from './schema.js';

const DEFAULT_CONFIG_RELATIVE_PATH = '.ghagga/triage.config.json';

export interface ResolveConfigPathOptions {
  /** Explicit path from a CLI `--config` flag, if provided. */
  explicitPath?: string;
  /** Working directory to resolve the default location against. Defaults to `process.cwd()`. */
  cwd?: string;
}

export function resolveConfigPath(options: ResolveConfigPathOptions): string {
  if (options.explicitPath) {
    return options.explicitPath;
  }

  const envPath = process.env.GHAGGA_TRIAGE_CONFIG;
  if (envPath) {
    return envPath;
  }

  const cwd = options.cwd ?? process.cwd();
  return join(cwd, DEFAULT_CONFIG_RELATIVE_PATH);
}

export function loadConfig(configPath: string): TriageConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (cause) {
    throw new Error(
      `Failed to read triage config at "${configPath}": file not found or unreadable`,
      {
        cause,
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse triage config at "${configPath}": invalid JSON`, { cause });
  }

  const result = TriageConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid triage config at "${configPath}":\n${issues}`);
  }

  return result.data;
}
