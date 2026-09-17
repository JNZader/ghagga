import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
  /** Enables the isolated PR explanation route. Omitted settings resolve to false. */
  explanationsEnabled?: boolean;
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

/**
 * Shape of each entry stored in the provider_chain JSONB column.
 * Encrypted API keys are stored here (one per provider entry).
 *
 * Provider union mirrors `SaaSProvider` from `@ghagga/types`: only the v3
 * runtime targets (gateway / cli-bridge / ollama) are valid. Legacy entries
 * (anthropic/openai/google/etc.) are remapped at the runtime boundary by
 * `normalizeLegacyProvider` in `apps/server/src/queues/review.ts`.
 */
export interface DbProviderChainEntry {
  provider: 'gateway' | 'cli-bridge' | 'ollama';
  model: string;
  encryptedApiKey: string | null;
  /** OpenCode model in `provider/model` format. Only meaningful when provider === 'cli-bridge'. */
  cliModel?: string;

  /** Gateway base URL. Only meaningful when provider === 'gateway'. */
  gatewayUrl?: string;

  /**
   * Bridge-side provider id to route to (e.g. 'codex-cli'). Forwarded to the
   * gateway so the bridge selects this provider directly, skipping model-based
   * routing. Only meaningful when provider === 'gateway'.
   * Stored in the schemaless `provider_chain` jsonb column — no migration.
   */
  targetProvider?: string;
}

// ─── Installation Settings ──────────────────────────────────────

export const installationSettings = pgTable('installation_settings', {
  id: serial('id').primaryKey(),
  installationId: integer('installation_id')
    .references(() => installations.id, { onDelete: 'cascade' })
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

    // ── Old columns (kept for rollback safety, will be dropped in a future migration) ──
    encryptedApiKey: text('encrypted_api_key'),
    llmProvider: varchar('llm_provider', { length: 50 }).default('gateway').notNull(),
    llmModel: varchar('llm_model', { length: 100 }),

    // ── Inline workflow (Phase: inline-workflow-migration) ──
    /** ISO timestamp of when ghagga.yml was last pushed to .github/workflows/ in this repo */
    workflowInstalledAt: timestamp('workflow_installed_at'),
    /** SHA of the file object returned by Contents API — used for idempotent updates */
    workflowSha: text('workflow_sha'),

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
    status: varchar('status', { length: 30 }).notNull(), // PASSED | FAILED | NEEDS_HUMAN_REVIEW | SKIPPED | PARTIAL | INCONCLUSIVE
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

// ─── Issue Drafts (Issue-Triage Agent) ──────────────────────────
// Net-new, additive table. Unlike `reviews` (PR-centric, posts immediately),
// the triage worker persists a DRAFT and NEVER auto-posts — a human approves
// it in the dashboard, which then posts the comment via the issues API.

/** Draft lifecycle: worker inserts DRAFT → human edits → APPROVED → POSTED, or → REJECTED. */
export const ISSUE_DRAFT_STATUSES = ['DRAFT', 'APPROVED', 'REJECTED', 'POSTED'] as const;
export type IssueDraftStatus = (typeof ISSUE_DRAFT_STATUSES)[number];

/** What the worker produced: a full analysis, a duplicate match, or a missing-info request. */
export const ISSUE_DRAFT_KINDS = ['ANALYSIS', 'DUPLICATE', 'NEEDS_INFO'] as const;
export type IssueDraftKind = (typeof ISSUE_DRAFT_KINDS)[number];

/** Cited source backing a draft claim (memory observation or issue excerpt). */
export interface IssueDraftSource {
  title: string;
  type: string;
  ref: string;
}

/** A prior observation surfaced by the dedup stage. */
export interface IssueDedupMatch {
  observationId: number;
  title: string;
  score: number;
}

export const issueDrafts = pgTable(
  'issue_drafts',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    issueNumber: integer('issue_number').notNull(),
    issueTitle: varchar('issue_title', { length: 500 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(), // DRAFT | APPROVED | REJECTED | POSTED
    draftKind: varchar('draft_kind', { length: 20 }).notNull(), // ANALYSIS | DUPLICATE | NEEDS_INFO
    body: text('body').notNull(), // editable cited markdown report
    sources: jsonb('sources').$type<IssueDraftSource[]>(),
    dedupMatches: jsonb('dedup_matches').$type<IssueDedupMatch[]>(),
    tokensUsed: integer('tokens_used').default(0).notNull(),
    // GitHub comment IDs are 64-bit and already exceed int4's max, so this
    // must be bigint to avoid out-of-range at insert time. Nullable: set on POSTED.
    postedCommentId: bigint('posted_comment_id', { mode: 'number' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    // Lease timestamp: set when a draft is claimed for posting (DRAFT → APPROVED),
    // used to detect orphaned/stuck APPROVED drafts whose poster process crashed
    // before posting the comment. NULL when not currently claimed (DRAFT/REJECTED,
    // or cleared on release back to DRAFT).
    claimedAt: timestamp('claimed_at'),
  },
  (t) => [
    index('idx_issue_drafts_repository').on(t.repositoryId),
    index('idx_issue_drafts_status').on(t.status),
    // At most ONE open DRAFT per (repository, issue). Approved/rejected/posted
    // rows are excluded by the partial predicate, so re-triaging after a
    // decision is allowed.
    uniqueIndex('uq_issue_drafts_open_draft')
      .on(t.repositoryId, t.issueNumber)
      .where(sql`${t.status} = 'DRAFT'`),
    // DB-level CHECK mirroring the exported const unions. The partial-unique
    // "one open DRAFT" index is only as strong as the validity of `status`,
    // so this hardens that invariant at the database boundary.
    check(
      'chk_issue_drafts_status',
      sql`${t.status} IN (${sql.raw(ISSUE_DRAFT_STATUSES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'chk_issue_drafts_draft_kind',
      sql`${t.draftKind} IN (${sql.raw(ISSUE_DRAFT_KINDS.map((v) => `'${v}'`).join(', '))})`,
    ),
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
// via a raw SQL migration (see drizzle/_custom_tsvector.sql)

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
    lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
    /**
     * Embedding stored as REAL[] (PostgreSQL float4 array).
     * NULL when no embedding provider was available at insertion time.
     * Used for hybrid BM25 + semantic search (feature #4).
     */
    embedding: doublePrecision('embedding').array(),
    /**
     * Provider id that produced `embedding` (e.g. 'openai-compatible', 'local').
     * NULL when `embedding` is NULL. Used by the read guard to detect
     * provider/dimension mismatches on rows embedded by a different config.
     */
    embeddingModel: text('embedding_model'),
    /**
     * Vector length of `embedding` at insertion time.
     * NULL when `embedding` is NULL. Compared against the active provider's
     * `dimension` on read; mismatched rows are excluded from the cosine set.
     */
    embeddingDim: integer('embedding_dim'),
  },
  (t) => [
    index('idx_observations_project').on(t.project),
    index('idx_observations_topic_key').on(t.topicKey),
    index('idx_observations_type').on(t.type),
    index('idx_observations_content_hash').on(t.contentHash),
    index('idx_observations_created_at').on(t.createdAt),
    index('idx_observations_last_accessed_at').on(t.lastAccessedAt),
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

// ─── Explanation Invocations ─────────────────────────────────────

export const EXPLANATION_EXECUTION_STATUSES = [
  'PENDING',
  'DISPATCH_RESERVED',
  'ANSWERED',
  'INVALID',
  'UNAUTHORIZED',
  'DISABLED',
  'STALE',
  'AI_UNAVAILABLE',
  'AMBIGUOUS',
] as const;
export type ExplanationExecutionStatus = (typeof EXPLANATION_EXECUTION_STATUSES)[number];

export const EXPLANATION_PUBLICATION_STATUSES = [
  'NOT_STARTED',
  'CREATE_STARTED',
  'PATCH_STARTED',
  'PUBLISHED',
  'STALE',
  'AMBIGUOUS',
] as const;
export type ExplanationPublicationStatus = (typeof EXPLANATION_PUBLICATION_STATUSES)[number];

/**
 * Durable, identity-bound explanation work. Identity fields are opaque strings
 * because forge and installation identifiers are not database-local foreign keys.
 * Lifecycle transitions are intentionally deferred to later work units.
 */
export const explanationInvocations = pgTable(
  'explanation_invocations',
  {
    id: serial('id').primaryKey(),
    invocationKey: varchar('invocation_key', { length: 64 }).notNull(),
    forgeInstance: text('forge_instance').notNull(),
    installationId: text('installation_id').notNull(),
    actorId: text('actor_id').notNull(),
    repositoryId: text('repository_id').notNull(),
    pullRequestNumber: integer('pull_request_number').notNull(),
    requestedHeadSha: text('requested_head_sha').notNull(),
    sourceCommentId: text('source_comment_id').notNull(),
    questionHash: varchar('question_hash', { length: 64 }).notNull(),
    question: text('question').notNull(),

    executionStatus: varchar('execution_status', { length: 32 })
      .default('PENDING')
      .notNull()
      .$type<ExplanationExecutionStatus>(),
    executionFence: text('execution_fence'),
    dispatchReservedAt: timestamp('dispatch_reserved_at'),
    dispatchLeaseExpiresAt: timestamp('dispatch_lease_expires_at'),
    outcomeStatus: varchar('outcome_status', { length: 32 }).$type<ExplanationExecutionStatus>(),
    outcomeAnswer: text('outcome_answer'),
    outcomePayload: jsonb('outcome_payload'),
    outcomeCompletedAt: timestamp('outcome_completed_at'),

    progressStatus: varchar('progress_status', { length: 32 }),
    progressVersion: integer('progress_version').default(0).notNull(),
    progressPublicationStatus: varchar('progress_publication_status', { length: 32 })
      .default('NOT_STARTED')
      .notNull()
      .$type<ExplanationPublicationStatus>(),
    progressPublicationCreateStartedAt: timestamp('progress_publication_create_started_at'),
    progressCommentId: bigint('progress_comment_id', { mode: 'number' }),
    progressExpectedBotAuthorId: bigint('progress_expected_bot_author_id', { mode: 'number' }),
    progressPublicationFence: text('progress_publication_fence'),
    progressPublicationVersion: integer('progress_publication_version').default(0).notNull(),

    answerPublicationStatus: varchar('answer_publication_status', { length: 32 })
      .default('NOT_STARTED')
      .notNull()
      .$type<ExplanationPublicationStatus>(),
    answerPublicationCreateStartedAt: timestamp('answer_publication_create_started_at'),
    answerCommentId: bigint('answer_comment_id', { mode: 'number' }),
    answerExpectedBotAuthorId: bigint('answer_expected_bot_author_id', { mode: 'number' }),
    answerPublicationFence: text('answer_publication_fence'),
    answerPublicationVersion: integer('answer_publication_version').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    unique('uq_explanation_invocations_key').on(t.invocationKey),
    uniqueIndex('uq_explanation_invocations_full_identity').on(
      t.forgeInstance,
      t.installationId,
      t.actorId,
      t.repositoryId,
      t.pullRequestNumber,
      t.requestedHeadSha,
      t.sourceCommentId,
      t.questionHash,
    ),
    check(
      'chk_explanation_invocations_execution_status',
      sql`${t.executionStatus} IN (${sql.raw(
        EXPLANATION_EXECUTION_STATUSES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    check(
      'chk_explanation_invocations_progress_publication_status',
      sql`${t.progressPublicationStatus} IN (${sql.raw(
        EXPLANATION_PUBLICATION_STATUSES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    check(
      'chk_explanation_invocations_answer_publication_status',
      sql`${t.answerPublicationStatus} IN (${sql.raw(
        EXPLANATION_PUBLICATION_STATUSES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
  ],
);
