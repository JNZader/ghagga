/**
 * Tests for environment variable validation (fail-fast at startup).
 *
 * Tests the detection logic (`getMissingEnvVars`) and the
 * `validateEnvironment` function that calls `process.exit(1)`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMissingEnvVars, REQUIRED_ENV_VARS, validateEnvironment } from './validate-env.js';

// ─── Mock the logger so we don't emit real log output ──────────

vi.mock('./logger.js', () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Helpers ───────────────────────────────────────────────────

/** Build a fake env object where every required var is present. */
function fullEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of REQUIRED_ENV_VARS) {
    env[name] = `test-value-for-${name}`;
  }
  return env;
}

// ─── REQUIRED_ENV_VARS constant ────────────────────────────────

describe('REQUIRED_ENV_VARS', () => {
  it('contains exactly the five critical env vars', () => {
    expect(REQUIRED_ENV_VARS).toEqual([
      'DATABASE_URL',
      'GITHUB_APP_ID',
      'GITHUB_PRIVATE_KEY',
      'GITHUB_WEBHOOK_SECRET',
      'ENCRYPTION_KEY',
    ]);
  });
});

// ─── getMissingEnvVars ─────────────────────────────────────────

describe('getMissingEnvVars', () => {
  it('returns empty array when all required vars are present', () => {
    expect(getMissingEnvVars(fullEnv())).toEqual([]);
  });

  it('detects a single missing variable', () => {
    const env = fullEnv();
    delete (env as Record<string, string | undefined>).DATABASE_URL;

    expect(getMissingEnvVars(env)).toEqual(['DATABASE_URL']);
  });

  it('detects multiple missing variables', () => {
    const env = fullEnv();
    delete (env as Record<string, string | undefined>).GITHUB_APP_ID;
    delete (env as Record<string, string | undefined>).ENCRYPTION_KEY;

    const missing = getMissingEnvVars(env);
    expect(missing).toContain('GITHUB_APP_ID');
    expect(missing).toContain('ENCRYPTION_KEY');
    expect(missing).toHaveLength(2);
  });

  it('treats empty string as missing', () => {
    const env = fullEnv();
    env.GITHUB_WEBHOOK_SECRET = '';

    expect(getMissingEnvVars(env)).toEqual(['GITHUB_WEBHOOK_SECRET']);
  });

  it('treats undefined as missing', () => {
    const env: Record<string, string | undefined> = fullEnv();
    env.GITHUB_PRIVATE_KEY = undefined;

    expect(getMissingEnvVars(env)).toEqual(['GITHUB_PRIVATE_KEY']);
  });

  it('returns all vars when env is completely empty', () => {
    expect(getMissingEnvVars({})).toEqual([...REQUIRED_ENV_VARS]);
  });

  it('ignores extra env vars that are not required', () => {
    const env = {
      ...fullEnv(),
      RENDER_EXTERNAL_URL: 'https://example.com',
      REDIS_URL: 'redis://localhost:6379',
    };
    expect(getMissingEnvVars(env)).toEqual([]);
  });
});

// ─── validateEnvironment ───────────────────────────────────────

describe('validateEnvironment', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
  });

  it('does not exit when all required vars are present', () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    validateEnvironment(fullEnv());

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when a required var is missing', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const env = fullEnv();
    delete (env as Record<string, string | undefined>).DATABASE_URL;

    validateEnvironment(env);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs the missing vars via logger.fatal before exiting', async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { logger } = await import('./logger.js');
    const fatalSpy = logger.fatal as ReturnType<typeof vi.fn>;
    fatalSpy.mockClear();

    const env = fullEnv();
    delete (env as Record<string, string | undefined>).GITHUB_APP_ID;
    delete (env as Record<string, string | undefined>).ENCRYPTION_KEY;

    validateEnvironment(env);

    expect(fatalSpy).toHaveBeenCalledTimes(1);
    const [logObj, message] = fatalSpy.mock.calls[0] as [{ missing: string[] }, string];
    expect(logObj.missing).toContain('GITHUB_APP_ID');
    expect(logObj.missing).toContain('ENCRYPTION_KEY');
    expect(message).toContain('GITHUB_APP_ID');
    expect(message).toContain('ENCRYPTION_KEY');
  });

  it('calls process.exit(1) when all vars are missing', () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    validateEnvironment({});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
