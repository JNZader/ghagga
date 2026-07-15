/**
 * GitLab ForgeAdapter tests. Mocks `node:child_process` — NEVER hits a real
 * `glab` binary or GitLab instance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import type { IssueDraft } from '../types/draft.js';
import { approveDraft } from '../types/postable.js';
import { createGitLabAdapter, stripGitLabWidgetMetadata } from './gitlab.js';

const mockExecFileSync = vi.mocked(execFileSync);

function makeApprovedDraft(clientReply: string): IssueDraft {
  const draft: IssueDraft = {
    id: 'd1',
    issueIid: 42,
    repo: 'acme/widgets',
    status: 'PENDING_APPROVAL',
    report: 'internal analysis',
    clientReply,
    reproductionEvidence: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
  return draft;
}

beforeEach(() => {
  mockExecFileSync.mockReset();
});

describe('createGitLabAdapter', () => {
  const adapter = createGitLabAdapter({ repo: 'acme/widgets' });

  describe('getIssue', () => {
    it('calls `glab issue view <iid> -R <repo> -F json` and parses the result', async () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({
          iid: 42,
          title: 'Threshold alert broken',
          description: 'The alert never fires.',
          labels: ['módulo::alertas', { name: 'estado::nuevo' }],
          web_url: 'https://gitlab.com/acme/widgets/-/issues/42',
          notes: [{ body: 'confirmed', author: { username: 'jn' }, created_at: '2026-01-01' }],
        }),
      );

      const issue = await adapter.getIssue('42');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'view', '42', '-R', 'acme/widgets', '-F', 'json'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
      expect(issue).toEqual({
        iid: '42',
        title: 'Threshold alert broken',
        description: 'The alert never fires.',
        labels: ['módulo::alertas', 'estado::nuevo'],
        url: 'https://gitlab.com/acme/widgets/-/issues/42',
        comments: [{ body: 'confirmed', author: 'jn', createdAt: '2026-01-01' }],
      });
    });

    it('strips the feedback-widget metadata trailer and HTML comments from the description', () => {
      const raw =
        'Real user text.\n---\nWidget metadata trailer that should be dropped.\n<!-- hidden marker -->';

      expect(stripGitLabWidgetMetadata(raw)).toBe('Real user text.');
    });
  });

  describe('listIssues', () => {
    it('calls `glab issue list -R <repo> --label <l> -F json` when a label filter is given', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ label: 'estado::nuevo' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        [
          'issue',
          'list',
          '-R',
          'acme/widgets',
          '-F',
          'json',
          '-P',
          '100',
          '--label',
          'estado::nuevo',
        ],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('omits --label when no filter label is given, and respects a custom limit', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ limit: 25 });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'list', '-R', 'acme/widgets', '-F', 'json', '-P', '25'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('normalizes each listed issue through the same mapping as getIssue', async () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify([{ iid: 1, title: 'a', description: 'b', labels: [], web_url: 'u' }]),
      );

      const issues = await adapter.listIssues();

      expect(issues).toEqual([
        { iid: '1', title: 'a', description: 'b', labels: [], url: 'u', comments: [] },
      ]);
    });
  });

  describe('postComment', () => {
    it('calls `glab issue note <iid> -R <repo> -m <body>` with the approved PostableReply', async () => {
      const reply = approveDraft(makeApprovedDraft('We are on it.'));

      await adapter.postComment('42', reply);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'note', '42', '-R', 'acme/widgets', '-m', 'We are on it.'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });
  });
});
