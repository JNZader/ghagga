import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  type DbProviderChainEntry,
  DEFAULT_REPO_SETTINGS,
  githubUserMappings,
  installationSettings,
  installations,
  memoryObservations,
  memorySessions,
  type RepoSettings,
  repositories,
  reviews,
} from './schema.js';

// ─── Installations ──────────────────────────────────────────────

export async function upsertInstallation(
  db: Database,
  data: {
    githubInstallationId: number;
    accountLogin: string;
    accountType: string;
  },
) {
  const existing = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallationId, data.githubInstallationId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(installations)
      .set({
        accountLogin: data.accountLogin,
        accountType: data.accountType,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(installations.githubInstallationId, data.githubInstallationId));
    // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
    return existing[0]!;
  }

  const [result] = await db.insert(installations).values(data).returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

export async function deactivateInstallation(db: Database, githubInstallationId: number) {
  await db
    .update(installations)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(installations.githubInstallationId, githubInstallationId));
}

export async function getInstallationByGitHubId(db: Database, githubInstallationId: number) {
  const rows = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallationId, githubInstallationId))
    .limit(1);

  return rows[0] ?? null;
}

export async function getInstallationsByAccountLogin(db: Database, accountLogin: string) {
  return db
    .select()
    .from(installations)
    .where(and(eq(installations.accountLogin, accountLogin), eq(installations.isActive, true)));
}

// ─── Installation Settings ──────────────────────────────────────

export async function getInstallationSettings(db: Database, installationId: number) {
  const [row] = await db
    .select()
    .from(installationSettings)
    .where(eq(installationSettings.installationId, installationId))
    .limit(1);
  return row ?? null;
}

/**
 * Fetch installation settings for multiple installation IDs in a single query.
 * Avoids the N+1 pattern when a user has access to multiple installations.
 * Returns an empty array if ids is empty.
 */
export async function getInstallationSettingsBatch(db: Database, installationIds: number[]) {
  if (installationIds.length === 0) return [];
  return db
    .select()
    .from(installationSettings)
    .where(inArray(installationSettings.installationId, installationIds));
}

export async function upsertInstallationSettings(
  db: Database,
  installationId: number,
  updates: {
    providerChain?: DbProviderChainEntry[];
    aiReviewEnabled?: boolean;
    reviewMode?: string;
    settings?: RepoSettings;
  },
) {
  const existing = await getInstallationSettings(db, installationId);

  if (existing) {
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.providerChain !== undefined) setValues.providerChain = updates.providerChain;
    if (updates.aiReviewEnabled !== undefined) setValues.aiReviewEnabled = updates.aiReviewEnabled;
    if (updates.reviewMode !== undefined) setValues.reviewMode = updates.reviewMode;
    if (updates.settings !== undefined) setValues.settings = updates.settings;

    await db
      .update(installationSettings)
      .set(setValues)
      .where(eq(installationSettings.installationId, installationId));
    return { ...existing, ...setValues };
  }

  const [result] = await db
    .insert(installationSettings)
    .values({
      installationId,
      providerChain: updates.providerChain ?? [],
      aiReviewEnabled: updates.aiReviewEnabled ?? true,
      reviewMode: updates.reviewMode ?? 'simple',
      settings: updates.settings ?? DEFAULT_REPO_SETTINGS,
    })
    .returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

export async function getInstallationById(db: Database, installationId: number) {
  const [row] = await db
    .select()
    .from(installations)
    .where(eq(installations.id, installationId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the effective settings for a repository.
 * If use_global_settings is true, returns installation-level settings.
 * Otherwise returns the repo's own settings.
 */
export interface EffectiveSettings {
  providerChain: DbProviderChainEntry[];
  aiReviewEnabled: boolean;
  reviewMode: string;
  settings: RepoSettings;
  source: 'global' | 'repo';
}

export async function getEffectiveRepoSettings(
  db: Database,
  repo: {
    installationId: number;
    useGlobalSettings: boolean;
    providerChain: DbProviderChainEntry[] | unknown;
    aiReviewEnabled: boolean;
    reviewMode: string;
    settings: RepoSettings | unknown;
  },
): Promise<EffectiveSettings> {
  if (!repo.useGlobalSettings) {
    return {
      providerChain: (repo.providerChain ?? []) as DbProviderChainEntry[],
      aiReviewEnabled: repo.aiReviewEnabled,
      reviewMode: repo.reviewMode,
      settings: (repo.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings,
      source: 'repo',
    };
  }

  const globalSettings = await getInstallationSettings(db, repo.installationId);

  if (globalSettings) {
    return {
      providerChain: (globalSettings.providerChain ?? []) as DbProviderChainEntry[],
      aiReviewEnabled: globalSettings.aiReviewEnabled,
      reviewMode: globalSettings.reviewMode,
      settings: (globalSettings.settings ?? DEFAULT_REPO_SETTINGS) as RepoSettings,
      source: 'global',
    };
  }

  // No installation settings exist — return defaults
  return {
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: DEFAULT_REPO_SETTINGS,
    source: 'global',
  };
}

// ─── Repositories ───────────────────────────────────────────────

export async function getRepositoryById(db: Database, id: number) {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

export async function upsertRepository(
  db: Database,
  data: {
    githubRepoId: number;
    installationId: number;
    fullName: string;
  },
) {
  const existing = await db
    .select()
    .from(repositories)
    .where(eq(repositories.githubRepoId, data.githubRepoId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(repositories)
      .set({
        fullName: data.fullName,
        installationId: data.installationId,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(repositories.githubRepoId, data.githubRepoId));
    // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
    return existing[0]!;
  }

  const [result] = await db
    .insert(repositories)
    .values({ ...data, settings: DEFAULT_REPO_SETTINGS })
    .returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

export async function getRepoByFullName(db: Database, fullName: string) {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.fullName, fullName))
    .limit(1);
  return repo ?? null;
}

export async function getRepoByGithubId(db: Database, githubRepoId: number) {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.githubRepoId, githubRepoId))
    .limit(1);
  return repo ?? null;
}

export async function updateRepoSettings(
  db: Database,
  repoId: number,
  updates: {
    settings?: RepoSettings;
    llmProvider?: string;
    llmModel?: string;
    reviewMode?: string;
    providerChain?: DbProviderChainEntry[];
    aiReviewEnabled?: boolean;
    useGlobalSettings?: boolean;
  },
) {
  await db
    .update(repositories)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(repositories.id, repoId));
}

export async function saveRepoApiKey(db: Database, repoId: number, encryptedKey: string) {
  await db
    .update(repositories)
    .set({ encryptedApiKey: encryptedKey, updatedAt: new Date() })
    .where(eq(repositories.id, repoId));
}

export async function removeRepoApiKey(db: Database, repoId: number) {
  await db
    .update(repositories)
    .set({ encryptedApiKey: null, updatedAt: new Date() })
    .where(eq(repositories.id, repoId));
}

export async function getReposByInstallationId(db: Database, installationId: number) {
  return db
    .select()
    .from(repositories)
    .where(and(eq(repositories.installationId, installationId), eq(repositories.isActive, true)));
}

export async function updateWorkflowStatus(
  db: Database,
  repoId: number,
  data: { workflowSha: string; workflowInstalledAt: Date },
) {
  await db
    .update(repositories)
    .set({
      workflowSha: data.workflowSha,
      workflowInstalledAt: data.workflowInstalledAt,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repoId));
}

// ─── Reviews ────────────────────────────────────────────────────

export async function saveReview(
  db: Database,
  data: {
    repositoryId: number;
    prNumber: number;
    status: string;
    mode: string;
    summary?: string;
    findings?: unknown[];
    tokensUsed?: number;
    executionTimeMs?: number;
    metadata?: unknown;
  },
) {
  const [result] = await db.insert(reviews).values(data).returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

export async function getReviewsByRepoId(
  db: Database,
  repositoryId: number,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 50, offset = 0 } = options;
  return db
    .select()
    .from(reviews)
    .where(eq(reviews.repositoryId, repositoryId))
    .orderBy(desc(reviews.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Count all reviews for a specific repository.
 * Used to compute pagination.total for the per-repo review listing.
 */
export async function countReviewsByRepoId(db: Database, repositoryId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reviews)
    .where(eq(reviews.repositoryId, repositoryId));
  return row?.total ?? 0;
}

/**
 * A review row enriched with its repository's full name, for cross-repository
 * listings where the caller needs to label which repo each review belongs to.
 */
export type ReviewWithRepo = typeof reviews.$inferSelect & { fullName: string };

/**
 * List reviews across ALL repositories belonging to the given installation IDs,
 * ordered by createdAt desc, with limit/offset pagination.
 *
 * Each row carries the repository `fullName` (via the join) so the caller can
 * label reviews by repo. Returns an empty array when installationIds is empty
 * (authz: a caller with no installations sees nothing).
 */
export async function getReviewsByInstallationIds(
  db: Database,
  installationIds: number[],
  options: { limit?: number; offset?: number } = {},
): Promise<ReviewWithRepo[]> {
  if (installationIds.length === 0) return [];

  const { limit = 50, offset = 0 } = options;
  return (
    db
      .select({
        id: reviews.id,
        repositoryId: reviews.repositoryId,
        prNumber: reviews.prNumber,
        status: reviews.status,
        mode: reviews.mode,
        summary: reviews.summary,
        findings: reviews.findings,
        tokensUsed: reviews.tokensUsed,
        executionTimeMs: reviews.executionTimeMs,
        metadata: reviews.metadata,
        createdAt: reviews.createdAt,
        fullName: repositories.fullName,
      })
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      // SECURITY (cross-tenant isolation): the early-return above guards the
      // empty-installationIds path, but `inArray(col, [])` is ALSO safe at the SQL
      // layer — drizzle renders it as `WHERE false` (zero rows), never an
      // unconstrained query that would leak every tenant's reviews. Do NOT
      // "optimize away" the guard above OR assume a future drizzle upgrade keeps
      // this semantic: queries.test.ts locks the generated SQL via .toSQL() so an
      // upgrade that drops the WHERE clause fails the suite instead of leaking.
      .where(inArray(repositories.installationId, installationIds))
      .orderBy(desc(reviews.createdAt))
      .limit(limit)
      .offset(offset)
  );
}

/**
 * Count all reviews across the repositories owned by the given installation IDs.
 * Used to compute pagination.total for the cross-installation review listing.
 * Returns 0 when installationIds is empty.
 */
export async function countReviewsByInstallationIds(
  db: Database,
  installationIds: number[],
): Promise<number> {
  if (installationIds.length === 0) return 0;

  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reviews)
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    // SECURITY (cross-tenant isolation): same empty-array safety as
    // getReviewsByInstallationIds — `inArray(col, [])` renders `WHERE false`
    // (count 0), not an unconstrained count over every tenant. Guard above +
    // .toSQL() lock in queries.test.ts must both stay. See that function's note.
    .where(inArray(repositories.installationId, installationIds));
  return row?.total ?? 0;
}

export async function getReviewStats(db: Database, repositoryId: number) {
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) filter (where ${reviews.status} = 'PASSED')::int`,
      failed: sql<number>`count(*) filter (where ${reviews.status} = 'FAILED')::int`,
      skipped: sql<number>`count(*) filter (where ${reviews.status} = 'SKIPPED')::int`,
    })
    .from(reviews)
    .where(eq(reviews.repositoryId, repositoryId));
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result[0]!;
}

export async function getReviewsByDay(db: Database, repositoryId: number) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  return db
    .select({
      date: sql<string>`to_char(date(${reviews.createdAt}), 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) filter (where ${reviews.status} = 'PASSED')::int`,
      failed: sql<number>`count(*) filter (where ${reviews.status} = 'FAILED')::int`,
    })
    .from(reviews)
    .where(
      and(eq(reviews.repositoryId, repositoryId), sql`${reviews.createdAt} >= ${thirtyDaysAgo}`),
    )
    .groupBy(sql`date(${reviews.createdAt})`)
    .orderBy(sql`date(${reviews.createdAt}) asc`);
}

// ─── Cost Statistics ────────────────────────────────────────────

export interface ReviewCostRow {
  repositoryId: number;
  fullName: string;
  mode: string;
  model: string | null;
  tokens: number;
  count: number;
}

/**
 * Aggregate token / review counts across all repositories accessible to the
 * given installation IDs, for the specified number of days back.
 *
 * Returns one row per (repositoryId, mode, model) combination so the caller
 * can pivot into any desired shape (byModel, byMode, byRepo).
 */
export async function getReviewCostStats(
  db: Database,
  installationIds: number[],
  days: number,
): Promise<ReviewCostRow[]> {
  if (installationIds.length === 0) return [];

  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      repositoryId: reviews.repositoryId,
      fullName: repositories.fullName,
      mode: reviews.mode,
      model: sql<string | null>`${reviews.metadata}->>'model'`,
      tokens: sql<number>`coalesce(sum(${reviews.tokensUsed}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .where(
      and(
        inArray(repositories.installationId, installationIds),
        sql`${reviews.createdAt} >= ${since}`,
      ),
    )
    .groupBy(
      reviews.repositoryId,
      repositories.fullName,
      reviews.mode,
      sql`${reviews.metadata}->>'model'`,
    );

  return rows;
}

/**
 * Delete all reviews for a specific repository by its ID.
 * Returns the count of deleted rows.
 */
export async function deleteReviewsByRepoId(db: Database, repositoryId: number): Promise<number> {
  const result = await db
    .delete(reviews)
    .where(eq(reviews.repositoryId, repositoryId))
    .returning({ id: reviews.id });

  return result.length;
}

// ─── Memory: Sessions ───────────────────────────────────────────

export async function createMemorySession(
  db: Database,
  data: { project: string; prNumber?: number },
) {
  const [session] = await db.insert(memorySessions).values(data).returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return session!;
}

export async function endMemorySession(db: Database, sessionId: number, summary: string) {
  await db
    .update(memorySessions)
    .set({ endedAt: new Date(), summary })
    .where(eq(memorySessions.id, sessionId));
}

export async function getSessionsByProject(
  db: Database,
  project: string,
  options: { limit?: number } = {},
) {
  const { limit = 20 } = options;
  const rows = await db
    .select({
      id: memorySessions.id,
      project: memorySessions.project,
      prNumber: memorySessions.prNumber,
      summary: memorySessions.summary,
      createdAt: memorySessions.startedAt,
      observationCount: sql<number>`cast(count(${memoryObservations.id}) as int)`,
      criticalCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'critical' then 1 end) as int)`,
      highCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'high' then 1 end) as int)`,
      mediumCount: sql<number>`cast(count(case when ${memoryObservations.severity} = 'medium' then 1 end) as int)`,
    })
    .from(memorySessions)
    .leftJoin(memoryObservations, eq(memoryObservations.sessionId, memorySessions.id))
    .where(eq(memorySessions.project, project))
    .groupBy(memorySessions.id)
    .orderBy(desc(memorySessions.startedAt))
    .limit(limit);
  return rows;
}

export async function getSessionById(db: Database, sessionId: number) {
  const [session] = await db
    .select()
    .from(memorySessions)
    .where(eq(memorySessions.id, sessionId))
    .limit(1);
  return session ?? null;
}

// ─── Memory: Observations ───────────────────────────────────────

function computeContentHash(content: string, type: string, title: string): string {
  return createHash('sha256').update(`${type}:${title}:${content}`).digest('hex');
}

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export async function saveObservation(
  db: Database,
  data: {
    sessionId?: number;
    project: string;
    type: string;
    title: string;
    content: string;
    topicKey?: string;
    filePaths?: string[];
    severity?: string;
    /** Pre-computed embedding vector. NULL when no embedding provider was available. */
    embedding?: number[] | null;
    /**
     * Provider/model id that produced `embedding` (design D3). NULL alongside
     * a NULL/omitted `embedding`. Only meaningful when `embedding` is set.
     */
    embeddingModel?: string | null;
    /**
     * Vector length of `embedding` at insertion time (design D3). NULL
     * alongside a NULL/omitted `embedding`. Only meaningful when `embedding`
     * is set.
     */
    embeddingDim?: number | null;
  },
) {
  const contentHash = computeContentHash(data.content, data.type, data.title);
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS);

  // Deduplication: check for same content hash within rolling window
  const [existing] = await db
    .select()
    .from(memoryObservations)
    .where(
      and(
        eq(memoryObservations.contentHash, contentHash),
        eq(memoryObservations.project, data.project),
        sql`${memoryObservations.createdAt} > ${windowStart}`,
      ),
    )
    .limit(1);

  if (existing) {
    // If the existing observation is from a different session, reassign it
    if (data.sessionId != null && existing.sessionId !== data.sessionId) {
      const [updated] = await db
        .update(memoryObservations)
        .set({ sessionId: data.sessionId, updatedAt: new Date() })
        .where(eq(memoryObservations.id, existing.id))
        .returning();
      // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
      return updated!;
    }
    return existing; // Skip duplicate
  }

  // Topic-key upsert: update existing observation with same topic_key
  if (data.topicKey) {
    const [existingByTopic] = await db
      .select()
      .from(memoryObservations)
      .where(
        and(
          eq(memoryObservations.topicKey, data.topicKey),
          eq(memoryObservations.project, data.project),
        ),
      )
      .limit(1);

    if (existingByTopic) {
      const [updated] = await db
        .update(memoryObservations)
        .set({
          content: data.content,
          title: data.title,
          contentHash,
          filePaths: data.filePaths ?? [],
          severity: data.severity ?? null,
          // Only update embedding (+ its metadata) when a new one is provided
          // (preserve existing otherwise) — mirrors the SQLite backend's
          // per-row embedding_model/embedding_dim persistence (design D3).
          ...(data.embedding !== undefined
            ? {
                embedding: data.embedding,
                embeddingModel: data.embeddingModel ?? null,
                embeddingDim: data.embeddingDim ?? null,
              }
            : {}),
          revisionCount: sql`${memoryObservations.revisionCount} + 1`,
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
        })
        .where(eq(memoryObservations.id, existingByTopic.id))
        .returning();
      // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
      return updated!;
    }
  }

  // New observation
  const [result] = await db
    .insert(memoryObservations)
    .values({
      ...data,
      contentHash,
      filePaths: data.filePaths ?? [],
      embedding: data.embedding ?? null,
      embeddingModel: data.embeddingModel ?? null,
      embeddingDim: data.embeddingDim ?? null,
    })
    .returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

/**
 * Build a sanitized tsquery string from free-text input.
 *
 * Each word is quoted as a lexeme and terms are joined with OR ('|') —
 * matching the SQLite backend's behavior. AND ('&') made multi-file diff
 * queries (5-8 unrelated terms) return ~nothing, killing server memory recall.
 *
 * Backslashes are escaped first: inside a quoted lexeme, a trailing '\\' would
 * otherwise escape the closing quote and produce a tsquery syntax error.
 *
 * Exported for unit testing (no live PG needed).
 */
export function buildTsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `'${w.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`)
    .join(' | ');
}

/** Bounded cosine candidate set size (design D4) when the caller doesn't specify one. */
const DEFAULT_EMBEDDING_CANDIDATE_K = 200;

/**
 * Cosine similarity between two same-length numeric vectors. Returns 0 when
 * either norm is 0 (avoids a 0/0 NaN) — mirrors the SQLite backend's
 * `cosineSimilarity` helper (packages/core/src/embed.ts) so both engines
 * score identically post-union (design D5).
 */
function cosineSimilarityArrays(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let j = 0; j < a.length; j++) {
    const x = a[j] ?? 0;
    const y = b[j] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Bumps `last_accessed_at` for exactly the given observation ids (spec R5.10).
 *
 * Exported so a decay-aware caller (the Postgres adapter) can touch ONLY the
 * final survivors AFTER its own strength-decay filter — mirroring the SQLite
 * oracle's `accessedIds` scoping (packages/core/src/memory/sqlite.ts). On the
 * union (embedFn-set) path, `searchObservations` intentionally does NOT touch
 * here (it returns the full, uncapped, un-touched scored pool), so the adapter
 * owns the touch of the rows that actually survive decay AND make the limit cut.
 * No-op on an empty id list.
 */
export async function bumpObservationsLastAccessed(db: Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memoryObservations)
    .set({ lastAccessedAt: new Date() })
    .where(inArray(memoryObservations.id, ids));
}

/** Bumps `last_accessed_at` for exactly the rows returned to the caller (spec R5.10). */
async function touchLastAccessed(db: Database, rows: Array<{ id: number }>): Promise<void> {
  await bumpObservationsLastAccessed(
    db,
    rows.map((r) => r.id),
  );
}

/**
 * Full-text search observations using PostgreSQL tsvector.
 * The search_observations SQL column is maintained by a trigger.
 *
 * When `embedFn` is provided, performs hybrid search (spec R5.7-R5.10, design
 * D4/D5 — mirrors packages/core/src/memory/sqlite.ts `_hybridSearch`):
 *   1. Run the tsquery keyword candidates (unchanged gate/order).
 *   2. Run a bounded, project(+type)-scoped cosine candidate query
 *      (embedding IS NOT NULL, ORDER BY last_accessed_at DESC LIMIT K).
 *   3. Compute cosine similarity in JS for candidates passing the
 *      dimension/model read guard (mismatches excluded, never thrown).
 *   4. Union both sets by id, dedup: an overlapping candidate keeps its real
 *      keyword score; a cosine-only candidate gets keyword-score 0.
 *   5. Keyword score uses the unified positional-rank convention
 *      `1 - i/(n-1)` over the ts_rank-ordered list (design D5).
 *   6. Combine: finalScore = 0.7 * cosineSim + 0.3 * keywordScore.
 *   7. Sort descending and return the FULL scored pool UNCAPPED, WITHOUT
 *      touching last_accessed_at. The union path has no decay concept (that
 *      lives in the adapter), so it must not cap before decay (R3-001) nor
 *      touch rows a later decay filter will drop (R3-002). The decay-aware
 *      caller (PostgresMemoryStorage) filters the full pool by strength, caps
 *      to the true `limit`, then calls `bumpObservationsLastAccessed` on ONLY
 *      those survivors — mirroring the SQLite oracle (decay-filter full pool →
 *      cap → touch survivors).
 *
 * Otherwise (no `embedFn`) falls back to keyword-only tsvector search,
 * byte-for-byte identical to the pre-union behavior (spec R5.11): it caps to
 * returnLimit and touches last_accessed_at itself.
 */
export async function searchObservations(
  db: Database,
  project: string,
  query: string,
  options: {
    limit?: number;
    type?: string;
    /**
     * Optional embedding function for hybrid search.
     * When provided, the bounded cosine candidate set is unioned with the
     * keyword candidates before ranking (spec R5.7).
     * When undefined, falls back to keyword-only tsvector search (R5.11).
     */
    embedFn?: (text: string) => Promise<number[]>;
    /**
     * Number of ranked rows to RETURN (after re-ranking). Defaults to `limit`.
     * Callers that post-filter rows (e.g. strength decay in the adapter) pass a
     * larger value so the over-fetched candidates survive ranking and the caller
     * can drop decayed rows without under-delivering below `limit`.
     */
    fetchLimit?: number;
    /**
     * Active embedding provider's vector dimension (design D3 read guard).
     * Required, together with `embedFn`, to admit any row into the cosine
     * candidate set — when `embedFn` is set but this is omitted, every row
     * fails the dimension guard and the cosine set is simply empty (never
     * throws).
     */
    embeddingDimension?: number;
    /**
     * Active embedding provider/model id, compared against each row's stored
     * `embedding_model` (design D3). Optional — when omitted, only the
     * dimension is enforced (mirrors the SQLite backend's `embeddingModel`
     * option, packages/core/src/memory/sqlite.ts).
     */
    embeddingModel?: string;
    /** Bounded cosine candidate set size (design D4). Defaults to 200. */
    embeddingCandidateK?: number;
  } = {},
) {
  const { limit = 10, type, embedFn, embeddingDimension, embeddingModel } = options;
  const embeddingCandidateK = options.embeddingCandidateK ?? DEFAULT_EMBEDDING_CANDIDATE_K;
  // How many ranked rows the caller wants back (>= limit when post-filtering).
  const returnLimit = Math.max(options.fetchLimit ?? limit, limit);

  const sanitizedQuery = buildTsQuery(query);

  if (!sanitizedQuery) return [];

  // The `@@ to_tsquery` predicate below is the keyword candidate gate,
  // unchanged by this union (spec R5.1).
  const conditions: SQL[] = [
    eq(memoryObservations.project, project),
    sql`search_observations @@ to_tsquery('english', ${sanitizedQuery})`,
  ];

  if (type) {
    conditions.push(eq(memoryObservations.type, type));
  }

  // Fetch a larger candidate set when doing hybrid re-ranking, and never fewer
  // than the caller asked to RETURN (returnLimit) so post-filtering has headroom.
  const candidateLimit = Math.max(embedFn ? limit * 5 : limit, returnLimit);

  const keywordResults = await db
    .select()
    .from(memoryObservations)
    .where(and(...conditions))
    .orderBy(sql`ts_rank(search_observations, to_tsquery('english', ${sanitizedQuery})) DESC`)
    .limit(candidateLimit);

  // ── R5.11: no-provider parity — byte-for-byte identical to the pre-union
  // keyword-only path. No cosine query, no union/dedup step ever runs. ──────
  if (!embedFn) {
    if (keywordResults.length === 0) return [];
    const finalResults = keywordResults.slice(0, returnLimit);
    await touchLastAccessed(db, finalResults);
    return finalResults;
  }

  type ObservationRow = (typeof keywordResults)[number];

  // Query-time embed failure is non-fatal — fall back to keyword-only
  // ordering (spec: Graceful Degradation on Provider/API Failure).
  let queryVec: number[];
  try {
    queryVec = await embedFn(query);
  } catch (error) {
    // Query-time embed failure → keyword-only ordering. This is still the
    // union (embedFn-set) path, so keep the union contract: return the FULL
    // keyword pool UNCAPPED and UNTOUCHED. The decay-aware caller filters it,
    // caps to `limit`, and touches only the survivors (R3-001/R3-002).
    // Warn once (symmetric with the SQLite backend's _hybridSearch).
    console.warn(
      `[ghagga] query embedding failed — degrading to keyword-only for this search: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return keywordResults;
  }

  // ── Bounded cosine candidate query (spec R5.7, design D4) ────────────────
  // Runs even when keywordResults is empty — a lexically-disjoint observation
  // must still be reachable via cosine alone.
  const cosineConditions: SQL[] = [
    eq(memoryObservations.project, project),
    sql`${memoryObservations.embedding} IS NOT NULL`,
  ];
  if (type) {
    cosineConditions.push(eq(memoryObservations.type, type));
  }

  const cosineBoundedCandidates = await db
    .select()
    .from(memoryObservations)
    .where(and(...cosineConditions))
    .orderBy(desc(memoryObservations.lastAccessedAt))
    .limit(embeddingCandidateK);

  if (keywordResults.length === 0 && cosineBoundedCandidates.length === 0) return [];

  // Dimension/model read guard (design D3): a row whose stored dimension or
  // model doesn't match the active provider is excluded from the cosine set,
  // never thrown — mirrors the pre-existing "no embedding → cosine 0" rule.
  const isEmbeddingUsable = (row: ObservationRow): boolean => {
    if (!row.embedding) return false;
    if (row.embeddingDim !== null && row.embeddingDim !== embeddingDimension) return false;
    if (embeddingModel !== undefined && row.embeddingModel !== embeddingModel) return false;
    return true;
  };

  const computeCosine = (row: ObservationRow): number => {
    if (!row.embedding || !isEmbeddingUsable(row)) return 0;
    if (row.embedding.length !== queryVec.length) return 0;
    return cosineSimilarityArrays(queryVec, row.embedding);
  };

  // ── Unified positional-rank keyword score (design D5) ────────────────────
  // keywordResults is already ordered by ts_rank DESC (best match first).
  const n = keywordResults.length;
  const keywordScoreById = new Map<number, number>();
  keywordResults.forEach((row, i) => {
    keywordScoreById.set(row.id, n > 1 ? 1 - i / (n - 1) : 1);
  });

  // Cosine similarity, top limit*5 of the GUARDED bounded set.
  const cosineFetchLimit = limit * 5;
  const cosineTop = cosineBoundedCandidates
    .filter(isEmbeddingUsable)
    .map((row) => ({ row, cosineSim: computeCosine(row) }))
    .sort((a, b) => b.cosineSim - a.cosineSim)
    .slice(0, cosineFetchLimit);

  // ── Union + dedup by id (spec R5.8/R5.9) ──────────────────────────────────
  const merged = new Map<
    number,
    { row: ObservationRow; cosineSim: number; keywordScore: number }
  >();
  for (const row of keywordResults) {
    merged.set(row.id, {
      row,
      cosineSim: computeCosine(row),
      keywordScore: keywordScoreById.get(row.id) ?? 0,
    });
  }
  for (const { row, cosineSim } of cosineTop) {
    if (merged.has(row.id)) continue; // keep the real keyword score (R5.8)
    merged.set(row.id, { row, cosineSim, keywordScore: 0 }); // vector-only (R5.9)
  }

  if (merged.size === 0) return [];

  // ── Score, sort (spec R5.5/R5.8) ──────────────────────────────────────────
  const scored = Array.from(merged.values()).map(({ row, cosineSim, keywordScore }) => ({
    row,
    finalScore: 0.7 * cosineSim + 0.3 * keywordScore,
  }));
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // ── Union path: return the FULL scored+sorted pool, UNCAPPED and WITHOUT
  //    touching last_accessed_at (R3-001 / R3-002). Decay filtering must see
  //    the whole pool BEFORE any cap, and last_accessed_at must be bumped ONLY
  //    for the rows that survive decay AND make the caller's limit cut. Both
  //    are the decay-aware caller's responsibility (the union path has no decay
  //    concept). This mirrors the SQLite oracle: decay-filter full pool → cap
  //    to limit → touch survivors. See PostgresMemoryStorage.searchObservations.
  return scored.map((s) => s.row);
}

export async function getObservationsBySession(db: Database, sessionId: number) {
  return db
    .select()
    .from(memoryObservations)
    .where(eq(memoryObservations.sessionId, sessionId))
    .orderBy(desc(memoryObservations.createdAt));
}

// ─── Memory: Backfill (design D6) ────────────────────────────────
// Global (not installation-scoped) — the backfill script is a one-time
// admin maintenance job over the whole table, not a tenant-facing query.

/**
 * List up to `limit` observations needing an embedding for the active
 * provider/model, ordered by id ascending starting after `afterId`. Always
 * matches NULL-embedding rows; with `includeMismatched` also matches rows
 * whose stored `embeddingModel`/`embeddingDim` disagree with the active
 * provider (backfill `--re-embed`). Mirrors SqliteMemoryStorage's
 * `listObservationsNeedingEmbedding` (packages/core/src/memory/sqlite.ts).
 */
export async function listObservationsNeedingEmbedding(
  db: Database,
  options: {
    afterId: number;
    limit: number;
    activeModel: string;
    activeDim: number;
    includeMismatched: boolean;
  },
): Promise<{ id: number; text: string }[]> {
  const { afterId, limit, activeModel, activeDim, includeMismatched } = options;

  const needsEmbedding = includeMismatched
    ? or(
        sql`${memoryObservations.embedding} IS NULL`,
        sql`${memoryObservations.embeddingModel} IS NULL`,
        sql`${memoryObservations.embeddingModel} != ${activeModel}`,
        sql`${memoryObservations.embeddingDim} IS NULL`,
        sql`${memoryObservations.embeddingDim} != ${activeDim}`,
      )
    : sql`${memoryObservations.embedding} IS NULL`;

  const rows = await db
    .select({
      id: memoryObservations.id,
      title: memoryObservations.title,
      content: memoryObservations.content,
    })
    .from(memoryObservations)
    .where(and(gt(memoryObservations.id, afterId), needsEmbedding))
    .orderBy(asc(memoryObservations.id))
    .limit(limit);

  return rows.map((row) => ({ id: row.id, text: `${row.title} ${row.content}` }));
}

/**
 * Persist a backfilled embedding for a single observation (design D6).
 * Metadata-only write — content/updatedAt/lastAccessedAt are untouched.
 */
export async function updateObservationEmbedding(
  db: Database,
  id: number,
  embedding: number[],
  model: string,
  dim: number,
): Promise<void> {
  await db
    .update(memoryObservations)
    .set({ embedding, embeddingModel: model, embeddingDim: dim })
    .where(eq(memoryObservations.id, id));
}

// ─── Memory: Management (Delete / Clear / Purge) ────────────────

/**
 * Delete a single observation by ID, scoped to installation.
 * Uses subquery to verify the observation's project belongs to a repository
 * owned by the given installation. Returns true if deleted, false if not
 * found or not authorized.
 */
export async function deleteMemoryObservation(
  db: Database,
  installationId: number,
  observationId: number,
): Promise<boolean> {
  const result = await db
    .delete(memoryObservations)
    .where(
      and(
        eq(memoryObservations.id, observationId),
        inArray(
          memoryObservations.project,
          db
            .select({ fullName: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: memoryObservations.id });

  return result.length > 0;
}

/**
 * Clear all observations for a specific project, scoped to installation.
 * Verifies the project belongs to a repository owned by the installation.
 * Returns the count of deleted rows.
 */
export async function clearMemoryObservationsByProject(
  db: Database,
  installationId: number,
  project: string,
): Promise<number> {
  const result = await db
    .delete(memoryObservations)
    .where(
      and(
        eq(memoryObservations.project, project),
        inArray(
          memoryObservations.project,
          db
            .select({ fullName: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: memoryObservations.id });

  return result.length;
}

/**
 * Clear all observations for all repos belonging to an installation.
 * Returns the count of deleted rows.
 */
export async function clearAllMemoryObservations(
  db: Database,
  installationId: number,
): Promise<number> {
  const result = await db
    .delete(memoryObservations)
    .where(
      inArray(
        memoryObservations.project,
        db
          .select({ fullName: repositories.fullName })
          .from(repositories)
          .where(eq(repositories.installationId, installationId)),
      ),
    )
    .returning({ id: memoryObservations.id });

  return result.length;
}

// ─── Memory: Read Queries (Installation-Scoped) ─────────────────

/**
 * Get a single observation by ID, scoped to installation.
 * Returns the observation detail or null if not found / not authorized.
 */
export async function getMemoryObservation(
  db: Database,
  installationId: number,
  observationId: number,
) {
  const result = await db
    .select()
    .from(memoryObservations)
    .where(
      and(
        eq(memoryObservations.id, observationId),
        inArray(
          memoryObservations.project,
          db
            .select({ fullName: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    );

  return result[0] ?? null;
}

/**
 * List observations with optional filtering, scoped to installation.
 * Supports filtering by project, type, and pagination (limit/offset).
 */
export async function listMemoryObservations(
  db: Database,
  installationId: number,
  options?: {
    project?: string;
    type?: string;
    limit?: number;
    offset?: number;
  },
) {
  const conditions: SQL[] = [
    inArray(
      memoryObservations.project,
      db
        .select({ fullName: repositories.fullName })
        .from(repositories)
        .where(eq(repositories.installationId, installationId)),
    ),
  ];

  if (options?.project) {
    conditions.push(eq(memoryObservations.project, options.project));
  }

  if (options?.type) {
    conditions.push(eq(memoryObservations.type, options.type));
  }

  const query = db
    .select()
    .from(memoryObservations)
    .where(and(...conditions))
    .orderBy(desc(memoryObservations.createdAt))
    .limit(options?.limit ?? 100);

  if (options?.offset) {
    // biome-ignore lint/suspicious/noExplicitAny: drizzle query builder type workaround
    return (query as any).offset(options.offset);
  }

  return query;
}

/**
 * Get aggregate memory statistics for an installation.
 * Returns total count, breakdown by type and project, oldest/newest dates.
 */
export async function getMemoryStats(
  db: Database,
  installationId: number,
): Promise<{
  totalObservations: number;
  oldestDate: Date | null;
  newestDate: Date | null;
  byType: { type: string; count: number }[];
  byProject: { project: string; count: number }[];
}> {
  const scopeCondition = inArray(
    memoryObservations.project,
    db
      .select({ fullName: repositories.fullName })
      .from(repositories)
      .where(eq(repositories.installationId, installationId)),
  );

  // Total count and date range
  const [summary] = await db
    .select({
      total: sql<number>`cast(count(*) as integer)`,
      oldest: sql<Date | null>`min(${memoryObservations.createdAt})`,
      newest: sql<Date | null>`max(${memoryObservations.createdAt})`,
    })
    .from(memoryObservations)
    .where(scopeCondition);

  // Breakdown by type
  const byType = await db
    .select({
      type: memoryObservations.type,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(memoryObservations)
    .where(scopeCondition)
    .groupBy(memoryObservations.type);

  // Breakdown by project
  const byProject = await db
    .select({
      project: memoryObservations.project,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(memoryObservations)
    .where(scopeCondition)
    .groupBy(memoryObservations.project);

  return {
    totalObservations: summary?.total ?? 0,
    oldestDate: summary?.oldest ?? null,
    newestDate: summary?.newest ?? null,
    byType,
    byProject,
  };
}

// ─── User Mappings ──────────────────────────────────────────────

/**
 * Upsert a user-installation mapping using the composite key (github_user_id, installation_id).
 * If the combination already exists, updates github_login. Otherwise inserts a new mapping.
 * This allows the same user to have mappings to multiple installations.
 */
export async function upsertUserMapping(
  db: Database,
  data: {
    githubUserId: number;
    githubLogin: string;
    installationId: number;
  },
) {
  const existing = await db
    .select()
    .from(githubUserMappings)
    .where(
      and(
        eq(githubUserMappings.githubUserId, data.githubUserId),
        eq(githubUserMappings.installationId, data.installationId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(githubUserMappings)
      .set({ githubLogin: data.githubLogin })
      .where(
        and(
          eq(githubUserMappings.githubUserId, data.githubUserId),
          eq(githubUserMappings.installationId, data.installationId),
        ),
      );
    // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
    return existing[0]!;
  }

  const [result] = await db.insert(githubUserMappings).values(data).returning();
  // biome-ignore lint/style/noNonNullAssertion: drizzle .returning() always returns for insert/update
  return result!;
}

/**
 * Get active installations for a user by their GitHub user ID.
 *
 * This function joins user mappings with the installations table and
 * filters by `is_active = true`. This means it will NOT return installations
 * that have been deactivated (uninstalled). If a user has mappings pointing
 * to deactivated installations, those are silently excluded from the result.
 *
 * To get raw mappings without the active filter, use `getRawMappingsByUserId`.
 */
export async function getInstallationsByUserId(db: Database, githubUserId: number) {
  const mappings = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUserId, githubUserId));

  if (mappings.length === 0) return [];

  const installationIds = mappings.map((m) => m.installationId);
  return db
    .select()
    .from(installations)
    .where(and(inArray(installations.id, installationIds), eq(installations.isActive, true)));
}

/**
 * Get raw user mappings WITHOUT filtering by active installation.
 * Returns all mappings for a user, including those pointing to
 * deactivated or non-existent installations.
 *
 * Used by the auth middleware to detect stale mappings.
 */
export async function getRawMappingsByUserId(
  db: Database,
  githubUserId: number,
): Promise<
  Array<{ id: number; githubUserId: number; githubLogin: string; installationId: number }>
> {
  return db
    .select({
      id: githubUserMappings.id,
      githubUserId: githubUserMappings.githubUserId,
      githubLogin: githubUserMappings.githubLogin,
      installationId: githubUserMappings.installationId,
    })
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUserId, githubUserId));
}

/**
 * Delete specific user mappings by their IDs.
 * Used to clean up stale mappings that point to deactivated installations.
 * No-op if mappingIds is empty.
 */
export async function deleteStaleUserMappings(db: Database, mappingIds: number[]): Promise<void> {
  if (mappingIds.length === 0) return;

  await db.delete(githubUserMappings).where(inArray(githubUserMappings.id, mappingIds));
}

/**
 * Delete ALL user mappings for a given installation.
 * Used by the webhook handler when an installation is deleted/uninstalled.
 * No-op if no mappings exist for the installation.
 */
export async function deleteMappingsByInstallationId(
  db: Database,
  installationId: number,
): Promise<void> {
  await db.delete(githubUserMappings).where(eq(githubUserMappings.installationId, installationId));
}

// ─── Memory: Session Deletion ───────────────────────────────────

/**
 * Delete a single memory session, scoped to installation.
 * CASCADE will handle deleting associated observations.
 * Returns whether a session was actually deleted.
 */
export async function deleteMemorySession(
  db: Database,
  installationId: number,
  sessionId: number,
): Promise<{ deleted: boolean }> {
  // Step 1: Try scoped delete — session belongs to a repo in this installation
  const result = await db
    .delete(memorySessions)
    .where(
      and(
        eq(memorySessions.id, sessionId),
        inArray(
          memorySessions.project,
          db
            .select({ fullName: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: memorySessions.id });

  if (result.length > 0) {
    return { deleted: true };
  }

  // Step 2: Handle orphaned sessions — the session exists but its project
  // has no matching repository (e.g. the repo was uninstalled). These
  // sessions are visible via GET but impossible to delete with the scoped
  // query above. Allow deletion when no repository owns the project.
  const orphanResult = await db
    .delete(memorySessions)
    .where(
      and(
        eq(memorySessions.id, sessionId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${repositories}
          WHERE ${repositories.fullName} = ${memorySessions.project}
        )`,
      ),
    )
    .returning({ id: memorySessions.id });

  return { deleted: orphanResult.length > 0 };
}

/**
 * Delete all empty memory sessions (sessions with 0 observations).
 * Scoped to installation, with optional project filter.
 * Returns the count of deleted sessions.
 */
/**
 * Delete a single review by ID, scoped to installation.
 * Uses subquery to verify the review's repository belongs to the given installation.
 * Returns true if deleted, false if not found or not authorized.
 */
export async function deleteReviewById(
  db: Database,
  installationId: number,
  reviewId: number,
): Promise<boolean> {
  const result = await db
    .delete(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        inArray(
          reviews.repositoryId,
          db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: reviews.id });

  return result.length > 0;
}

/**
 * Delete multiple reviews by their IDs, scoped to installation.
 * Returns the count of actually deleted rows. No-op if reviewIds is empty.
 */
export async function deleteReviewsByIds(
  db: Database,
  installationId: number,
  reviewIds: number[],
): Promise<number> {
  if (reviewIds.length === 0) return 0;

  const result = await db
    .delete(reviews)
    .where(
      and(
        inArray(reviews.id, reviewIds),
        inArray(
          reviews.repositoryId,
          db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: reviews.id });

  return result.length;
}

/**
 * Delete multiple memory observations by their IDs, scoped to installation.
 * Uses the same installation-scoping pattern as deleteMemoryObservation.
 * Returns the count of actually deleted rows. No-op if observationIds is empty.
 */
export async function deleteMemoryObservationsByIds(
  db: Database,
  installationId: number,
  observationIds: number[],
): Promise<number> {
  if (observationIds.length === 0) return 0;

  const result = await db
    .delete(memoryObservations)
    .where(
      and(
        inArray(memoryObservations.id, observationIds),
        inArray(
          memoryObservations.project,
          db
            .select({ fullName: repositories.fullName })
            .from(repositories)
            .where(eq(repositories.installationId, installationId)),
        ),
      ),
    )
    .returning({ id: memoryObservations.id });

  return result.length;
}

export async function clearEmptyMemorySessions(
  db: Database,
  installationId: number,
  project?: string,
): Promise<{ deletedCount: number }> {
  const conditions: SQL[] = [
    inArray(
      memorySessions.project,
      db
        .select({ fullName: repositories.fullName })
        .from(repositories)
        .where(eq(repositories.installationId, installationId)),
    ),
    sql`NOT EXISTS (
      SELECT 1 FROM ${memoryObservations}
      WHERE ${memoryObservations.sessionId} = ${memorySessions.id}
    )`,
  ];

  if (project) {
    conditions.push(eq(memorySessions.project, project));
  }

  const result = await db
    .delete(memorySessions)
    .where(and(...conditions))
    .returning({ id: memorySessions.id });

  return { deletedCount: result.length };
}
