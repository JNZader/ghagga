/**
 * GitLab ForgeAdapter — implemented via the `glab` CLI (child_process),
 * mirroring the exact commands proven by the biogas-triage PoC:
 *   - `glab issue view <iid> -R <repo> -F json`
 *   - `glab issue list -R <repo> --label <l> -F json`
 *   - `glab issue note <iid> -R <repo> -m <body>`
 *
 * Descriptions are stripped of the feedback-widget metadata block (the
 * `---`-delimited trailer some client widgets append) and HTML comments,
 * matching the PoC's `.split(/\n-{3,}\s*\n/)[0]` + `<!-- -->` strip.
 */

import { execFileSync } from 'node:child_process';
import type { PostableReply } from '../types/postable.js';
import type { ForgeAdapter, ForgeComment, ForgeIssue, ForgeIssueFilter } from './port.js';

const DEFAULT_LIST_LIMIT = 100;
const MAX_BUFFER = 20 * 1024 * 1024;

// ─── glab JSON shapes (loosely typed — glab's schema is not versioned) ───

type GitLabLabel = string | { name: string };
type GitLabNote = { body?: string; author?: { username?: string }; created_at?: string };
type GitLabIssueJson = {
  iid: number | string;
  title?: string;
  description?: string;
  labels?: GitLabLabel[];
  web_url?: string;
  notes?: GitLabNote[];
};

function labelName(label: GitLabLabel): string {
  return typeof label === 'string' ? label : label.name;
}

/** Strips the feedback-widget metadata trailer and HTML comments from a GitLab issue description. */
export function stripGitLabWidgetMetadata(description: string): string {
  return description
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n-{3,}\s*\n/)[0]
    .trim();
}

function toForgeComment(note: GitLabNote): ForgeComment {
  return {
    body: note.body ?? '',
    author: note.author?.username,
    createdAt: note.created_at,
  };
}

function toForgeIssue(raw: GitLabIssueJson): ForgeIssue {
  return {
    iid: String(raw.iid),
    title: raw.title ?? '',
    description: stripGitLabWidgetMetadata(raw.description ?? ''),
    labels: (raw.labels ?? []).map(labelName),
    url: raw.web_url ?? '',
    comments: (raw.notes ?? []).map(toForgeComment),
  };
}

function glab(args: string[]): string {
  return execFileSync('glab', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

export interface GitLabAdapterConfig {
  repo: string;
}

export function createGitLabAdapter(config: GitLabAdapterConfig): ForgeAdapter {
  return {
    async listIssues(filter?: ForgeIssueFilter): Promise<ForgeIssue[]> {
      // `glab issue list` uses `-O/--output json` for JSON; `-F/--output-format`
      // is a DIFFERENT flag (details/ids/urls) and silently falls back to the
      // human text table, breaking JSON.parse. (`issue view` does use `-F json`.)
      const args = [
        'issue',
        'list',
        '-R',
        config.repo,
        '-O',
        'json',
        '-P',
        String(filter?.limit ?? DEFAULT_LIST_LIMIT),
      ];
      if (filter?.label) {
        args.push('--label', filter.label);
      }
      const raw = glab(args);
      const parsed = JSON.parse(raw) as GitLabIssueJson[];
      return parsed.map(toForgeIssue);
    },

    async getIssue(iid: string): Promise<ForgeIssue> {
      const raw = glab(['issue', 'view', iid, '-R', config.repo, '-F', 'json']);
      const parsed = JSON.parse(raw) as GitLabIssueJson;
      return toForgeIssue(parsed);
    },

    async postComment(iid: string, reply: PostableReply): Promise<void> {
      glab(['issue', 'note', iid, '-R', config.repo, '-m', reply]);
    },
  };
}
