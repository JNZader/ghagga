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
        rawDescription: 'The alert never fires.',
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

    it('keeps the raw widget trailer (with the `Ruta:` line) in rawDescription while description is stripped', async () => {
      const body =
        'El gráfico no carga.\n\n---\n- Módulo: `Energía`\n- Ruta: `/app/energia`\n<!-- widget-id: abc -->';
      mockExecFileSync.mockReturnValue(
        JSON.stringify({
          iid: 99,
          title: 'Gráfico roto',
          description: body,
          labels: [],
          web_url: 'https://gitlab.com/acme/widgets/-/issues/99',
          notes: [],
        }),
      );

      const issue = await adapter.getIssue('99');

      // description: LLM-facing, widget trailer stripped → no `Ruta:` line.
      expect(issue.description).toBe('El gráfico no carga.');
      expect(issue.description).not.toContain('Ruta:');
      // rawDescription: route-extraction-facing, retains the FULL body incl. trailer.
      expect(issue.rawDescription).toBe(body);
      expect(issue.rawDescription).toContain('Ruta: `/app/energia`');
    });
  });

  describe('listIssues', () => {
    it('calls `glab issue list -R <repo> -O json --label <l>` when a label filter is given', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ label: 'estado::nuevo' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        [
          'issue',
          'list',
          '-R',
          'acme/widgets',
          '-O',
          'json',
          '-P',
          '100',
          '--label',
          'estado::nuevo',
        ],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('uses `-O json` (NOT `-F json`) so glab emits JSON, not the text table', async () => {
      // Regression: `-F/--output-format` (details/ids/urls) silently falls back
      // to glab's human table, breaking JSON.parse. List JSON needs `-O/--output`.
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues();

      const call = mockExecFileSync.mock.calls[0];
      expect(call?.[1]).toContain('-O');
      expect(call?.[1]).not.toContain('-F');
    });

    it('omits --label when no filter label is given, and respects a custom limit', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([]));

      await adapter.listIssues({ limit: 25 });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'glab',
        ['issue', 'list', '-R', 'acme/widgets', '-O', 'json', '-P', '25'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('normalizes each listed issue through the same mapping as getIssue', async () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify([{ iid: 1, title: 'a', description: 'b', labels: [], web_url: 'u' }]),
      );

      const issues = await adapter.listIssues();

      expect(issues).toEqual([
        {
          iid: '1',
          title: 'a',
          description: 'b',
          rawDescription: 'b',
          labels: [],
          url: 'u',
          comments: [],
        },
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
