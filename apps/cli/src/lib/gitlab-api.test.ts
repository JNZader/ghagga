import { describe, expect, it } from 'vitest';
import { GitLabApiError, parseGitLabRemote } from './gitlab-api.js';

describe('parseGitLabRemote (host + projectPath, any GitLab host)', () => {
  it('parses an HTTPS gitlab.com remote', () => {
    expect(parseGitLabRemote('https://gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      projectPath: 'acme/widgets',
    });
  });

  it('parses an HTTPS remote without .git suffix', () => {
    expect(parseGitLabRemote('https://gitlab.com/acme/widgets')).toEqual({
      host: 'gitlab.com',
      projectPath: 'acme/widgets',
    });
  });

  it('parses an SSH (git@) remote', () => {
    expect(parseGitLabRemote('git@gitlab.com:acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      projectPath: 'acme/widgets',
    });
  });

  it('parses an ssh:// protocol remote', () => {
    expect(parseGitLabRemote('ssh://git@gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      projectPath: 'acme/widgets',
    });
  });

  it('supports NESTED groups (group/subgroup/project)', () => {
    expect(parseGitLabRemote('https://gitlab.com/group/subgroup/project.git')).toEqual({
      host: 'gitlab.com',
      projectPath: 'group/subgroup/project',
    });
    expect(parseGitLabRemote('git@gitlab.com:group/subgroup/project.git')).toEqual({
      host: 'gitlab.com',
      projectPath: 'group/subgroup/project',
    });
  });

  // ── Self-hosted GitLab (FIX A) ──────────────────────────────────

  it('parses a self-hosted HTTPS remote and returns its host', () => {
    expect(parseGitLabRemote('https://gitlab.example.com/team/repo.git')).toEqual({
      host: 'gitlab.example.com',
      projectPath: 'team/repo',
    });
  });

  it('parses a self-hosted SSH (git@) remote', () => {
    expect(parseGitLabRemote('git@gitlab.example.com:team/repo.git')).toEqual({
      host: 'gitlab.example.com',
      projectPath: 'team/repo',
    });
  });

  it('strips a port from an ssh:// self-hosted remote (API rides HTTPS)', () => {
    expect(parseGitLabRemote('ssh://git@gitlab.example.com:2222/team/repo.git')).toEqual({
      host: 'gitlab.example.com',
      projectPath: 'team/repo',
    });
  });

  it('strips userinfo from an HTTPS remote', () => {
    expect(parseGitLabRemote('https://user:tok@gitlab.example.com/team/repo.git')).toEqual({
      host: 'gitlab.example.com',
      projectPath: 'team/repo',
    });
  });

  it('throws on a github.com remote (obvious --mr misuse)', () => {
    expect(() => parseGitLabRemote('https://github.com/acme/widgets.git')).toThrow(
      /Not a GitLab remote URL/,
    );
    expect(() => parseGitLabRemote('git@github.com:acme/widgets.git')).toThrow(
      /Not a GitLab remote URL/,
    );
  });

  it('throws on an unrecognizable remote', () => {
    expect(() => parseGitLabRemote('not-a-url')).toThrow(/Not a GitLab remote URL/);
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
