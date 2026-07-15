/**
 * GitHub ForgeAdapter tests. Mocks `node:child_process` — NEVER hits a real
 * `gh` binary or GitHub instance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import type { IssueDraft } from '../types/draft.js';
import { approveDraft } from '../types/postable.js';
import { createGitHubAdapter } from './github.js';

const mockExecFileSync = vi.mocked(execFileSync);

function makeApprovedDraft(clientReply: string): IssueDraft {
  const draft: IssueDraft = {
    id: 'd1',
    issueIid: 7,
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

describe('createGitHubAdapter', () => {
  const adapter = createGitHubAdapter({ repo: 'acme/widgets' });

  describe('getIssue', () => {
    it('calls `gh issue view <iid> -R <repo> --json ...` and parses the result', async () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({
          number: 7,
          title: 'Threshold alert broken',
          body: 'The alert never fires.',
          labels: [{ name: 'bug' }, { name: 'module:alerts' }],
          url: 'https://github.com/acme/widgets/issues/7',
          comments: [{ body: 'confirmed', author: { login: 'jn' }, createdAt: '2026-01-01' }],
        }),
      );

      const issue = await adapter.getIssue('7');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        [
          'issue',
          'view',
          '7',
          '-R',
          'acme/widgets',
          '--json',
          'number,title,body,labels,url,comments',
        ],
        expect.objectContaining({ encoding: 'utf8' }),
      );
      expect(issue).toEqual({
        iid: '7',
        title: 'Threshold alert broken',
        description: 'The alert never fires.',
        labels: ['bug', 'module:alerts'],
        url: 'https://github.com/acme/widgets/issues/7',
        comments: [{ body: 'confirmed', author: 'jn', createdAt: '2026-01-01' }],
      });
    });
  });

  describe('listIssues', () => {
    it('calls `gh issue list -R <repo> --label <l> --json ...` when a label filter is given', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ label: 'bug' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        [
          'issue',
          'list',
          '-R',
          'acme/widgets',
          '--limit',
          '100',
          '--json',
          'number,title,body,labels,url',
          '--label',
          'bug',
        ],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('omits --label when no filter label is given, and respects a custom limit', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ limit: 10 });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        [
          'issue',
          'list',
          '-R',
          'acme/widgets',
          '--limit',
          '10',
          '--json',
          'number,title,body,labels,url',
        ],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('normalizes each listed issue through the same mapping as getIssue', async () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify([{ number: 3, title: 'a', body: 'b', labels: [], url: 'u' }]),
      );

      const issues = await adapter.listIssues();

      expect(issues).toEqual([
        { iid: '3', title: 'a', description: 'b', labels: [], url: 'u', comments: [] },
      ]);
    });
  });

  describe('postComment', () => {
    it('calls `gh issue comment <iid> -R <repo> --body <body>` with the approved PostableReply', async () => {
      const reply = approveDraft(makeApprovedDraft('We are on it.'));

      await adapter.postComment('7', reply);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        ['issue', 'comment', '7', '-R', 'acme/widgets', '--body', 'We are on it.'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });
  });
});
