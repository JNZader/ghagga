/**
 * GitHub webhook and event types
 */

// GitHub webhook event names
export type GitHubEventName =
  | 'installation'
  | 'installation_repositories'
  | 'pull_request'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'issue_comment'
  | 'push'
  | 'check_run'
  | 'check_suite';

// Base webhook payload
export interface GitHubWebhookPayload {
  action: string;
  sender: GitHubUser;
  repository?: GitHubRepository;
  organization?: GitHubOrganization;
  installation?: GitHubInstallationShort;
}

// GitHub User
export interface GitHubUser {
  id: number;
  login: string;
  node_id: string;
  avatar_url: string;
  type: 'User' | 'Bot' | 'Organization';
  site_admin?: boolean;
}

// GitHub Organization
export interface GitHubOrganization {
  id: number;
  login: string;
  node_id: string;
  avatar_url: string;
  description?: string;
}

// GitHub Repository
export interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: GitHubUser;
  html_url: string;
  description?: string;
  fork: boolean;
  default_branch: string;
  language?: string;
  visibility: 'public' | 'private' | 'internal';
}

// Short installation reference in webhook payloads
export interface GitHubInstallationShort {
  id: number;
  node_id: string;
}

// Installation event payloads
export interface InstallationEventPayload extends GitHubWebhookPayload {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installation: GitHubInstallation;
  repositories?: GitHubRepositoryShort[];
}

export interface InstallationRepositoriesEventPayload extends GitHubWebhookPayload {
  action: 'added' | 'removed';
  installation: GitHubInstallation;
  repositories_added: GitHubRepositoryShort[];
  repositories_removed: GitHubRepositoryShort[];
  repository_selection: 'all' | 'selected';
}

// Full installation object
export interface GitHubInstallation {
  id: number;
  account: GitHubUser | GitHubOrganization;
  repository_selection: 'all' | 'selected';
  access_tokens_url: string;
  repositories_url: string;
  html_url: string;
  app_id: number;
  app_slug: string;
  target_id: number;
  target_type: 'User' | 'Organization';
  permissions: GitHubPermissions;
  events: string[];
  created_at: string;
  updated_at: string;
  suspended_at?: string;
  suspended_by?: GitHubUser;
}

// Short repository reference
export interface GitHubRepositoryShort {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
}

// GitHub App permissions
export interface GitHubPermissions {
  contents?: 'read' | 'write';
  issues?: 'read' | 'write';
  metadata?: 'read' | 'write';
  pull_requests?: 'read' | 'write';
  checks?: 'read' | 'write';
  statuses?: 'read' | 'write';
  [key: string]: 'read' | 'write' | undefined;
}

// Pull Request event payloads
export interface PullRequestEventPayload extends GitHubWebhookPayload {
  action:
    | 'opened'
    | 'edited'
    | 'closed'
    | 'reopened'
    | 'synchronize'
    | 'ready_for_review'
    | 'converted_to_draft'
    | 'labeled'
    | 'unlabeled';
  number: number;
  pull_request: GitHubPullRequest;
  changes?: PullRequestChanges;
}

// Pull Request changes for edit events
export interface PullRequestChanges {
  title?: { from: string };
  body?: { from: string };
  base?: { ref: { from: string }; sha: { from: string } };
}

// GitHub Pull Request
export interface GitHubPullRequest {
  id: number;
  node_id: string;
  number: number;
  state: 'open' | 'closed';
  locked: boolean;
  title: string;
  body?: string;
  user: GitHubUser;
  html_url: string;
  diff_url: string;
  patch_url: string;
  head: GitHubPullRequestRef;
  base: GitHubPullRequestRef;
  draft: boolean;
  merged: boolean;
  mergeable?: boolean;
  mergeable_state?: string;
  merged_by?: GitHubUser;
  merge_commit_sha?: string;
  assignees: GitHubUser[];
  requested_reviewers: GitHubUser[];
  labels: GitHubLabel[];
  milestone?: GitHubMilestone;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  merged_at?: string;
}

// Pull Request reference (head/base)
export interface GitHubPullRequestRef {
  label: string;
  ref: string;
  sha: string;
  user: GitHubUser;
  repo: GitHubRepository;
}

// GitHub Label
export interface GitHubLabel {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description?: string;
}

// GitHub Milestone
export interface GitHubMilestone {
  id: number;
  node_id: string;
  number: number;
  title: string;
  description?: string;
  state: 'open' | 'closed';
  due_on?: string;
}

// Pull Request Review event
export interface PullRequestReviewEventPayload extends GitHubWebhookPayload {
  action: 'submitted' | 'edited' | 'dismissed';
  pull_request: GitHubPullRequest;
  review: GitHubReview;
}

// GitHub Review
export interface GitHubReview {
  id: number;
  node_id: string;
  user: GitHubUser;
  body?: string;
  commit_id: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  html_url: string;
  submitted_at: string;
}

// Pull Request Review Comment event
export interface PullRequestReviewCommentEventPayload extends GitHubWebhookPayload {
  action: 'created' | 'edited' | 'deleted';
  pull_request: GitHubPullRequest;
  comment: GitHubReviewComment;
}

// GitHub Review Comment
export interface GitHubReviewComment {
  id: number;
  node_id: string;
  pull_request_review_id: number;
  diff_hunk: string;
  path: string;
  position?: number;
  original_position?: number;
  commit_id: string;
  original_commit_id: string;
  user: GitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  in_reply_to_id?: number;
  line?: number;
  original_line?: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  original_start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

// Issue Comment event
export interface IssueCommentEventPayload extends GitHubWebhookPayload {
  action: 'created' | 'edited' | 'deleted';
  issue: GitHubIssue;
  comment: GitHubComment;
}

// GitHub Issue (also used for PR comments)
export interface GitHubIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body?: string;
  user: GitHubUser;
  labels: GitHubLabel[];
  state: 'open' | 'closed';
  locked: boolean;
  assignees: GitHubUser[];
  milestone?: GitHubMilestone;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  pull_request?: { url: string };
}

// GitHub Comment
export interface GitHubComment {
  id: number;
  node_id: string;
  user: GitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

// Push event
export interface PushEventPayload extends GitHubWebhookPayload {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  base_ref?: string;
  compare: string;
  commits: GitHubCommit[];
  head_commit?: GitHubCommit;
  pusher: GitHubPusher;
}

// GitHub Commit
export interface GitHubCommit {
  id: string;
  tree_id: string;
  distinct: boolean;
  message: string;
  timestamp: string;
  url: string;
  author: GitHubCommitAuthor;
  committer: GitHubCommitAuthor;
  added: string[];
  removed: string[];
  modified: string[];
}

// Commit author info
export interface GitHubCommitAuthor {
  name: string;
  email: string;
  username?: string;
}

// Pusher info
export interface GitHubPusher {
  name: string;
  email: string;
}

// Check Run event
export interface CheckRunEventPayload extends GitHubWebhookPayload {
  action: 'created' | 'completed' | 'rerequested' | 'requested_action';
  check_run: GitHubCheckRun;
}

// GitHub Check Run
export interface GitHubCheckRun {
  id: number;
  node_id: string;
  head_sha: string;
  external_id?: string;
  url: string;
  html_url: string;
  details_url?: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required';
  started_at: string;
  completed_at?: string;
  output: GitHubCheckRunOutput;
  name: string;
  check_suite: { id: number };
  app: GitHubApp;
  pull_requests: GitHubPullRequestShort[];
}

// Check Run output
export interface GitHubCheckRunOutput {
  title?: string;
  summary?: string;
  text?: string;
  annotations_count: number;
  annotations_url: string;
}

// Short PR reference in check runs
export interface GitHubPullRequestShort {
  id: number;
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

// GitHub App reference
export interface GitHubApp {
  id: number;
  slug: string;
  node_id: string;
  owner: GitHubUser;
  name: string;
}

// Check Suite event
export interface CheckSuiteEventPayload extends GitHubWebhookPayload {
  action: 'completed' | 'requested' | 'rerequested';
  check_suite: GitHubCheckSuite;
}

// GitHub Check Suite
export interface GitHubCheckSuite {
  id: number;
  node_id: string;
  head_branch?: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale';
  url: string;
  before?: string;
  after?: string;
  pull_requests: GitHubPullRequestShort[];
  app: GitHubApp;
  created_at: string;
  updated_at: string;
}

// Webhook verification
export interface WebhookVerification {
  valid: boolean;
  event: GitHubEventName;
  delivery_id: string;
  signature?: string;
}

// API response types
export interface GitHubApiError {
  message: string;
  documentation_url?: string;
  errors?: Array<{
    resource: string;
    field: string;
    code: string;
    message?: string;
  }>;
}

// File content from API
export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url?: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  content?: string;
  encoding?: 'base64';
}

// Diff file from API
export interface GitHubDiffFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch?: string;
  previous_filename?: string;
}
