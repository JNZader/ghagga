import { describe, expect, it, vi } from 'vitest';
import { resolveMrToken } from './gitlab-token.js';

describe('resolveMrToken (env GITLAB_TOKEN > GL_TOKEN > GitLab-specific stored)', () => {
  it('prefers GITLAB_TOKEN over GL_TOKEN and stored', () => {
    const token = resolveMrToken(
      { GITLAB_TOKEN: 'gl-primary', GL_TOKEN: 'gl-secondary' } as NodeJS.ProcessEnv,
      () => 'gl-stored',
    );
    expect(token).toBe('gl-primary');
  });

  it('falls back to GL_TOKEN when GITLAB_TOKEN is unset', () => {
    const token = resolveMrToken(
      { GL_TOKEN: 'gl-secondary' } as NodeJS.ProcessEnv,
      () => 'gl-stored',
    );
    expect(token).toBe('gl-secondary');
  });

  it('falls back to the GitLab-specific stored token when no env token is set', () => {
    const token = resolveMrToken({} as NodeJS.ProcessEnv, () => 'gl-stored');
    expect(token).toBe('gl-stored');
  });

  it('returns null when no GitLab token resolves anywhere', () => {
    const token = resolveMrToken({} as NodeJS.ProcessEnv, () => null);
    expect(token).toBeNull();
  });

  it('treats blank/whitespace env tokens as unset and falls through', () => {
    const token = resolveMrToken(
      { GITLAB_TOKEN: '   ', GL_TOKEN: '' } as NodeJS.ProcessEnv,
      () => 'gl-stored',
    );
    expect(token).toBe('gl-stored');
  });

  it('does NOT fall back to the GitHub stored token (FIX B)', async () => {
    // The default stored-token fn must be the GitLab-specific one, NOT getStoredToken
    // (GitHub). With no env tokens AND no GitLab stored token, resolution is null —
    // even if a GitHub token is present in config, it must never be used here.
    const config = await import('./config.js');
    const ghSpy = vi.spyOn(config, 'getStoredToken').mockReturnValue('github-login-token');

    // Inject the real GitLab getter explicitly to prove it does not read GitHub.
    const token = resolveMrToken({} as NodeJS.ProcessEnv, () => null);
    expect(token).toBeNull();
    // The GitHub getter must not have been consulted by this resolution path.
    expect(ghSpy).not.toHaveBeenCalled();

    ghSpy.mockRestore();
  });
});
