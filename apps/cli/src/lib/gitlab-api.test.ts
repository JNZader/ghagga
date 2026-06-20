import { describe, expect, it } from 'vitest';
import { GitLabApiError, parseGitLabRemote } from './gitlab-api.js';

describe('parseGitLabRemote', () => {
  it('parses an HTTPS remote', () => {
    expect(parseGitLabRemote('https://gitlab.com/acme/widgets.git')).toEqual({
      path: 'acme/widgets',
    });
  });

  it('parses an HTTPS remote without .git suffix', () => {
    expect(parseGitLabRemote('https://gitlab.com/acme/widgets')).toEqual({ path: 'acme/widgets' });
  });

  it('parses an SSH (git@) remote', () => {
    expect(parseGitLabRemote('git@gitlab.com:acme/widgets.git')).toEqual({ path: 'acme/widgets' });
  });

  it('parses an ssh:// protocol remote', () => {
    expect(parseGitLabRemote('ssh://git@gitlab.com/acme/widgets.git')).toEqual({
      path: 'acme/widgets',
    });
  });

  it('supports NESTED groups (group/subgroup/project)', () => {
    expect(parseGitLabRemote('https://gitlab.com/group/subgroup/project.git')).toEqual({
      path: 'group/subgroup/project',
    });
    expect(parseGitLabRemote('git@gitlab.com:group/subgroup/project.git')).toEqual({
      path: 'group/subgroup/project',
    });
  });

  it('throws on a non-GitLab remote', () => {
    expect(() => parseGitLabRemote('https://github.com/acme/widgets.git')).toThrow(
      /Not a GitLab remote URL/,
    );
  });
});

describe('GitLabApiError', () => {
  it('carries status + body', () => {
    const err = new GitLabApiError('boom', 404, 'not found');
    expect(err.status).toBe(404);
    expect(err.body).toBe('not found');
    expect(err.name).toBe('GitLabApiError');
  });
});
