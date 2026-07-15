/**
 * Config loader tests.
 *
 * Covers: resolving a config path (explicit > default location > env var),
 * loading + validating a JSON config fixture, and clean error reporting on
 * missing/invalid files.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveConfigPath } from './load.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a valid JSON fixture and returns a typed, validated config', () => {
    const configPath = join(dir, 'triage.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        forge: 'gitlab',
        repo: 'acme/widgets',
        codeRoot: '/abs/path',
        models: { rerank: 'model-a', analysis: 'model-b' },
      }),
    );

    const config = loadConfig(configPath);

    expect(config.forge).toBe('gitlab');
    expect(config.repo).toBe('acme/widgets');
    expect(config.language).toBe('go');
  });

  it('throws a clear error when the file does not exist', () => {
    const missingPath = join(dir, 'does-not-exist.json');

    expect(() => loadConfig(missingPath)).toThrowError(/does-not-exist\.json/);
  });

  it('throws a clear error when the JSON is malformed', () => {
    const configPath = join(dir, 'broken.config.json');
    writeFileSync(configPath, '{ not valid json');

    expect(() => loadConfig(configPath)).toThrowError(/broken\.config\.json/);
  });

  it('throws a clear error when the config fails schema validation', () => {
    const configPath = join(dir, 'invalid.config.json');
    writeFileSync(configPath, JSON.stringify({ forge: 'gitlab' }));

    expect(() => loadConfig(configPath)).toThrowError(/repo/);
  });
});

describe('resolveConfigPath', () => {
  const ORIGINAL_ENV = process.env.GHAGGA_TRIAGE_CONFIG;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.GHAGGA_TRIAGE_CONFIG;
    } else {
      process.env.GHAGGA_TRIAGE_CONFIG = ORIGINAL_ENV;
    }
  });

  it('prefers an explicit path over the env var', () => {
    process.env.GHAGGA_TRIAGE_CONFIG = '/from/env.json';

    const resolved = resolveConfigPath({ explicitPath: '/from/flag.json' });

    expect(resolved).toBe('/from/flag.json');
  });

  it('falls back to the env var when no explicit path is given', () => {
    process.env.GHAGGA_TRIAGE_CONFIG = '/from/env.json';

    const resolved = resolveConfigPath({});

    expect(resolved).toBe('/from/env.json');
  });

  it('falls back to the default ./.ghagga/triage.config.json when neither is set', () => {
    delete process.env.GHAGGA_TRIAGE_CONFIG;

    const resolved = resolveConfigPath({ cwd: '/repo' });

    expect(resolved).toBe('/repo/.ghagga/triage.config.json');
  });
});
