import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

// ─── Installations ──────────────────────────────────────────────

export const installations = pgTable('installations', {
  id: serial('id').primaryKey(),
  githubInstallationId: integer('github_installation_id').unique().notNull(),
  accountLogin: varchar('account_login', { length: 255 }).notNull(),
  accountType: varchar('account_type', { length: 20 }).notNull(), // 'User' | 'Organization'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Shared Types ───────────────────────────────────────────────

export interface RepoSettings {
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enableMemory: boolean;
  customRules: string[];
  ignorePatterns: string[];
  reviewLevel: 'soft' | 'normal' | 'strict';

  // ── Extensible tool configuration (Phase 6) ──
  /** Force-enable specific tools (overrides auto-detect). undefined = use tier defaults. */
  enabledTools?: string[];
  /** Force-disable specific tools (overrides always-on and auto-detect). */
  disabledTools?: string[];

  // ── Blast-radius analysis ──
  /** Enable blast-radius analysis using dependency graph. Default: false. */
  enableBlastRadius?: boolean;
}

export const DEFAULT_REPO_SETTINGS: RepoSettings = {
  enableSemgrep: true,
  enableTrivy: true,
  enableCpd: true,
  enableMemory: true,
  customRules: [],
  ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
  reviewLevel: 'normal',
  enabledTools: undefined,
  disabledTools: [],
};

// ─── Delegated CI (DB-specific types) ───────────────────────────

/** Classification of a job for delegation eligibility */
export type DbDelegatedCiClassification = 'safe/delegable' | 'sensitive/no-delegable';

/** Supported curated execution profiles for MVP */
export type DbDelegatedCiProfile =
  | 'node-lint'
  | 'node-unit'
  | 'python-lint'
  | 'python-pytest'
  | 'go-test';

/** Per-job policy within a repository's delegated CI configuration */
export interface DbDelegatedCiJobPolicy {
  jobKey: string;
  displayName: string;
  classification: DbDelegatedCiClassification;
  profile: DbDelegatedCiProfile;
  enabled: boolean;
  allowArtifacts: false | string[];
  allowCache: boolean;
  maxDurationMinutes?: number;
  rationale?: string;
}

/** Repository-scoped delegated CI policy (stored as JSONB) */
export interface DbDelegatedCiPolicy {
  enabled: boolean;
  allowManualTrigger?: boolean;
  allowPullRequestTrigger?: boolean;
  jobs: DbDelegatedCiJobPolicy[];
}

/**
 * Shape of each entry stored in the provider_chain JSONB column.
 * Encrypted API keys are stored here (one per provider entry).
 */
export interface DbProviderChainEntry {
  provider:
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'github'
    | 'qwen'
    | 'groq'
    | 'cerebras'
    | 'deepseek'
    | 'openrouter';
  model: string;
  encryptedApiKey: string | null; // null for GitHub Models (uses session token)
}

// ─── Installation Settings ──────────────────────────────────────

export const installationSettings = pgTable('installation_settings', {
  id: serial('id').primaryKey(),
  installationId: integer('installation_id')
    .references(() => installations.id)
    .unique()
    .notNull(),
  providerChain: jsonb('provider_chain').$type<DbProviderChainEntry[]>().default([]).notNull(),
  aiReviewEnabled: boolean('ai_review_enabled').default(true).notNull(),
  reviewMode: varchar('review_mode', { length: 20 }).default('simple').notNull(),
  settings: jsonb('settings').$type<RepoSettings>().default(DEFAULT_REPO_SETTINGS).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Repositories ───────────────────────────────────────────────

export const repositories = pgTable(
  'repositories',
  {
    id: serial('id').primaryKey(),
    githubRepoId: integer('github_repo_id').unique().notNull(),
    installationId: integer('installation_id')
      .references(() => installations.id, { onDelete: 'cascade' })
      .notNull(),
    fullName: varchar('full_name', { length: 255 }).notNull(), // "owner/repo"
    isActive: boolean('is_active').default(true).notNull(),
    settings: jsonb('settings').$type<RepoSettings>().default(DEFAULT_REPO_SETTINGS).notNull(),
    reviewMode: varchar('review_mode', { length: 20 }).default('simple').notNull(),

    // ── Global settings inheritance ──
    useGlobalSettings: boolean('use_global_settings').default(true).notNull(),

    // ── Provider chain (replaces flat llm_provider/llm_model/encrypted_api_key) ──
    providerChain: jsonb('provider_chain').$type<DbProviderChainEntry[]>().default([]).notNull(),
    aiReviewEnabled: boolean('ai_review_enabled').default(true).notNull(),

    // ── Delegated CI (repo-only, not inherited) ──
    delegatedCiPolicy: jsonb('delegated_ci_policy').$type<DbDelegatedCiPolicy>(),

    // ── Old columns (kept for rollback safety, will be dropped in a future migration) ──
    encryptedApiKey: text('encrypted_api_key'),
    llmProvider: varchar('llm_provider', { length: 50 }).default('github').notNull(),
    llmModel: varchar('llm_model', { length: 100 }),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_repositories_installation').on(t.installationId),
    index('idx_repositories_full_name').on(t.fullName),
  ],
);

// ─── Reviews ────────────────────────────────────────────────────

export const reviews = pgTable(
  'reviews',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    prNumber: integer('pr_number').notNull(),
    status: varchar('status', { length: 30 }).notNull(), // PASSED | FAILED | NEEDS_HUMAN_REVIEW | SKIPPED
    mode: varchar('mode', { length: 20 }).notNull(),
    summary: text('summary'),
    findings: jsonb('findings').$type<unknown[]>(),
    tokensUsed: integer('tokens_used').default(0),
    executionTimeMs: integer('execution_time_ms'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_reviews_repository').on(t.repositoryId),
    index('idx_reviews_created_at').on(t.createdAt),
  ],
);

// ─── Memory: Sessions ───────────────────────────────────────────

export const memorySessions = pgTable(
  'memory_sessions',
  {
    id: serial('id').primaryKey(),
    project: varchar('project', { length: 255 }).notNull(), // "owner/repo"
    prNumber: integer('pr_number'),
    summary: text('summary'),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    endedAt: timestamp('ended_at'),
  },
  (t) => [index('idx_memory_sessions_project').on(t.project)],
);

// ─── Memory: Observations ───────────────────────────────────────
// Note: tsvector column + GIN index + update trigger are created
// via a raw SQL migration (see migrations/0001_add_tsvector.sql)

export const memoryObservations = pgTable(
  'memory_observations',
  {
    id: serial('id').primaryKey(),
    sessionId: integer('session_id').references(() => memorySessions.id, { onDelete: 'cascade' }),
    project: varchar('project', { length: 255 }).notNull(),
    type: varchar('type', { length: 30 }).notNull(), // decision | pattern | bugfix | learning | architecture | config | discovery
    title: varchar('title', { length: 500 }).notNull(),
    content: text('content').notNull(),
    severity: varchar('severity', { length: 10 }),
    topicKey: varchar('topic_key', { length: 255 }),
    filePaths: jsonb('file_paths').$type<string[]>().default([]),
    contentHash: varchar('content_hash', { length: 64 }),
    revisionCount: integer('revision_count').default(1).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_observations_project').on(t.project),
    index('idx_observations_topic_key').on(t.topicKey),
    index('idx_observations_type').on(t.type),
    index('idx_observations_content_hash').on(t.contentHash),
    index('idx_observations_created_at').on(t.createdAt),
  ],
);

// ─── GitHub User Mappings ───────────────────────────────────────

export const githubUserMappings = pgTable(
  'github_user_mappings',
  {
    id: serial('id').primaryKey(),
    githubUserId: integer('github_user_id').notNull(),
    githubLogin: varchar('github_login', { length: 255 }).notNull(),
    installationId: integer('installation_id')
      .references(() => installations.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_user_mappings_github_user').on(t.githubUserId),
    unique('uq_user_installation').on(t.githubUserId, t.installationId),
  ],
);

// ─── Delegated CI Runs ──────────────────────────────────────────

export const delegatedCiRuns = pgTable(
  'delegated_ci_runs',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    prNumber: integer('pr_number'),
    jobKey: varchar('job_key', { length: 100 }).notNull(),
    classification: varchar('classification', { length: 30 }).notNull(), // 'safe/delegable' | 'sensitive/no-delegable'
    state: varchar('state', { length: 20 }).notNull(), // DelegatedCiRunState
    reasonCode: varchar('reason_code', { length: 50 }),
    reasonDetail: text('reason_detail'),
    callbackId: varchar('callback_id', { length: 100 }),
    workflowRunId: varchar('workflow_run_id', { length: 50 }),
    profile: varchar('profile', { length: 50 }).notNull(),
    summary: text('summary'),
    resultSummary: jsonb('result_summary'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_delegated_ci_runs_repository').on(t.repositoryId),
    index('idx_delegated_ci_runs_state').on(t.state),
    index('idx_delegated_ci_runs_created_at').on(t.createdAt),
    index('idx_delegated_ci_runs_callback_id').on(t.callbackId),
  ],
);
