import { describe, expect, it } from 'vitest';
import { resolvePrToken } from './pr-token.js';

describe('resolvePrToken (env GITHUB_TOKEN > GH_TOKEN > stored)', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN and stored', () => {
    const token = resolvePrToken(
      { GITHUB_TOKEN: 'gh-primary', GH_TOKEN: 'gh-secondary' } as NodeJS.ProcessEnv,
      () => 'stored',
    );
    expect(token).toBe('gh-primary');
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset', () => {
    const token = resolvePrToken({ GH_TOKEN: 'gh-secondary' } as NodeJS.ProcessEnv, () => 'stored');
    expect(token).toBe('gh-secondary');
  });

  it('falls back to the stored login token when no env token is set', () => {
    const token = resolvePrToken({} as NodeJS.ProcessEnv, () => 'stored');
    expect(token).toBe('stored');
  });

  it('returns null when no token resolves anywhere', () => {
    const token = resolvePrToken({} as NodeJS.ProcessEnv, () => null);
    expect(token).toBeNull();
  });

  it('treats blank/whitespace env tokens as unset and falls through', () => {
    const token = resolvePrToken(
      { GITHUB_TOKEN: '   ', GH_TOKEN: '' } as NodeJS.ProcessEnv,
      () => 'stored',
    );
    expect(token).toBe('stored');
  });
});
