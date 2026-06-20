import { describe, expect, it } from 'vitest';
import { resolveMrToken } from './gitlab-token.js';

describe('resolveMrToken (env GITLAB_TOKEN > GL_TOKEN > stored)', () => {
  it('prefers GITLAB_TOKEN over GL_TOKEN and stored', () => {
    const token = resolveMrToken(
      { GITLAB_TOKEN: 'gl-primary', GL_TOKEN: 'gl-secondary' } as NodeJS.ProcessEnv,
      () => 'stored',
    );
    expect(token).toBe('gl-primary');
  });

  it('falls back to GL_TOKEN when GITLAB_TOKEN is unset', () => {
    const token = resolveMrToken({ GL_TOKEN: 'gl-secondary' } as NodeJS.ProcessEnv, () => 'stored');
    expect(token).toBe('gl-secondary');
  });

  it('falls back to the stored login token when no env token is set', () => {
    const token = resolveMrToken({} as NodeJS.ProcessEnv, () => 'stored');
    expect(token).toBe('stored');
  });

  it('returns null when no token resolves anywhere', () => {
    const token = resolveMrToken({} as NodeJS.ProcessEnv, () => null);
    expect(token).toBeNull();
  });

  it('treats blank/whitespace env tokens as unset and falls through', () => {
    const token = resolveMrToken(
      { GITLAB_TOKEN: '   ', GL_TOKEN: '' } as NodeJS.ProcessEnv,
      () => 'stored',
    );
    expect(token).toBe('stored');
  });
});
