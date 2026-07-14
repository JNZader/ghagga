/**
 * GitHub ForgeAdapter — implemented via the `gh` CLI (child_process),
 * mirroring the GitLab adapter's shape 1:1:
 *   - `gh issue view <iid> -R <repo> --json number,title,body,labels,url,comments`
 *   - `gh issue list -R <repo> --label <l> --limit <n> --json number,title,body,labels,url`
 *   - `gh issue comment <iid> -R <repo> --body <body>`
 */

import { execFileSync } from 'node:child_process';
import type { PostableReply } from '../types/postable.js';
import type { ForgeAdapter, ForgeComment, ForgeIssue, ForgeIssueFilter } from './port.js';

const DEFAULT_LIST_LIMIT = 100;
const MAX_BUFFER = 20 * 1024 * 1024;

const LIST_JSON_FIELDS = 'number,title,body,labels,url';
const VIEW_JSON_FIELDS = 'number,title,body,labels,url,comments';

// ─── gh JSON shapes (loosely typed — gh's schema is not versioned) ───

type GitHubLabel = { name: string };
type GitHubComment = { body?: string; author?: { login?: string }; createdAt?: string };
type GitHubIssueJson = {
  number: number | string;
  title?: string;
  body?: string;
  labels?: GitHubLabel[];
  url?: string;
  comments?: GitHubComment[];
};

function toForgeComment(comment: GitHubComment): ForgeComment {
  return {
    body: comment.body ?? '',
    author: comment.author?.login,
    createdAt: comment.createdAt,
  };
}

function toForgeIssue(raw: GitHubIssueJson): ForgeIssue {
  return {
    iid: String(raw.number),
    title: raw.title ?? '',
    description: raw.body ?? '',
    labels: (raw.labels ?? []).map((l) => l.name),
    url: raw.url ?? '',
    comments: (raw.comments ?? []).map(toForgeComment),
  };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

export interface GitHubAdapterConfig {
  repo: string;
}

export function createGitHubAdapter(config: GitHubAdapterConfig): ForgeAdapter {
  return {
    async listIssues(filter?: ForgeIssueFilter): Promise<ForgeIssue[]> {
      const args = [
        'issue',
        'list',
        '-R',
        config.repo,
        '--limit',
        String(filter?.limit ?? DEFAULT_LIST_LIMIT),
        '--json',
        LIST_JSON_FIELDS,
      ];
      if (filter?.label) {
        args.push('--label', filter.label);
      }
      const raw = gh(args);
      const parsed = JSON.parse(raw) as GitHubIssueJson[];
      return parsed.map(toForgeIssue);
    },

    async getIssue(iid: string): Promise<ForgeIssue> {
      const raw = gh(['issue', 'view', iid, '-R', config.repo, '--json', VIEW_JSON_FIELDS]);
      const parsed = JSON.parse(raw) as GitHubIssueJson;
      return toForgeIssue(parsed);
    },

    async postComment(iid: string, reply: PostableReply): Promise<void> {
      gh(['issue', 'comment', iid, '-R', config.repo, '--body', reply]);
    },
  };
}
