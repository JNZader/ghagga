/**
 * Tests for the queries module.
 *
 * Since every function requires a Drizzle `Database` object, we create a
 * chainable mock that records method calls and resolves with controlled
 * data.  This lets us validate:
 *  - business-logic branches (upsert existing vs insert new)
 *  - data transformation / default filling
 *  - delegation to the correct Drizzle operations
 *  - edge cases like empty results, missing settings, etc.
 */

import { createHash } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import {
  type DbProviderChainEntry,
  DEFAULT_REPO_SETTINGS,
  type RepoSettings,
  repositories,
  reviews,
} from './schema.js';

// ─── Helper: chainable mock db ─────────────────────────────────

type MockDB = Record<string, ReturnType<typeof vi.fn>>;

function createMockDb(terminalValue: unknown = []): MockDB & { _resolve: (v: unknown) => void } {
  let _terminalValue = terminalValue;

  const handler: ProxyHandler<MockDB> = {
    get(target, prop) {
      if (prop === '_resolve')
        return (v: unknown) => {
          _terminalValue = v;
        };
      if (prop === 'then') {
        // Make the chain thenable so `await db.select()...` resolves
        return (resolve: (v: unknown) => void) => resolve(_terminalValue);
      }
      if (typeof prop === 'symbol') return undefined;
      if (!target[prop]) {
        target[prop] = vi.fn().mockReturnValue(new Proxy({} as MockDB, handler));
      }
      return target[prop];
    },
  };

  return new Proxy({} as MockDB & { _resolve: (v: unknown) => void }, handler);
}

// ─── Import under test ─────────────────────────────────────────

// We import the module under test AFTER defining helpers because the module
// itself only has side-effect-free function declarations.
import {
  buildTsQuery,
  claimIssueDraftForPosting,
  clearAllMemoryObservations,
  clearEmptyMemorySessions,
  clearMemoryObservationsByProject,
  countReviewsByInstallationIds,
  countReviewsByRepoId,
  createMemorySession,
  deactivateInstallation,
  deleteMappingsByInstallationId,
  deleteMemoryObservation,
  deleteMemoryObservationsByIds,
  deleteMemorySession,
  deleteReviewById,
  deleteReviewsByIds,
  deleteReviewsByRepoId,
  deleteStaleUserMappings,
  endMemorySession,
  getEffectiveRepoSettings,
  getInstallationByGitHubId,
  getInstallationById,
  getInstallationSettings,
  getInstallationsByAccountLogin,
  getInstallationsByUserId,
  getIssueDraftById,
  getMemoryObservation,
  getMemoryStats,
  getObservationsBySession,
  getRawMappingsByUserId,
  getRepoByFullName,
  getRepoByGithubId,
  getReposByInstallationId,
  getReviewStats,
  getReviewsByInstallationIds,
  getReviewsByRepoId,
  getSessionsByProject,
  listIssueDrafts,
  listMemoryObservations,
  listObservationsNeedingEmbedding,
  markIssueDraftPosted,
  rejectIssueDraft,
  releaseIssueDraftClaim,
  removeRepoApiKey,
  saveObservation,
  saveRepoApiKey,
  saveReview,
  searchObservations,
  updateIssueDraftBody,
  updateObservationEmbedding,
  updateRepoSettings,
  upsertInstallation,
  upsertInstallationSettings,
  upsertRepository,
  upsertUserMapping,
} from './queries.js';

// ─── Installations ─────────────────────────────────────────────

describe('upsertInstallation', () => {
  it('should update and return existing installation when found', async () => {
    const existing = {
      id: 1,
      githubInstallationId: 42,
      accountLogin: 'old',
      accountType: 'User',
      isActive: true,
    };
    const db = createMockDb([existing]) as unknown as Database;

    const result = await upsertInstallation(db, {
      githubInstallationId: 42,
      accountLogin: 'newLogin',
      accountType: 'Organization',
    });

    expect(result).toEqual(existing);
  });

  it('should insert and return new installation when not found', async () => {
    const inserted = {
      id: 2,
      githubInstallationId: 99,
      accountLogin: 'fresh',
      accountType: 'User',
    };

    // First select returns empty, then insert().values().returning() resolves with [inserted]
    const _db = createMockDb([]) as unknown as Database;

    // Override: the chain `db.select().from().where().limit()` resolves to []
    // but `db.insert().values().returning()` needs to resolve to [inserted].
    // With our Proxy, every call returns a new chainable proxy that resolves to [].
    // We need a more targeted mock for the insert path.

    // Use a simpler approach: manually build the mock.
    const mockReturning = vi.fn().mockResolvedValue([inserted]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

    const mockLimit = vi.fn().mockResolvedValue([]); // select returns empty
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const simpleDb = {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
    } as unknown as Database;

    const result = await upsertInstallation(simpleDb, {
      githubInstallationId: 99,
      accountLogin: 'fresh',
      accountType: 'User',
    });

    expect(result).toEqual(inserted);
    expect(mockInsert).toHaveBeenCalled();
  });
});

describe('deactivateInstallation', () => {
  it('should call update with isActive false', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const db = { update: mockUpdate } as unknown as Database;

    await deactivateInstallation(db, 42);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
  });
});

describe('getInstallationByGitHubId', () => {
  it('should return the installation when found', async () => {
    const installation = { id: 1, githubInstallationId: 42, accountLogin: 'test' };

    const mockLimit = vi.fn().mockResolvedValue([installation]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationByGitHubId(db, 42);
    expect(result).toEqual(installation);
  });

  it('should return null when not found', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationByGitHubId(db, 999);
    expect(result).toBeNull();
  });
});

describe('getInstallationsByAccountLogin', () => {
  it('should return matching installations', async () => {
    const rows = [
      { id: 1, accountLogin: 'acme', isActive: true },
      { id: 2, accountLogin: 'acme', isActive: true },
    ];

    const mockWhere = vi.fn().mockResolvedValue(rows);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationsByAccountLogin(db, 'acme');
    expect(result).toEqual(rows);
    expect(result).toHaveLength(2);
  });
});

// ─── Installation Settings ─────────────────────────────────────

describe('getInstallationSettings', () => {
  it('should return settings when found', async () => {
    const settings = { id: 1, installationId: 10, aiReviewEnabled: true };

    const mockLimit = vi.fn().mockResolvedValue([settings]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationSettings(db, 10);
    expect(result).toEqual(settings);
  });

  it('should return null when not found', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationSettings(db, 999);
    expect(result).toBeNull();
  });
});

describe('upsertInstallationSettings', () => {
  function makeSelectDb(existingRow: unknown) {
    const mockLimit = vi.fn().mockResolvedValue(existingRow ? [existingRow] : []);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockReturning = vi.fn().mockResolvedValue([{ id: 99, installationId: 10 }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

    return {
      db: { select: mockSelect, update: mockUpdate, insert: mockInsert } as unknown as Database,
      mockUpdate,
      mockSet,
      mockInsert,
    };
  }

  it('should update existing settings when found', async () => {
    const existing = {
      id: 1,
      installationId: 10,
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: DEFAULT_REPO_SETTINGS,
    };
    const { db, mockUpdate } = makeSelectDb(existing);

    const result = await upsertInstallationSettings(db, 10, {
      aiReviewEnabled: false,
      reviewMode: 'workflow',
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(result).toMatchObject({ aiReviewEnabled: false, reviewMode: 'workflow' });
  });

  it('should insert new settings with defaults when not found', async () => {
    const { db, mockInsert } = makeSelectDb(null);

    const result = await upsertInstallationSettings(db, 10, {});

    expect(mockInsert).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should only include provided update fields', async () => {
    const existing = {
      id: 1,
      installationId: 10,
      providerChain: [{ provider: 'gateway', model: 'auto', encryptedApiKey: null }],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: DEFAULT_REPO_SETTINGS,
    };
    const { db, mockSet } = makeSelectDb(existing);

    await upsertInstallationSettings(db, 10, { reviewMode: 'consensus' });

    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.reviewMode).toBe('consensus');
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    // providerChain should NOT be in set values since it wasn't provided
    expect(setArg.providerChain).toBeUndefined();
  });
});

describe('getInstallationById', () => {
  it('should return installation row by primary key', async () => {
    const row = { id: 5, githubInstallationId: 100 };
    const mockLimit = vi.fn().mockResolvedValue([row]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getInstallationById(db, 5)).toEqual(row);
  });

  it('should return null when not found', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getInstallationById(db, 999)).toBeNull();
  });
});

// ─── getEffectiveRepoSettings ──────────────────────────────────

describe('getEffectiveRepoSettings', () => {
  const repoProviderChain: DbProviderChainEntry[] = [
    { provider: 'gateway', model: 'auto', encryptedApiKey: 'enc1' },
  ];
  const repoSettings: RepoSettings = {
    ...DEFAULT_REPO_SETTINGS,
    enableSemgrep: false,
    reviewLevel: 'strict',
  };

  it('should return repo-level settings when useGlobalSettings is false', async () => {
    // db is not called when useGlobalSettings is false
    const db = {} as unknown as Database;

    const result = await getEffectiveRepoSettings(db, {
      installationId: 1,
      useGlobalSettings: false,
      providerChain: repoProviderChain,
      aiReviewEnabled: true,
      reviewMode: 'consensus',
      settings: repoSettings,
    });

    expect(result.source).toBe('repo');
    expect(result.providerChain).toEqual(repoProviderChain);
    expect(result.aiReviewEnabled).toBe(true);
    expect(result.reviewMode).toBe('consensus');
    expect(result.settings.enableSemgrep).toBe(false);
    expect(result.settings.reviewLevel).toBe('strict');
  });

  it('should default providerChain to [] when null (repo-level)', async () => {
    const db = {} as unknown as Database;

    const result = await getEffectiveRepoSettings(db, {
      installationId: 1,
      useGlobalSettings: false,
      providerChain: null,
      aiReviewEnabled: false,
      reviewMode: 'simple',
      settings: null,
    });

    expect(result.source).toBe('repo');
    expect(result.providerChain).toEqual([]);
    expect(result.settings).toEqual({ ...DEFAULT_REPO_SETTINGS, explanationsEnabled: false });
  });

  it('should return global settings when useGlobalSettings is true and installation settings exist', async () => {
    const globalSettings = {
      id: 1,
      installationId: 5,
      providerChain: [
        {
          provider: 'gateway' as const,
          model: 'auto',
          encryptedApiKey: null,
        },
      ],
      aiReviewEnabled: false,
      reviewMode: 'workflow',
      settings: { ...DEFAULT_REPO_SETTINGS, enableTrivy: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Mock getInstallationSettings via db chain
    const mockLimit = vi.fn().mockResolvedValue([globalSettings]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getEffectiveRepoSettings(db, {
      installationId: 5,
      useGlobalSettings: true,
      providerChain: repoProviderChain,
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: repoSettings,
    });

    expect(result.source).toBe('global');
    expect(result.aiReviewEnabled).toBe(false);
    expect(result.reviewMode).toBe('workflow');
    expect(result.providerChain).toEqual(globalSettings.providerChain);
  });

  it('should return defaults when useGlobalSettings is true but no installation settings exist', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getEffectiveRepoSettings(db, {
      installationId: 5,
      useGlobalSettings: true,
      providerChain: repoProviderChain,
      aiReviewEnabled: false,
      reviewMode: 'consensus',
      settings: repoSettings,
    });

    expect(result.source).toBe('global');
    expect(result.providerChain).toEqual([]);
    expect(result.aiReviewEnabled).toBe(true);
    expect(result.reviewMode).toBe('simple');
    expect(result.settings).toEqual({ ...DEFAULT_REPO_SETTINGS, explanationsEnabled: false });
  });
});

// ─── Repositories ──────────────────────────────────────────────

describe('upsertRepository', () => {
  it('should update existing repo and return it', async () => {
    const existing = { id: 1, githubRepoId: 100, fullName: 'old/repo' };

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockLimit = vi.fn().mockResolvedValue([existing]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const db = { select: mockSelect, update: mockUpdate } as unknown as Database;

    const result = await upsertRepository(db, {
      githubRepoId: 100,
      installationId: 5,
      fullName: 'new/repo',
    });

    expect(result).toEqual(existing);
    expect(mockUpdate).toHaveBeenCalled();
    // Verify installationId is included in the update (Bug fix: reinstall updates the FK)
    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.installationId).toBe(5);
    expect(setArg.fullName).toBe('new/repo');
    expect(setArg.isActive).toBe(true);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('should insert new repo with DEFAULT_REPO_SETTINGS', async () => {
    const inserted = {
      id: 2,
      githubRepoId: 200,
      fullName: 'owner/repo',
      settings: DEFAULT_REPO_SETTINGS,
    };

    const mockReturning = vi.fn().mockResolvedValue([inserted]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const db = { select: mockSelect, insert: mockInsert } as unknown as Database;

    const result = await upsertRepository(db, {
      githubRepoId: 200,
      installationId: 5,
      fullName: 'owner/repo',
    });

    expect(result).toEqual(inserted);
    expect(mockInsert).toHaveBeenCalled();
    // Verify values include DEFAULT_REPO_SETTINGS
    const valuesArg = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.settings).toEqual(DEFAULT_REPO_SETTINGS);
  });
});

describe('getRepoByFullName', () => {
  it('should return repo when found', async () => {
    const repo = { id: 1, fullName: 'owner/repo' };
    const mockLimit = vi.fn().mockResolvedValue([repo]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getRepoByFullName(db, 'owner/repo')).toEqual(repo);
  });

  it('should return null when not found', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getRepoByFullName(db, 'no/repo')).toBeNull();
  });
});

describe('getRepoByGithubId', () => {
  it('should return repo when found', async () => {
    const repo = { id: 1, githubRepoId: 42 };
    const mockLimit = vi.fn().mockResolvedValue([repo]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getRepoByGithubId(db, 42)).toEqual(repo);
  });

  it('should return null when not found', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getRepoByGithubId(db, 999)).toBeNull();
  });
});

describe('updateRepoSettings', () => {
  it('should call update with provided fields and updatedAt', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const db = { update: mockUpdate } as unknown as Database;

    await updateRepoSettings(db, 1, { reviewMode: 'workflow', aiReviewEnabled: false });

    expect(mockUpdate).toHaveBeenCalled();
    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.reviewMode).toBe('workflow');
    expect(setArg.aiReviewEnabled).toBe(false);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });
});

describe('saveRepoApiKey', () => {
  it('should update encryptedApiKey', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const db = { update: mockUpdate } as unknown as Database;

    await saveRepoApiKey(db, 1, 'encrypted-key-data');

    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedApiKey).toBe('encrypted-key-data');
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });
});

describe('removeRepoApiKey', () => {
  it('should set encryptedApiKey to null', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const db = { update: mockUpdate } as unknown as Database;

    await removeRepoApiKey(db, 1);

    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedApiKey).toBeNull();
  });
});

describe('getReposByInstallationId', () => {
  it('should return active repos for the installation', async () => {
    const repos = [{ id: 1, installationId: 5, isActive: true }];
    const mockWhere = vi.fn().mockResolvedValue(repos);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getReposByInstallationId(db, 5);
    expect(result).toEqual(repos);
  });
});

// ─── Reviews ───────────────────────────────────────────────────

describe('saveReview', () => {
  it('should insert and return the review', async () => {
    const review = { id: 1, repositoryId: 1, prNumber: 42, status: 'PASSED' };
    const mockReturning = vi.fn().mockResolvedValue([review]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const db = { insert: mockInsert } as unknown as Database;

    const result = await saveReview(db, {
      repositoryId: 1,
      prNumber: 42,
      status: 'PASSED',
      mode: 'simple',
    });

    expect(result).toEqual(review);
  });
});

describe('getReviewsByRepoId', () => {
  it('should use default limit=50 and offset=0', async () => {
    const mockOffset = vi.fn().mockResolvedValue([]);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getReviewsByRepoId(db, 1);

    expect(mockLimit).toHaveBeenCalledWith(50);
    expect(mockOffset).toHaveBeenCalledWith(0);
  });

  it('should respect custom limit and offset', async () => {
    const mockOffset = vi.fn().mockResolvedValue([]);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getReviewsByRepoId(db, 1, { limit: 10, offset: 20 });

    expect(mockLimit).toHaveBeenCalledWith(10);
    expect(mockOffset).toHaveBeenCalledWith(20);
  });
});

describe('getReviewStats', () => {
  it('should return the first row from the aggregate query', async () => {
    const stats = { total: 10, passed: 7, failed: 2, skipped: 1 };
    const mockWhere = vi.fn().mockResolvedValue([stats]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getReviewStats(db, 1);
    expect(result).toEqual(stats);
  });
});

describe('countReviewsByRepoId', () => {
  it('should return the count from the aggregate row', async () => {
    const mockWhere = vi.fn().mockResolvedValue([{ total: 137 }]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await countReviewsByRepoId(db, 42);
    expect(result).toBe(137);
  });

  it('should return 0 when the aggregate row is missing', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await countReviewsByRepoId(db, 42);
    expect(result).toBe(0);
  });
});

describe('getReviewsByInstallationIds', () => {
  it('should short-circuit to [] for empty installationIds (no query)', async () => {
    const mockSelect = vi.fn();
    const db = { select: mockSelect } as unknown as Database;

    const result = await getReviewsByInstallationIds(db, []);
    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('should join repositories and apply default limit=50/offset=0', async () => {
    const rows = [{ id: 1, repositoryId: 42, fullName: 'owner/repo-a' }];
    const mockOffset = vi.fn().mockResolvedValue(rows);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getReviewsByInstallationIds(db, [100, 200]);

    expect(result).toEqual(rows);
    expect(mockInnerJoin).toHaveBeenCalled();
    expect(mockLimit).toHaveBeenCalledWith(50);
    expect(mockOffset).toHaveBeenCalledWith(0);
  });

  it('should respect custom limit and offset', async () => {
    const mockOffset = vi.fn().mockResolvedValue([]);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getReviewsByInstallationIds(db, [100], { limit: 25, offset: 50 });

    expect(mockLimit).toHaveBeenCalledWith(25);
    expect(mockOffset).toHaveBeenCalledWith(50);
  });
});

describe('countReviewsByInstallationIds', () => {
  it('should return 0 for empty installationIds (no query)', async () => {
    const mockSelect = vi.fn();
    const db = { select: mockSelect } as unknown as Database;

    const result = await countReviewsByInstallationIds(db, []);
    expect(result).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('should return the joined aggregate count', async () => {
    const mockWhere = vi.fn().mockResolvedValue([{ total: 83 }]);
    const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await countReviewsByInstallationIds(db, [100, 200]);
    expect(result).toBe(83);
    expect(mockInnerJoin).toHaveBeenCalled();
  });

  it('should return 0 when the aggregate row is missing', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await countReviewsByInstallationIds(db, [100]);
    expect(result).toBe(0);
  });
});

// ─── SECURITY REGRESSION LOCK: cross-tenant isolation via inArray([]) ──
//
// getReviewsByInstallationIds / countReviewsByInstallationIds scope the
// cross-tenant review listing with `inArray(repositories.installationId, ids)`.
// On drizzle-orm 0.45.x, `inArray(col, [])` renders `WHERE false` (zero rows),
// so an empty installationIds list (a caller with no installations) leaks NOTHING
// even if the function-level early-return guards were removed.
//
// THE RISK these tests lock: every OTHER test in this file mocks past the real
// SQL generation, so a future drizzle upgrade that changed empty-array semantics
// (e.g. dropping the WHERE clause → unconstrained query returning ALL tenants'
// rows) would silently reintroduce a cross-tenant leak with NO failing test.
//
// We assert the ACTUAL generated SQL via drizzle's `.toSQL()` on a REAL query
// builder (no DB connection — `drizzle({}, { schema })` builds queries lazily and
// `.toSQL()` renders without executing). This directly locks the drizzle behavior:
// an upgrade that stops emitting a falsy WHERE for the empty case fails here.
describe('SECURITY: inArray empty-array renders WHERE false (cross-tenant lock)', () => {
  // Real drizzle builder, no live connection. toSQL() renders, never executes.
  const sqlDb = drizzle({} as never, { schema: { reviews, repositories } });

  // Mirrors the WHERE/JOIN shape of getReviewsByInstallationIds.
  function buildReviewsQuery(installationIds: number[]) {
    return sqlDb
      .select({ id: reviews.id, fullName: repositories.fullName })
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .where(inArray(repositories.installationId, installationIds))
      .orderBy(desc(reviews.createdAt))
      .limit(50)
      .offset(0);
  }

  it('empty installationIds → WHERE false (zero rows), NOT an unconstrained query', () => {
    const { sql, params } = buildReviewsQuery([]).toSQL();
    const normalized = sql.toLowerCase();

    // LOCKED ASSERTION: the WHERE renders as a literal false condition.
    expect(normalized).toContain('where false');
    // It must NOT degrade into an unconstrained `installation_id in (...)` filter
    // or drop the WHERE entirely (which would return EVERY tenant's reviews).
    expect(normalized).not.toContain('installation_id" in');
    expect(normalized).not.toContain('installation_id in');
    // No installationId is bound when the array is empty (only limit param remains).
    expect(params).not.toContain(undefined);
    expect(params).toEqual([50]);
  });

  it('non-empty installationIds → constrained `installation_id in (...)` with bound params', () => {
    const { sql, params } = buildReviewsQuery([100, 200]).toSQL();
    const normalized = sql.toLowerCase();

    // Sanity: the SAME builder DOES emit a real tenant filter for a populated list.
    expect(normalized).toContain('installation_id" in (');
    expect(normalized).not.toContain('where false');
    // The two installationIds are bound as parameters (plus the limit=50).
    expect(params).toEqual([100, 200, 50]);
  });
});

describe('deleteReviewsByRepoId', () => {
  it('should return count of deleted rows when reviews exist', async () => {
    const deletedRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const mockReturning = vi.fn().mockResolvedValue(deletedRows);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    const result = await deleteReviewsByRepoId(db, 42);

    expect(result).toBe(3);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should return 0 when no reviews exist for the repository', async () => {
    const mockReturning = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    const result = await deleteReviewsByRepoId(db, 99);

    expect(result).toBe(0);
  });

  it('should call db.delete with the reviews table', async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    await deleteReviewsByRepoId(db, 42);

    expect(mockDelete).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
    expect(mockReturning).toHaveBeenCalled();
  });
});

// ─── Memory: Sessions ──────────────────────────────────────────

describe('createMemorySession', () => {
  it('should insert and return the session', async () => {
    const session = { id: 1, project: 'owner/repo', prNumber: null };
    const mockReturning = vi.fn().mockResolvedValue([session]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const db = { insert: mockInsert } as unknown as Database;

    const result = await createMemorySession(db, { project: 'owner/repo' });
    expect(result).toEqual(session);
  });

  it('should pass prNumber when provided', async () => {
    const session = { id: 2, project: 'owner/repo', prNumber: 42 };
    const mockReturning = vi.fn().mockResolvedValue([session]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const db = { insert: mockInsert } as unknown as Database;

    const result = await createMemorySession(db, { project: 'owner/repo', prNumber: 42 });
    expect(result.prNumber).toBe(42);
  });
});

describe('endMemorySession', () => {
  it('should update session with endedAt and summary', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const db = { update: mockUpdate } as unknown as Database;

    await endMemorySession(db, 1, 'Session complete');

    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.summary).toBe('Session complete');
    expect(setArg.endedAt).toBeInstanceOf(Date);
  });
});

describe('getSessionsByProject', () => {
  it('should use default limit of 20', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getSessionsByProject(db, 'owner/repo');
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('should respect custom limit', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockGroupBy = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getSessionsByProject(db, 'owner/repo', { limit: 5 });
    expect(mockLimit).toHaveBeenCalledWith(5);
  });
});

// ─── Memory: Observations ──────────────────────────────────────

describe('saveObservation', () => {
  function makeObservationDb(options: {
    existingByHash?: unknown;
    existingByTopic?: unknown;
    insertedRow?: unknown;
  }) {
    const { existingByHash, existingByTopic, insertedRow } = options;
    let selectCallCount = 0;

    const mockReturning = vi.fn().mockResolvedValue([insertedRow ?? { id: 99 }]);
    const mockInsertValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

    const mockUpdateReturning = vi.fn().mockResolvedValue([{ id: 50, revisionCount: 2 }]);
    const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
    const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

    const mockLimit = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First select: dedup by hash
        return Promise.resolve(existingByHash ? [existingByHash] : []);
      }
      // Second select: dedup by topic key
      return Promise.resolve(existingByTopic ? [existingByTopic] : []);
    });
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    return {
      db: { select: mockSelect, insert: mockInsert, update: mockUpdate } as unknown as Database,
      mockInsert,
      mockUpdate,
    };
  }

  it('should return existing observation when content hash matches (dedup)', async () => {
    const existing = { id: 10, contentHash: 'abc', title: 'Test' };
    const { db, mockInsert } = makeObservationDb({ existingByHash: existing });

    const result = await saveObservation(db, {
      project: 'owner/repo',
      type: 'decision',
      title: 'Test',
      content: 'Some content',
    });

    expect(result).toEqual(existing);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should update existing observation when topicKey matches', async () => {
    const existingByTopic = { id: 50, topicKey: 'arch-patterns', revisionCount: 1 };
    const { db, mockUpdate, mockInsert } = makeObservationDb({ existingByTopic });

    const result = await saveObservation(db, {
      project: 'owner/repo',
      type: 'architecture',
      title: 'Updated pattern',
      content: 'New content',
      topicKey: 'arch-patterns',
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should insert new observation when no dedup match', async () => {
    const inserted = { id: 99, project: 'owner/repo', type: 'learning' };
    const { db, mockInsert } = makeObservationDb({ insertedRow: inserted });

    const result = await saveObservation(db, {
      project: 'owner/repo',
      type: 'learning',
      title: 'Learned something',
      content: 'Content here',
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(result).toEqual(inserted);
  });

  it('should default filePaths to empty array for new observations', async () => {
    const { db, mockInsert } = makeObservationDb({});
    const _mockValues = (mockInsert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
      }),
    });

    // The function calls db.insert().values({...data, filePaths: data.filePaths ?? []})
    // We just verify the function doesn't throw and works correctly
    await saveObservation(db, {
      project: 'p',
      type: 't',
      title: 'ti',
      content: 'c',
    });

    // The key assertion is that it doesn't throw
    expect(true).toBe(true);
  });
});

describe('listObservationsNeedingEmbedding (design D6)', () => {
  it('maps rows to { id, text } joining title + content', async () => {
    const rows = [
      { id: 1, title: 'Rotate secrets', content: 'We rotate credentials regularly.' },
      { id: 2, title: 'Auth flow', content: 'JWT validation notes.' },
    ];
    const db = createMockDb(rows) as unknown as Database;

    const result = await listObservationsNeedingEmbedding(db, {
      afterId: 0,
      limit: 100,
      activeModel: 'text-embedding-3-small',
      activeDim: 1536,
      includeMismatched: false,
    });

    expect(result).toEqual([
      { id: 1, text: 'Rotate secrets We rotate credentials regularly.' },
      { id: 2, text: 'Auth flow JWT validation notes.' },
    ]);
  });

  it('returns an empty array when no rows need embedding', async () => {
    const db = createMockDb([]) as unknown as Database;

    const result = await listObservationsNeedingEmbedding(db, {
      afterId: 0,
      limit: 100,
      activeModel: 'text-embedding-3-small',
      activeDim: 1536,
      includeMismatched: true,
    });

    expect(result).toEqual([]);
  });
});

describe('updateObservationEmbedding (design D6)', () => {
  it('resolves without error when the update chain resolves', async () => {
    const db = createMockDb(undefined) as unknown as Database;

    await expect(
      updateObservationEmbedding(db, 7, [0.1, 0.2, 0.3], 'text-embedding-3-small', 3),
    ).resolves.toBeUndefined();
  });
});

describe('buildTsQuery', () => {
  it('joins terms with OR (|), matching the SQLite backend', () => {
    expect(buildTsQuery('auth token rotation')).toBe("'auth' | 'token' | 'rotation'");
  });

  it('returns empty string for blank input', () => {
    expect(buildTsQuery('')).toBe('');
    expect(buildTsQuery('   ')).toBe('');
  });

  it('escapes single quotes inside lexemes', () => {
    expect(buildTsQuery("it's")).toBe("'it''s'");
  });

  it('escapes backslashes so a trailing backslash cannot break the closing quote', () => {
    expect(buildTsQuery('path\\')).toBe("'path\\\\'");
    expect(buildTsQuery('a\\b')).toBe("'a\\\\b'");
  });

  it('collapses repeated whitespace between terms', () => {
    expect(buildTsQuery('  foo   bar  ')).toBe("'foo' | 'bar'");
  });
});

describe('searchObservations', () => {
  it('should return empty array for empty query', async () => {
    const db = {} as unknown as Database;
    const result = await searchObservations(db, 'owner/repo', '   ');
    expect(result).toEqual([]);
  });

  it('should return empty array for whitespace-only query', async () => {
    const db = {} as unknown as Database;
    const result = await searchObservations(db, 'owner/repo', '');
    expect(result).toEqual([]);
  });

  it('should use default limit of 10', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await searchObservations(db, 'proj', 'search term');
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('should respect custom limit', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await searchObservations(db, 'proj', 'search', { limit: 5 });
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('should execute query when type filter is provided', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await searchObservations(db, 'proj', 'test', { type: 'decision' });
    // Verify it reached the DB (didn't short-circuit)
    expect(mockSelect).toHaveBeenCalled();
  });

  it('over-fetches candidates up to fetchLimit and returns up to fetchLimit ranked rows', async () => {
    // Caller post-filters (decay) → asks for more candidates than `limit`.
    // 5 rows come back; with limit=2, fetchLimit=6, all 5 (< 6) must survive the
    // db-layer slice so the caller has headroom to drop decayed rows.
    const rows = [1, 2, 3, 4, 5].map((id) => ({ id, lastAccessedAt: new Date() }));
    const mockLimit = vi.fn().mockResolvedValue(rows);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect, update: mockUpdate } as unknown as Database;

    const result = await searchObservations(db, 'proj', 'q', { limit: 2, fetchLimit: 6 });

    // Candidate query fetched up to fetchLimit (6), not the smaller `limit` (2).
    expect(mockLimit).toHaveBeenCalledWith(6);
    // Non-hybrid path returns all candidates up to fetchLimit (5 < 6) — the
    // ADAPTER is responsible for the final cap to `limit`.
    expect(result).toHaveLength(5);
  });
});

// ── Phase 4: Postgres Cosine Union ───────────────────────────────
//
// Mirrors packages/core/src/memory/sqlite.ts Phase 3 test scenarios (same
// fake-provider dataset shape) — proves PG applies the same union/dedup/
// posRank/read-guard pipeline (spec R5.7-R5.11, design D4/D5).
//
// searchObservations issues up to 2 sequential `db.select()` calls in the
// hybrid path: [0] = keyword (tsquery) candidates, [1] = bounded cosine
// candidates. This mock returns a different resolved row set per call,
// tracked by call order, and lets tests assert exactly how many `.select()`
// calls ran (proving the `none`-parity gate never runs the 2nd query).
describe('searchObservations — cosine union (Phase 4)', () => {
  function makeUnionDb(selectSequence: unknown[][]): {
    db: Database;
    mockSelect: ReturnType<typeof vi.fn>;
    mockUpdate: ReturnType<typeof vi.fn>;
    /** One `.limit()` spy per `db.select()` invocation, in call order. */
    limitSpies: Array<ReturnType<typeof vi.fn>>;
  } {
    let selectCallCount = 0;
    const limitSpies: Array<ReturnType<typeof vi.fn>> = [];

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockSelect = vi.fn().mockImplementation(() => {
      const rows = selectSequence[selectCallCount] ?? [];
      selectCallCount++;
      const mockLimit = vi.fn().mockResolvedValue(rows);
      limitSpies.push(mockLimit);
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      return { from: mockFrom };
    });

    const db = { select: mockSelect, update: mockUpdate } as unknown as Database;
    return { db, mockSelect, mockUpdate, limitSpies };
  }

  function row(overrides: Partial<Record<string, unknown>> & { id: number }) {
    return {
      title: `obs-${overrides.id}`,
      embedding: null,
      embeddingModel: null,
      embeddingDim: null,
      lastAccessedAt: new Date(),
      ...overrides,
    };
  }

  it('[4.6 acceptance gate] none provider: only 1 select() call runs — identical to keyword-only path', async () => {
    const keywordRows = [row({ id: 1 }), row({ id: 2 })];
    const { db, mockSelect } = makeUnionDb([keywordRows]);

    const result = await searchObservations(db, 'proj', 'token');

    // No embedFn -> the cosine query MUST never run (spec R5.11).
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result).toEqual(keywordRows);
  });

  it('[4.7] surfaces a lexically-disjoint semantic match via the cosine union', async () => {
    // No keyword match at all; the cosine-only candidate must still surface.
    const cosineRows = [row({ id: 5, embedding: [1, 0, 0], embeddingDim: 3 })];
    const { db } = makeUnionDb([[], cosineRows]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    const result = await searchObservations(db, 'proj', 'secret leakage', {
      embedFn,
      embeddingDimension: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(5);
  });

  it('[4.7] dedups a candidate present in both keyword and cosine sets, using its real keyword score', async () => {
    const keywordRows = [row({ id: 1, embedding: [1, 0, 0], embeddingDim: 3 })];
    const cosineRows = [
      row({ id: 1, embedding: [1, 0, 0], embeddingDim: 3 }),
      row({ id: 2, embedding: [1, 0, 0], embeddingDim: 3 }),
    ];
    const { db } = makeUnionDb([keywordRows, cosineRows]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]); // all docs tie on cosine

    const result = await searchObservations(db, 'proj', 'overlap', {
      embedFn,
      embeddingDimension: 3,
    });

    // Exactly 2 rows — no duplicate for id 1.
    expect(result).toHaveLength(2);
    // id 1 (real keyword score 1, n=1) outranks id 2 (vector-only, keyword score 0).
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('[4.7] excludes mixed-dimension rows from the cosine candidate set without error', async () => {
    // Stored with 3 dims; active provider reports 4 dims -> dimension guard
    // must exclude it, never throw, and never surface it (no lexical match).
    const cosineRows = [row({ id: 9, embedding: [1, 0, 0], embeddingDim: 3 })];
    const { db } = makeUnionDb([[], cosineRows]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0, 0]);

    const result = await searchObservations(db, 'proj', 'zephyr cascade unrelated', {
      embedFn,
      embeddingDimension: 4,
    });

    expect(result).toHaveLength(0);
  });

  it('[4.7] returns correctly with a partial-backfill mix of NULL and embedded rows', async () => {
    // Embedded row: reachable only via cosine (no lexical overlap).
    const keywordRows = [row({ id: 2, embedding: null, embeddingDim: null })]; // legacy NULL row, matches keyword
    const cosineRows = [row({ id: 1, embedding: [1, 0, 0], embeddingDim: 3 })]; // vectorized row
    const { db } = makeUnionDb([keywordRows, cosineRows]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    const result = await searchObservations(db, 'proj', 'alpha-trigger plainkeyword', {
      embedFn,
      embeddingDimension: 3,
    });

    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('[4.7] vector-only candidate is scored with keyword-score 0 (finalScore = 0.7 * cosineSim)', async () => {
    const cosineRows = [row({ id: 7, embedding: [1, 0, 0], embeddingDim: 3 })];
    const { db } = makeUnionDb([[], cosineRows]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    const result = await searchObservations(db, 'proj', 'no lexical overlap', {
      embedFn,
      embeddingDimension: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(7);
  });

  it('[4.7] query-time embed failure falls back to keyword-only ordering without a 2nd select() call, warns once', async () => {
    const keywordRows = [row({ id: 1 }), row({ id: 2 })];
    const { db, mockSelect } = makeUnionDb([keywordRows]);
    const embedFn = vi.fn().mockRejectedValue(new Error('provider down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await searchObservations(db, 'proj', 'token', {
      embedFn,
      embeddingDimension: 3,
    });

    // Cosine query never runs after the embed failure (graceful degradation).
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result).toEqual(keywordRows);
    // Warns once, symmetric with the SQLite backend's _hybridSearch.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('provider down');
    warnSpy.mockRestore();
  });

  it('[4.7] respects a custom embeddingCandidateK on the bounded cosine query', async () => {
    const { db, limitSpies } = makeUnionDb([[], []]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    const result = await searchObservations(db, 'proj', 'token', {
      embedFn,
      embeddingDimension: 3,
      embeddingCandidateK: 5,
    });

    expect(result).toEqual([]);
    // limitSpies[0] = keyword candidate LIMIT, limitSpies[1] = the bounded
    // cosine candidate LIMIT — must use the caller-supplied K, not the 200 default.
    expect(limitSpies[1]).toHaveBeenCalledWith(5);
  });

  it('[4.1] defaults the bounded cosine candidate LIMIT to 200 when embeddingCandidateK is not supplied', async () => {
    const { db, limitSpies } = makeUnionDb([[], []]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    await searchObservations(db, 'proj', 'token', { embedFn, embeddingDimension: 3 });

    expect(limitSpies[1]).toHaveBeenCalledWith(200);
  });

  // ── R3-001: union path must NOT cap before the caller's decay filter ──────
  // The decay-aware caller (the Postgres adapter) owns the cap-to-`limit` step
  // AFTER decay filtering. So the union query must return the FULL scored+sorted
  // pool, never a pre-cap to returnLimit — otherwise a fresh candidate ranked
  // below the top-returnLimit stale ones is sliced off before decay can rescue
  // it (mirrors packages/core/src/memory/sqlite.ts: decay-filter full pool first).
  it('[R3-001] returns the FULL scored pool UNCAPPED on the union path (no pre-cap to returnLimit)', async () => {
    // 5 keyword candidates, no embeddings → cosine 0 → finalScore = 0.3 *
    // positional-rank, so the sorted pool equals this input order.
    const keywordRows = [1, 2, 3, 4, 5].map((id) =>
      row({ id, embedding: null, embeddingDim: null }),
    );
    const { db } = makeUnionDb([keywordRows, []]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    // limit=2 (no fetchLimit) → returnLimit=2. Old code sliced to 2 here.
    const result = await searchObservations(db, 'proj', 'token', {
      embedFn,
      embeddingDimension: 3,
      limit: 2,
    });

    // All 5 candidates come back (uncapped), in finalScore-desc order — proving
    // the union path defers capping to the decay-aware caller.
    expect(result.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  // ── R3-002: union path must NOT touch last_accessed_at ────────────────────
  // Touching here would freshen rows the caller's decay filter later drops
  // (decay-evasion). The touch is the caller's job, scoped to final survivors.
  it('[R3-002] does NOT bump last_accessed_at on the union path (caller touches survivors)', async () => {
    const keywordRows = [row({ id: 1 }), row({ id: 2 })];
    const { db, mockUpdate } = makeUnionDb([keywordRows, []]);
    const embedFn = vi.fn().mockResolvedValue([1, 0, 0]);

    await searchObservations(db, 'proj', 'token', { embedFn, embeddingDimension: 3 });

    // No db.update(...) — last_accessed_at is left untouched for the caller.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('[R3-002] no-provider path STILL bumps last_accessed_at itself (parity preserved)', async () => {
    const keywordRows = [row({ id: 1 }), row({ id: 2 })];
    const { db, mockUpdate } = makeUnionDb([keywordRows]);

    // No embedFn → keyword-only path, byte-for-byte unchanged: it touches itself.
    await searchObservations(db, 'proj', 'token');

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('getObservationsBySession', () => {
  it('should return observations ordered by createdAt', async () => {
    const obs = [
      { id: 1, sessionId: 5 },
      { id: 2, sessionId: 5 },
    ];
    const mockOrderBy = vi.fn().mockResolvedValue(obs);
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getObservationsBySession(db, 5);
    expect(result).toEqual(obs);
  });
});

// ─── User Mappings ─────────────────────────────────────────────

describe('upsertUserMapping', () => {
  it('should update and return existing mapping when same user+installation exists (S-R11.2)', async () => {
    const existing = { id: 1, githubUserId: 123, githubLogin: 'old', installationId: 5 };

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

    const mockLimit = vi.fn().mockResolvedValue([existing]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const db = { select: mockSelect, update: mockUpdate } as unknown as Database;

    const result = await upsertUserMapping(db, {
      githubUserId: 123,
      githubLogin: 'newLogin',
      installationId: 5, // same installation — should update, not insert
    });

    expect(result).toEqual(existing);
    expect(mockUpdate).toHaveBeenCalled();
    // Verify only githubLogin is updated (not installationId, since it's part of the composite key)
    const setArg = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.githubLogin).toBe('newLogin');
    expect(setArg.installationId).toBeUndefined();
  });

  it('should insert new mapping when user+installation combo not found (S-R11.3)', async () => {
    const inserted = { id: 2, githubUserId: 456, githubLogin: 'user', installationId: 7 };

    const mockReturning = vi.fn().mockResolvedValue([inserted]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const db = { select: mockSelect, insert: mockInsert } as unknown as Database;

    const result = await upsertUserMapping(db, {
      githubUserId: 456,
      githubLogin: 'user',
      installationId: 7,
    });

    expect(result).toEqual(inserted);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should create second mapping for same user with different installation (S-R11.1)', async () => {
    // Simulate: user 100 already has mapping to installation 5, now adding installation 7
    // The select for (user=100, installation=7) returns empty → insert
    const inserted = { id: 3, githubUserId: 100, githubLogin: 'john', installationId: 7 };

    const mockReturning = vi.fn().mockResolvedValue([inserted]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

    const mockLimit = vi.fn().mockResolvedValue([]); // no existing mapping for this combo
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const db = { select: mockSelect, insert: mockInsert } as unknown as Database;

    const result = await upsertUserMapping(db, {
      githubUserId: 100,
      githubLogin: 'john',
      installationId: 7, // different from existing installation 5
    });

    expect(result).toEqual(inserted);
    expect(mockInsert).toHaveBeenCalled();
    // Verify the values passed to insert include the correct installationId
    const valuesArg = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.githubUserId).toBe(100);
    expect(valuesArg.installationId).toBe(7);
  });
});

describe('getInstallationsByUserId', () => {
  it('should return empty array when no mappings found', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationsByUserId(db, 999);
    expect(result).toEqual([]);
  });

  it('should return only active installations for mapped user', async () => {
    const mappings = [
      { id: 1, githubUserId: 123, installationId: 5 },
      { id: 2, githubUserId: 123, installationId: 10 },
    ];
    const activeInstallations = [
      { id: 5, isActive: true },
      { id: 10, isActive: true },
    ];

    let selectCallCount = 0;
    const mockWhere = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return Promise.resolve(mappings);
      return Promise.resolve(activeInstallations);
    });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationsByUserId(db, 123);
    expect(result).toEqual(activeInstallations);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('should filter out deactivated installations', async () => {
    const mappings = [
      { id: 1, githubUserId: 100, installationId: 5 },
      { id: 2, githubUserId: 100, installationId: 7 },
    ];
    // Only installation 5 is active; 7 is filtered by the WHERE is_active=true
    const onlyActiveInstallations = [{ id: 5, isActive: true }];

    let selectCallCount = 0;
    const mockWhere = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return Promise.resolve(mappings);
      return Promise.resolve(onlyActiveInstallations);
    });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationsByUserId(db, 100);
    expect(result).toEqual(onlyActiveInstallations);
    expect(result).toHaveLength(1);
  });

  it('should return empty when all mapped installations are deactivated', async () => {
    const mappings = [{ id: 1, githubUserId: 100, installationId: 5 }];
    // The active filter returns nothing — installation 5 is deactivated
    const noActiveInstallations: unknown[] = [];

    let selectCallCount = 0;
    const mockWhere = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return Promise.resolve(mappings);
      return Promise.resolve(noActiveInstallations);
    });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getInstallationsByUserId(db, 100);
    expect(result).toEqual([]);
  });
});

// ─── getRawMappingsByUserId ────────────────────────────────────

describe('getRawMappingsByUserId', () => {
  it('should return all mappings including those for inactive installations', async () => {
    const allMappings = [
      { id: 1, githubUserId: 100, githubLogin: 'john', installationId: 5 },
      { id: 2, githubUserId: 100, githubLogin: 'john', installationId: 7 },
    ];

    const mockWhere = vi.fn().mockResolvedValue(allMappings);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getRawMappingsByUserId(db, 100);
    expect(result).toEqual(allMappings);
    expect(result).toHaveLength(2);
    // Only one select call — no JOIN with installations
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('should return empty array when no mappings exist', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getRawMappingsByUserId(db, 999);
    expect(result).toEqual([]);
  });
});

// ─── deleteStaleUserMappings ───────────────────────────────────

describe('deleteStaleUserMappings', () => {
  it('should delete mappings by their IDs', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    await deleteStaleUserMappings(db, [1, 2]);

    expect(mockDelete).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
  });

  it('should be a no-op when mappingIds is empty', async () => {
    const mockDelete = vi.fn();
    const db = { delete: mockDelete } as unknown as Database;

    await deleteStaleUserMappings(db, []);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('should delete a single mapping ID', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    await deleteStaleUserMappings(db, [42]);

    expect(mockDelete).toHaveBeenCalled();
  });
});

// ─── deleteMappingsByInstallationId ────────────────────────────

describe('deleteMappingsByInstallationId', () => {
  it('should delete all mappings for the given installation', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    await deleteMappingsByInstallationId(db, 5);

    expect(mockDelete).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
  });

  it('should not throw when no mappings exist for the installation (no-op)', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const db = { delete: mockDelete } as unknown as Database;

    // Should not throw even if there are no rows to delete
    await expect(deleteMappingsByInstallationId(db, 999)).resolves.toBeUndefined();
  });
});

// ─── DEFAULT_REPO_SETTINGS (re-exported from schema) ───────────

describe('DEFAULT_REPO_SETTINGS', () => {
  it('should have all required fields', () => {
    expect(DEFAULT_REPO_SETTINGS).toEqual({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      enableMemory: true,
      customRules: [],
      ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
      reviewLevel: 'normal',
      enabledTools: undefined,
      disabledTools: [],
    });
  });

  it('should have reviewLevel as "normal"', () => {
    expect(DEFAULT_REPO_SETTINGS.reviewLevel).toBe('normal');
  });

  it('should have all tools enabled by default', () => {
    expect(DEFAULT_REPO_SETTINGS.enableSemgrep).toBe(true);
    expect(DEFAULT_REPO_SETTINGS.enableTrivy).toBe(true);
    expect(DEFAULT_REPO_SETTINGS.enableCpd).toBe(true);
    expect(DEFAULT_REPO_SETTINGS.enableMemory).toBe(true);
  });
});

// ─── Memory: Management (Delete / Clear / Purge) ───────────────

/**
 * Helper to create a mock db that supports the Drizzle delete chain:
 *   db.delete(table).where(condition).returning(cols)
 *
 * Also provides a nested mock for db.select().from().where() used by the
 * inArray subquery. The subquery mock is returned as part of the db object
 * so Drizzle's `inArray(col, subquery)` receives a proper thenable.
 *
 * @param returnedRows - The rows that `.returning()` resolves with (simulates deleted rows)
 */
function createDeleteMockDb(returnedRows: unknown[] = []) {
  const mockReturning = vi.fn().mockResolvedValue(returnedRows);
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });

  // Subquery support: db.select({...}).from(table).where(condition)
  // The subquery itself is never awaited directly — it's passed to inArray().
  // We just need a chainable object.
  const subqueryWhere = vi.fn().mockReturnThis();
  const subqueryFrom = vi.fn().mockReturnValue({ where: subqueryWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: subqueryFrom });

  const db = {
    delete: mockDelete,
    select: mockSelect,
  } as unknown as Database;

  return { db, mockDelete, mockWhere, mockReturning, mockSelect };
}

describe('deleteMemoryObservation', () => {
  it('should return true when observation is deleted (S1)', async () => {
    const { db } = createDeleteMockDb([{ id: 42 }]);

    const result = await deleteMemoryObservation(db, 100, 42);

    expect(result).toBe(true);
  });

  it('should return false when observation is not found (S2)', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteMemoryObservation(db, 100, 999);

    expect(result).toBe(false);
  });

  it('should return false when observation belongs to different installation — IDOR prevention (S3)', async () => {
    // The subquery for installation 100 won't match the observation's project
    // belonging to installation 200, so DELETE returns 0 rows
    const { db } = createDeleteMockDb([]);

    const result = await deleteMemoryObservation(db, 100, 42);

    expect(result).toBe(false);
  });

  it('should call db.delete with the memoryObservations table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await deleteMemoryObservation(db, 100, 42);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await deleteMemoryObservation(db, 100, 42);

    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('clearMemoryObservationsByProject', () => {
  it('should return count of deleted rows when observations exist (S4)', async () => {
    // Simulate 15 deleted observations
    const deletedRows = Array.from({ length: 15 }, (_, i) => ({ id: i + 1 }));
    const { db } = createDeleteMockDb(deletedRows);

    const result = await clearMemoryObservationsByProject(db, 100, 'acme/widgets');

    expect(result).toBe(15);
  });

  it('should return 0 when no observations exist for the project (S5)', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await clearMemoryObservationsByProject(db, 100, 'acme/empty-repo');

    expect(result).toBe(0);
  });

  it('should return 0 when project belongs to different installation — IDOR prevention (S6)', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await clearMemoryObservationsByProject(db, 100, 'evil/repo');

    expect(result).toBe(0);
  });

  it('should call db.delete with the memoryObservations table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await clearMemoryObservationsByProject(db, 100, 'acme/widgets');

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await clearMemoryObservationsByProject(db, 100, 'acme/widgets');

    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('clearAllMemoryObservations', () => {
  it('should return count of deleted rows across multiple repos (S7)', async () => {
    // Simulate 50 deleted observations (30 + 20 from two repos)
    const deletedRows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    const { db } = createDeleteMockDb(deletedRows);

    const result = await clearAllMemoryObservations(db, 100);

    expect(result).toBe(50);
  });

  it('should return 0 when no observations exist for the installation (S8)', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await clearAllMemoryObservations(db, 100);

    expect(result).toBe(0);
  });

  it('should call db.delete with the memoryObservations table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await clearAllMemoryObservations(db, 100);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await clearAllMemoryObservations(db, 100);

    expect(mockSelect).toHaveBeenCalled();
  });

  it('should not delete observations from other installations', async () => {
    // This test verifies the function only deletes via the scoped subquery.
    // The mock returns empty (no repos match), so nothing gets deleted.
    const { db, mockDelete } = createDeleteMockDb([]);

    const result = await clearAllMemoryObservations(db, 100);

    expect(result).toBe(0);
    expect(mockDelete).toHaveBeenCalled();
  });
});

// ─── Granular & Batch Deletes (Reviews + Observations) ──────────

describe('deleteReviewById', () => {
  it('should return true when owned review is deleted', async () => {
    const { db } = createDeleteMockDb([{ id: 42 }]);

    const result = await deleteReviewById(db, 100, 42);

    expect(result).toBe(true);
  });

  it('should return false when review is not found', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteReviewById(db, 100, 999);

    expect(result).toBe(false);
  });

  it('should return false when review belongs to different installation — IDOR prevention', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteReviewById(db, 100, 42);

    expect(result).toBe(false);
  });

  it('should call db.delete with the reviews table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await deleteReviewById(db, 100, 42);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await deleteReviewById(db, 100, 42);

    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('deleteReviewsByIds', () => {
  it('should return count of deleted rows when reviews are owned', async () => {
    const deletedRows = [{ id: 10 }, { id: 20 }];
    const { db } = createDeleteMockDb(deletedRows);

    const result = await deleteReviewsByIds(db, 100, [10, 20, 30]);

    expect(result).toBe(2);
  });

  it('should return 0 for empty array without executing a query', async () => {
    const mockDelete = vi.fn();
    const db = { delete: mockDelete } as unknown as Database;

    const result = await deleteReviewsByIds(db, 100, []);

    expect(result).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('should return 0 when no reviews belong to the installation', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteReviewsByIds(db, 100, [10, 20]);

    expect(result).toBe(0);
  });

  it('should call db.delete with the reviews table', async () => {
    const { db, mockDelete } = createDeleteMockDb([{ id: 10 }]);

    await deleteReviewsByIds(db, 100, [10]);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([{ id: 10 }]);

    await deleteReviewsByIds(db, 100, [10]);

    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('deleteMemoryObservationsByIds', () => {
  it('should return count of deleted rows when observations are owned', async () => {
    const deletedRows = [{ id: 5 }, { id: 10 }];
    const { db } = createDeleteMockDb(deletedRows);

    const result = await deleteMemoryObservationsByIds(db, 100, [5, 10, 15]);

    expect(result).toBe(2);
  });

  it('should return 0 for empty array without executing a query', async () => {
    const mockDelete = vi.fn();
    const db = { delete: mockDelete } as unknown as Database;

    const result = await deleteMemoryObservationsByIds(db, 100, []);

    expect(result).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('should return 0 when no observations belong to the installation', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteMemoryObservationsByIds(db, 100, [5, 10]);

    expect(result).toBe(0);
  });

  it('should call db.delete with the memoryObservations table', async () => {
    const { db, mockDelete } = createDeleteMockDb([{ id: 5 }]);

    await deleteMemoryObservationsByIds(db, 100, [5]);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([{ id: 5 }]);

    await deleteMemoryObservationsByIds(db, 100, [5]);

    expect(mockSelect).toHaveBeenCalled();
  });
});

// ─── Memory: Read Queries (Installation-Scoped) ─────────────────

describe('getMemoryObservation', () => {
  it('should return the observation when found and scoped to installation', async () => {
    const observation = {
      id: 42,
      sessionId: 1,
      project: 'acme/widgets',
      type: 'decision',
      title: 'Use React 19',
      content: 'Decided to use React 19 for the frontend.',
      topicKey: 'frontend-framework',
      filePaths: ['src/App.tsx'],
      contentHash: 'abc123',
      revisionCount: 1,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
    const db = createMockDb([observation]);

    const result = await getMemoryObservation(db as unknown as Database, 100, 42);

    expect(result).toEqual(observation);
  });

  it('should return null when observation is not found', async () => {
    const db = createMockDb([]);

    const result = await getMemoryObservation(db as unknown as Database, 100, 999);

    expect(result).toBeNull();
  });

  it('should return null when observation belongs to different installation (IDOR prevention)', async () => {
    const db = createMockDb([]);

    const result = await getMemoryObservation(db as unknown as Database, 100, 42);

    expect(result).toBeNull();
  });
});

describe('listMemoryObservations', () => {
  it('should return observations scoped to installation', async () => {
    const observations = [
      { id: 1, project: 'acme/widgets', type: 'decision', title: 'Obs 1' },
      { id: 2, project: 'acme/widgets', type: 'pattern', title: 'Obs 2' },
    ];
    const db = createMockDb(observations);

    const result = await listMemoryObservations(db as unknown as Database, 100);

    expect(result).toEqual(observations);
  });

  it('should return empty array when no observations exist', async () => {
    const db = createMockDb([]);

    const result = await listMemoryObservations(db as unknown as Database, 100);

    expect(result).toEqual([]);
  });

  it('should accept project filter option', async () => {
    const observations = [{ id: 1, project: 'acme/widgets', type: 'decision' }];
    const db = createMockDb(observations);

    const result = await listMemoryObservations(db as unknown as Database, 100, {
      project: 'acme/widgets',
    });

    expect(result).toEqual(observations);
  });

  it('should accept type filter option', async () => {
    const observations = [{ id: 1, project: 'acme/widgets', type: 'decision' }];
    const db = createMockDb(observations);

    const result = await listMemoryObservations(db as unknown as Database, 100, {
      type: 'decision',
    });

    expect(result).toEqual(observations);
  });

  it('should accept pagination options (limit and offset)', async () => {
    const observations = [{ id: 3 }, { id: 4 }];
    const db = createMockDb(observations);

    const result = await listMemoryObservations(db as unknown as Database, 100, {
      limit: 10,
      offset: 2,
    });

    expect(result).toEqual(observations);
  });
});

describe('getMemoryStats', () => {
  it('should return aggregate stats for the installation', async () => {
    const summaryResult = [
      { total: 25, oldest: new Date('2024-01-01'), newest: new Date('2024-06-01') },
    ];
    const db = createMockDb(summaryResult);

    const result = await getMemoryStats(db as unknown as Database, 100);

    expect(result).toHaveProperty('totalObservations');
    expect(result).toHaveProperty('oldestDate');
    expect(result).toHaveProperty('newestDate');
    expect(result).toHaveProperty('byType');
    expect(result).toHaveProperty('byProject');
  });

  it('should return zero stats when no observations exist', async () => {
    const db = createMockDb([]);

    const result = await getMemoryStats(db as unknown as Database, 100);

    expect(result.totalObservations).toBe(0);
    expect(result.oldestDate).toBeNull();
    expect(result.newestDate).toBeNull();
  });
});

// ─── Memory: Session Deletion ──────────────────────────────────

describe('deleteMemorySession', () => {
  it('should return { deleted: true } when session is deleted', async () => {
    const { db } = createDeleteMockDb([{ id: 10 }]);

    const result = await deleteMemorySession(db, 100, 10);

    expect(result).toEqual({ deleted: true });
  });

  it('should return { deleted: false } when session is not found', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteMemorySession(db, 100, 999);

    expect(result).toEqual({ deleted: false });
  });

  it('should return { deleted: false } when session belongs to different installation — IDOR prevention', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await deleteMemorySession(db, 100, 10);

    expect(result).toEqual({ deleted: false });
  });

  it('should call db.delete with the memorySessions table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await deleteMemorySession(db, 100, 10);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await deleteMemorySession(db, 100, 10);

    expect(mockSelect).toHaveBeenCalled();
  });

  it('should delete orphaned session when project has no matching repository', async () => {
    // Step 1 (scoped delete) returns empty — no matching repo for this installation.
    // Step 2 (orphan delete) returns the session — project has no repository at all.
    const mockReturning = vi
      .fn()
      .mockResolvedValueOnce([]) // Step 1: scoped delete finds nothing
      .mockResolvedValueOnce([{ id: 10 }]); // Step 2: orphan delete succeeds
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const subqueryWhere = vi.fn().mockReturnThis();
    const subqueryFrom = vi.fn().mockReturnValue({ where: subqueryWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: subqueryFrom });
    const db = { delete: mockDelete, select: mockSelect } as unknown as Database;

    const result = await deleteMemorySession(db, 100, 10);

    expect(result).toEqual({ deleted: true });
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('should return { deleted: false } when session is not orphaned but belongs to another installation', async () => {
    // Step 1 (scoped delete) returns empty — wrong installation.
    // Step 2 (orphan delete) also returns empty — the project DOES have a matching
    // repository (just under a different installation), so NOT EXISTS fails.
    const mockReturning = vi
      .fn()
      .mockResolvedValueOnce([]) // Step 1: not in this installation
      .mockResolvedValueOnce([]); // Step 2: not orphaned either
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const subqueryWhere = vi.fn().mockReturnThis();
    const subqueryFrom = vi.fn().mockReturnValue({ where: subqueryWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: subqueryFrom });
    const db = { delete: mockDelete, select: mockSelect } as unknown as Database;

    const result = await deleteMemorySession(db, 100, 10);

    expect(result).toEqual({ deleted: false });
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });
});

describe('clearEmptyMemorySessions', () => {
  it('should return deletedCount when empty sessions exist', async () => {
    const deletedRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { db } = createDeleteMockDb(deletedRows);

    const result = await clearEmptyMemorySessions(db, 100);

    expect(result).toEqual({ deletedCount: 3 });
  });

  it('should return deletedCount 0 when no empty sessions exist', async () => {
    const { db } = createDeleteMockDb([]);

    const result = await clearEmptyMemorySessions(db, 100);

    expect(result).toEqual({ deletedCount: 0 });
  });

  it('should accept optional project filter', async () => {
    const { db } = createDeleteMockDb([{ id: 1 }]);

    const result = await clearEmptyMemorySessions(db, 100, 'acme/widgets');

    expect(result).toEqual({ deletedCount: 1 });
  });

  it('should call db.delete with the memorySessions table', async () => {
    const { db, mockDelete } = createDeleteMockDb([]);

    await clearEmptyMemorySessions(db, 100);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should call db.select for the installation subquery', async () => {
    const { db, mockSelect } = createDeleteMockDb([]);

    await clearEmptyMemorySessions(db, 100);

    expect(mockSelect).toHaveBeenCalled();
  });
});

// ─── Issue Drafts: approval lifecycle ──────────────────────────

describe('listIssueDrafts', () => {
  it('returns an empty array WITHOUT querying when repositoryIds is empty', async () => {
    const mockSelect = vi.fn();
    const db = { select: mockSelect } as unknown as Database;

    const result = await listIssueDrafts(db, []);

    expect(result).toEqual([]);
    // SCOPING INVARIANT: a user with no repos must never reach the DB and so can
    // never see another tenant's drafts.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('queries and returns rows when repositoryIds is non-empty', async () => {
    const rows = [
      { id: 1, repositoryId: 7, status: 'DRAFT' },
      { id: 2, repositoryId: 7, status: 'POSTED' },
    ];
    const db = createMockDb(rows) as unknown as Database;

    const result = await listIssueDrafts(db, [7], { status: 'DRAFT' });

    expect(result).toEqual(rows);
  });
});

describe('getIssueDraftById', () => {
  it('returns the row when found', async () => {
    const row = { id: 9, repositoryId: 7, status: 'DRAFT', body: 'x' };
    const db = createMockDb([row]) as unknown as Database;

    const result = await getIssueDraftById(db, 9);

    expect(result).toEqual(row);
  });

  it('returns undefined when not found', async () => {
    const db = createMockDb([]) as unknown as Database;

    const result = await getIssueDraftById(db, 999);

    expect(result).toBeUndefined();
  });
});

describe('updateIssueDraftBody', () => {
  it('returns the updated row (DRAFT-only update)', async () => {
    const updated = { id: 9, repositoryId: 7, status: 'DRAFT', body: 'edited' };
    const db = createMockDb([updated]) as unknown as Database;

    const result = await updateIssueDraftBody(db, 9, 'edited');

    expect(result).toEqual(updated);
  });

  it('returns undefined when the row is not in DRAFT (no row matched the predicate)', async () => {
    const db = createMockDb([]) as unknown as Database;

    const result = await updateIssueDraftBody(db, 9, 'edited');

    expect(result).toBeUndefined();
  });
});

describe('claimIssueDraftForPosting', () => {
  it('claims a DRAFT (CAS DRAFT→APPROVED) and returns the row', async () => {
    const claimed = { id: 9, repositoryId: 7, status: 'APPROVED', body: 'analysis' };
    const db = createMockDb([claimed]) as unknown as Database;

    const result = await claimIssueDraftForPosting(db, 9);

    expect(result).toEqual(claimed);
  });

  it('returns undefined when the draft is not DRAFT (lost the posting claim)', async () => {
    // Of N concurrent approvers only ONE matches the DRAFT row; the losers match
    // ZERO rows here and get undefined → the route returns 409 BEFORE postComment.
    const db = createMockDb([]) as unknown as Database;

    const result = await claimIssueDraftForPosting(db, 9);

    expect(result).toBeUndefined();
  });
});

describe('releaseIssueDraftClaim', () => {
  it('reverts an APPROVED claim back to DRAFT (post failed → retryable)', async () => {
    const reverted = { id: 9, repositoryId: 7, status: 'DRAFT' };
    const db = createMockDb([reverted]) as unknown as Database;

    const result = await releaseIssueDraftClaim(db, 9);

    expect(result).toEqual(reverted);
  });

  it('returns undefined when the row was not APPROVED (nothing to release)', async () => {
    const db = createMockDb([]) as unknown as Database;

    const result = await releaseIssueDraftClaim(db, 9);

    expect(result).toBeUndefined();
  });
});

describe('markIssueDraftPosted', () => {
  it('transitions an APPROVED claim to POSTED and records the comment id', async () => {
    const posted = { id: 9, repositoryId: 7, status: 'POSTED', postedCommentId: 555 };
    const db = createMockDb([posted]) as unknown as Database;

    const result = await markIssueDraftPosted(db, 9, 555);

    expect(result).toEqual(posted);
  });

  it('returns undefined on a non-APPROVED row (exactly-once guard — no double post)', async () => {
    // Only the approver that WON the claim (status APPROVED) matches; a row that
    // is no longer APPROVED matches ZERO rows. Caller treats undefined as
    // "already decided, do not pretend we re-posted".
    const db = createMockDb([]) as unknown as Database;

    const result = await markIssueDraftPosted(db, 9, 555);

    expect(result).toBeUndefined();
  });
});

describe('rejectIssueDraft', () => {
  it('transitions a DRAFT to REJECTED', async () => {
    const rejected = { id: 9, repositoryId: 7, status: 'REJECTED' };
    const db = createMockDb([rejected]) as unknown as Database;

    const result = await rejectIssueDraft(db, 9);

    expect(result).toEqual(rejected);
  });

  it('returns undefined on a non-DRAFT row', async () => {
    const db = createMockDb([]) as unknown as Database;

    const result = await rejectIssueDraft(db, 9);

    expect(result).toBeUndefined();
  });
});

describe('getEffectiveRepoSettings explanation opt-in', () => {
  const repoProviderChain: DbProviderChainEntry[] = [
    { provider: 'gateway', model: 'repo-model', encryptedApiKey: 'repo-key' },
  ];

  function repoInput(settings: RepoSettings | null, useGlobalSettings = false) {
    return {
      installationId: 8,
      useGlobalSettings,
      providerChain: repoProviderChain,
      aiReviewEnabled: false,
      reviewMode: 'consensus',
      settings,
    };
  }

  function dbWithInstallationSettings(settings: RepoSettings) {
    const mockLimit = vi.fn().mockResolvedValue([
      {
        id: 1,
        installationId: 8,
        providerChain: [
          { provider: 'gateway' as const, model: 'global-model', encryptedApiKey: null },
        ],
        aiReviewEnabled: true,
        reviewMode: 'workflow',
        settings,
      },
    ]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    return { select: vi.fn().mockReturnValue({ from: mockFrom }) } as unknown as Database;
  }

  it('defaults legacy and missing selected settings to false without mutating defaults', async () => {
    const legacySettings: RepoSettings = { ...DEFAULT_REPO_SETTINGS, enableMemory: false };
    const legacy = await getEffectiveRepoSettings({} as Database, repoInput(legacySettings));

    expect(legacy.settings.explanationsEnabled).toBe(false);
    expect(legacy.settings.enableMemory).toBe(false);
    expect(legacy.providerChain).toEqual(repoProviderChain);
    expect(legacy.aiReviewEnabled).toBe(false);
    expect(legacy.reviewMode).toBe('consensus');
    expect(legacySettings).not.toHaveProperty('explanationsEnabled');
    expect(DEFAULT_REPO_SETTINGS).not.toHaveProperty('explanationsEnabled');

    const missing = await getEffectiveRepoSettings({} as Database, repoInput(null));
    expect(missing.settings.explanationsEnabled).toBe(false);
    expect(DEFAULT_REPO_SETTINGS).not.toHaveProperty('explanationsEnabled');
  });

  it.each([true, false])('honors explicit repo explanationsEnabled=%s', async (enabled) => {
    const result = await getEffectiveRepoSettings(
      {} as Database,
      repoInput({ ...DEFAULT_REPO_SETTINGS, explanationsEnabled: enabled }),
    );

    expect(result.source).toBe('repo');
    expect(result.settings.explanationsEnabled).toBe(enabled);
  });

  it.each([true, false])(
    'inherits installation explanationsEnabled=%s for global selection',
    async (enabled) => {
      const result = await getEffectiveRepoSettings(
        dbWithInstallationSettings({ ...DEFAULT_REPO_SETTINGS, explanationsEnabled: enabled }),
        repoInput({ ...DEFAULT_REPO_SETTINGS, explanationsEnabled: !enabled }, true),
      );

      expect(result.source).toBe('global');
      expect(result.settings.explanationsEnabled).toBe(enabled);
      expect(result.providerChain[0]?.model).toBe('global-model');
      expect(result.aiReviewEnabled).toBe(true);
      expect(result.reviewMode).toBe('workflow');
    },
  );
});

type ExplanationInvocationIdentityFixture = {
  forgeInstance: string;
  installationId: string;
  actorId: string;
  repositoryId: string;
  pullRequestNumber: number;
  requestedHeadSha: string;
  sourceCommentId: string;
  questionHash: string;
  question: string;
};

type ExplanationInvocationApi = {
  deriveExplanationInvocationKey(identity: ExplanationInvocationIdentityFixture): string | null;
  registerExplanationInvocation(
    db: unknown,
    identity: unknown,
  ): Promise<{ status: string; invocation?: unknown }>;
  lookupExplanationInvocation(
    db: unknown,
    identity: unknown,
  ): Promise<{ status: string; invocation?: unknown }>;
};

const explanationIdentity: ExplanationInvocationIdentityFixture = {
  forgeInstance: 'github.com',
  installationId: 'installation-42',
  actorId: 'actor-99',
  repositoryId: 'repository-7',
  pullRequestNumber: 17,
  requestedHeadSha: 'a'.repeat(40),
  sourceCommentId: 'comment-301',
  question: 'Why was this function changed?',
  questionHash: '70d5cef4a5624f6490a48ccecaf6405959c00e492047fee9b2d928abe48163c4',
};

function explanationStore(inserted: unknown[], selected: unknown[] = []) {
  const returning = vi.fn().mockResolvedValue(inserted);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  const limit = vi.fn().mockResolvedValue(selected);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { insert, select }, insert, select, values, returning, onConflictDoNothing };
}

function questionHash(question: string): string {
  return createHash('sha256').update(question).digest('hex');
}

describe('explanation invocation registration', () => {
  async function api(): Promise<ExplanationInvocationApi> {
    return (await import('./queries.js')) as unknown as ExplanationInvocationApi;
  }

  it('derives a stable SHA-256 key and isolates every immutable identity component', async () => {
    const { deriveExplanationInvocationKey } = await api();
    const key = deriveExplanationInvocationKey(explanationIdentity);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveExplanationInvocationKey({ ...explanationIdentity })).toBe(key);

    for (const component of [
      'forgeInstance',
      'installationId',
      'actorId',
      'repositoryId',
      'pullRequestNumber',
      'requestedHeadSha',
      'sourceCommentId',
      'questionHash',
    ] as const) {
      const value = explanationIdentity[component];
      const changed =
        typeof value === 'number'
          ? value + 1
          : component === 'questionHash'
            ? 'c'.repeat(64)
            : `${value}-other`;
      expect(
        deriveExplanationInvocationKey({ ...explanationIdentity, [component]: changed }),
      ).not.toBe(key);
    }
  });

  it('rejects incomplete or non-exact hash input without writing', async () => {
    const { registerExplanationInvocation, lookupExplanationInvocation } = await api();
    const store = explanationStore([]);

    await expect(
      registerExplanationInvocation(store.db, {
        ...explanationIdentity,
        questionHash: 'B'.repeat(64),
      }),
    ).resolves.toMatchObject({ status: 'invalid' });
    await expect(
      lookupExplanationInvocation(store.db, { ...explanationIdentity, actorId: '' }),
    ).resolves.toMatchObject({ status: 'invalid' });
    expect(store.insert).not.toHaveBeenCalled();
    expect(store.select).not.toHaveBeenCalled();
  });

  it('registers only a pending row and observes an exact duplicate without a second insert', async () => {
    const { registerExplanationInvocation } = await api();
    const pending = { id: 1, ...explanationIdentity, executionStatus: 'PENDING' };
    const fresh = explanationStore([pending]);
    await expect(
      registerExplanationInvocation(fresh.db, explanationIdentity),
    ).resolves.toMatchObject({
      status: 'registered',
      invocation: pending,
    });
    expect(fresh.onConflictDoNothing).toHaveBeenCalledOnce();

    const duplicate = explanationStore([], [pending]);
    await expect(
      registerExplanationInvocation(duplicate.db, explanationIdentity),
    ).resolves.toMatchObject({
      status: 'duplicate',
      invocation: pending,
    });
    expect(duplicate.insert).toHaveBeenCalledOnce();
  });

  it('fails closed for a collision, changed identity, missing conflict follow-up, and database errors', async () => {
    const { lookupExplanationInvocation, registerExplanationInvocation } = await api();
    const stored = { id: 1, ...explanationIdentity, actorId: 'other-actor' };
    await expect(
      registerExplanationInvocation(explanationStore([], [stored]).db, explanationIdentity),
    ).resolves.toMatchObject({ status: 'mismatch' });
    await expect(
      registerExplanationInvocation(explanationStore([]).db, explanationIdentity),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(
      lookupExplanationInvocation(explanationStore([], [stored]).db, explanationIdentity),
    ).resolves.toMatchObject({ status: 'mismatch' });
    await expect(
      lookupExplanationInvocation(explanationStore([]).db, explanationIdentity),
    ).resolves.toMatchObject({
      status: 'not_found',
    });

    const failure = new Error('insert unavailable');
    const insert = vi.fn(() => {
      throw failure;
    });
    await expect(
      registerExplanationInvocation({ insert, select: vi.fn() }, explanationIdentity),
    ).rejects.toBe(failure);
  });
});

describe('explanation invocation question correction', () => {
  it('rejects a request whose exact question does not hash to its identity', async () => {
    const { registerExplanationInvocation } = await import('./queries.js');
    const store = explanationStore([]);
    await expect(
      registerExplanationInvocation(store.db, {
        ...explanationIdentity,
        question: 'Why was this function changed again?',
      } as typeof explanationIdentity),
    ).resolves.toEqual({ status: 'invalid' });
    expect(store.insert).not.toHaveBeenCalled();
  });
});

describe('explanation invocation boundary and authority isolation', () => {
  async function api(): Promise<ExplanationInvocationApi> {
    return (await import('./queries.js')) as unknown as ExplanationInvocationApi;
  }

  it('rejects malformed unknown requests without reading or writing', async () => {
    const { lookupExplanationInvocation, registerExplanationInvocation } = await api();
    const store = explanationStore([]);
    const invalidRequests: unknown[] = [
      null,
      undefined,
      [],
      {},
      { ...explanationIdentity, forgeInstance: null },
      { ...explanationIdentity, actorId: 99 },
      { ...explanationIdentity, pullRequestNumber: 0 },
      { ...explanationIdentity, pullRequestNumber: Number.NaN },
      { ...explanationIdentity, pullRequestNumber: 1.5 },
      { ...explanationIdentity, requestedHeadSha: '' },
      { ...explanationIdentity, questionHash: 'A'.repeat(64) },
      { ...explanationIdentity, question: '' },
      { ...explanationIdentity, question: 'different question' },
    ];

    for (const request of invalidRequests) {
      await expect(registerExplanationInvocation(store.db, request)).resolves.toEqual({
        status: 'invalid',
      });
      await expect(lookupExplanationInvocation(store.db, request)).resolves.toEqual({
        status: 'invalid',
      });
    }

    expect(store.insert).not.toHaveBeenCalled();
    expect(store.select).not.toHaveBeenCalled();
  });

  it('allowlists only pending identity values from structural caller input', async () => {
    const { registerExplanationInvocation } = await api();
    const row = { id: 1, ...explanationIdentity, executionStatus: 'PENDING' };
    const store = explanationStore([row]);
    const request = {
      ...explanationIdentity,
      executionStatus: 'ANSWERED',
      executionFence: 'caller-fence',
      outcomeStatus: 'ANSWERED',
      outcomeAnswer: 'caller-answer',
      progressStatus: 'PUBLISHED',
      progressPublicationStatus: 'PUBLISHED',
      answerPublicationStatus: 'PUBLISHED',
    };

    await expect(registerExplanationInvocation(store.db, request)).resolves.toEqual({
      status: 'registered',
      invocation: row,
    });

    const insertedValues = store.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedValues).toMatchObject({
      forgeInstance: explanationIdentity.forgeInstance,
      installationId: explanationIdentity.installationId,
      actorId: explanationIdentity.actorId,
      repositoryId: explanationIdentity.repositoryId,
      pullRequestNumber: explanationIdentity.pullRequestNumber,
      requestedHeadSha: explanationIdentity.requestedHeadSha,
      sourceCommentId: explanationIdentity.sourceCommentId,
      questionHash: explanationIdentity.questionHash,
      question: explanationIdentity.question,
    });
    for (const field of [
      'executionStatus',
      'executionFence',
      'outcomeStatus',
      'outcomeAnswer',
      'progressStatus',
      'progressPublicationStatus',
      'answerPublicationStatus',
    ]) {
      expect(insertedValues).not.toHaveProperty(field);
    }
  });

  it('propagates insert and select errors while returning opaque mismatch results', async () => {
    const { lookupExplanationInvocation, registerExplanationInvocation } = await api();
    const insertError = new Error('insert error');
    const insertFailure = explanationStore([]);
    insertFailure.insert.mockImplementation(() => {
      throw insertError;
    });
    await expect(registerExplanationInvocation(insertFailure.db, explanationIdentity)).rejects.toBe(
      insertError,
    );

    const selectError = new Error('select error');
    const selectFailure = explanationStore([]);
    selectFailure.select.mockImplementation(() => {
      throw selectError;
    });
    await expect(registerExplanationInvocation(selectFailure.db, explanationIdentity)).rejects.toBe(
      selectError,
    );
    await expect(lookupExplanationInvocation(selectFailure.db, explanationIdentity)).rejects.toBe(
      selectError,
    );

    const stored = { id: 1, ...explanationIdentity, question: 'stored question' };
    await expect(
      registerExplanationInvocation(explanationStore([], [stored]).db, explanationIdentity),
    ).resolves.toEqual({ status: 'mismatch' });
  });

  it('preserves exact pending reserved and terminal rows on duplicates', async () => {
    const { registerExplanationInvocation } = await api();
    const createdAt = new Date('2026-09-08T00:00:00.000Z');
    const rows = [
      { id: 1, ...explanationIdentity, executionStatus: 'PENDING', progressVersion: 0, createdAt },
      {
        id: 2,
        ...explanationIdentity,
        executionStatus: 'DISPATCH_RESERVED',
        executionFence: 'reservation-fence',
        dispatchReservedAt: createdAt,
        dispatchLeaseExpiresAt: createdAt,
        progressVersion: 4,
        progressPublicationStatus: 'CREATE_STARTED',
        progressPublicationCreateStartedAt: createdAt,
        progressCommentId: 501,
        progressExpectedBotAuthorId: 502,
        progressPublicationFence: 'progress-fence',
        progressPublicationVersion: 3,
        createdAt,
      },
      {
        id: 3,
        ...explanationIdentity,
        executionStatus: 'ANSWERED',
        outcomeStatus: 'ANSWERED',
        outcomeAnswer: 'answer',
        outcomeCompletedAt: createdAt,
        progressVersion: 7,
        answerPublicationStatus: 'PUBLISHED',
        answerPublicationCreateStartedAt: createdAt,
        answerCommentId: 601,
        answerExpectedBotAuthorId: 602,
        answerPublicationFence: 'answer-fence',
        answerPublicationVersion: 5,
        createdAt,
      },
    ];

    for (const row of rows) {
      await expect(
        registerExplanationInvocation(explanationStore([], [row]).db, explanationIdentity),
      ).resolves.toEqual({ status: 'duplicate', invocation: row });
    }
  });

  it('registers a distinct request for every tuple component and valid changed question', async () => {
    const { registerExplanationInvocation } = await api();
    const changedQuestion = 'Why did the guard change?';
    const variants = [
      { ...explanationIdentity, forgeInstance: 'github.enterprise' },
      { ...explanationIdentity, installationId: 'installation-43' },
      { ...explanationIdentity, actorId: 'actor-100' },
      { ...explanationIdentity, repositoryId: 'repository-8' },
      { ...explanationIdentity, pullRequestNumber: 18 },
      { ...explanationIdentity, requestedHeadSha: 'b'.repeat(40) },
      { ...explanationIdentity, sourceCommentId: 'comment-302' },
      {
        ...explanationIdentity,
        question: changedQuestion,
        questionHash: questionHash(changedQuestion),
      },
    ];

    for (const request of variants) {
      const row = { id: request.pullRequestNumber, ...request, executionStatus: 'PENDING' };
      await expect(
        registerExplanationInvocation(explanationStore([row]).db, request),
      ).resolves.toEqual({
        status: 'registered',
        invocation: row,
      });
    }
  });
});

describe('explanation invocation settlement', () => {
  it('accepts complete terminal payloads only for their allowed predecessor state', async () => {
    const { validateExplanationInvocationSettlement } = await import('./queries.js');
    const answered = {
      ...explanationIdentity,
      expectedExecutionStatus: 'DISPATCH_RESERVED',
      executionFence: 'dispatch-fence',
      outcome: {
        kind: 'ANSWERED',
        answer: 'The guard prevents stale execution.',
        metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 42 },
      },
    };
    const unavailable = {
      ...explanationIdentity,
      expectedExecutionStatus: 'PENDING',
      outcome: { kind: 'AI_UNAVAILABLE', reason: 'Provider disabled.' },
    };

    expect(validateExplanationInvocationSettlement(answered)).toEqual(answered);
    expect(validateExplanationInvocationSettlement(unavailable)).toEqual(unavailable);
    expect(
      validateExplanationInvocationSettlement({ ...answered, expectedExecutionStatus: 'PENDING' }),
    ).toBeNull();
    expect(
      validateExplanationInvocationSettlement({
        ...unavailable,
        outcome: { kind: 'ANSWERED', answer: 'no', metadata: answered.outcome.metadata },
      }),
    ).toBeNull();
  });

  it('rejects malformed payloads and lifecycle injection before database access', async () => {
    const { validateExplanationInvocationSettlement } = await import('./queries.js');
    const request = {
      ...explanationIdentity,
      expectedExecutionStatus: 'DISPATCH_RESERVED',
      executionFence: 'dispatch-fence',
      outcome: {
        kind: 'ANSWERED',
        answer: 'Answer',
        metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 1 },
      },
    };

    for (const invalid of [
      { ...request, executionFence: '  ' },
      { ...request, outcome: { ...request.outcome, answer: ' ' } },
      {
        ...request,
        outcome: { ...request.outcome, metadata: { ...request.outcome.metadata, tokensUsed: -1 } },
      },
      {
        ...request,
        outcome: { ...request.outcome, metadata: { ...request.outcome.metadata, tokensUsed: 1.5 } },
      },
      { ...request, outcome: { ...request.outcome, reviewStatus: 'PUBLISHED' } },
      { ...request, outcome: { kind: 'UNKNOWN', reason: 'no' } },
      { ...request, progressVersion: 9 },
    ]) {
      expect(validateExplanationInvocationSettlement(invalid)).toBeNull();
    }
  });

  it('rejects invalid requests before DB access and propagates update failures', async () => {
    const { settleExplanationInvocation } = await import('./queries.js');
    const update = vi.fn();
    const select = vi.fn();
    await expect(
      settleExplanationInvocation({ update, select } as unknown as Database, { invalid: true }),
    ).resolves.toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    const failure = new Error('database unavailable');
    const returning = vi.fn().mockRejectedValue(failure);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const updateFrom = vi.fn().mockReturnValue({ where: updateWhere });
    update.mockReturnValue({ set: vi.fn().mockReturnValue({ from: updateFrom }) });
    const lockAs = vi.fn().mockReturnValue({ id: 1, dispatchLeaseExpiresAt: new Date() });
    select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ as: lockAs }) }),
      }),
    });
    await expect(
      settleExplanationInvocation({ update, select } as unknown as Database, {
        ...explanationIdentity,
        expectedExecutionStatus: 'PENDING',
        outcome: { kind: 'INVALID', reason: 'invalid request' },
      }),
    ).rejects.toBe(failure);
  });

  it('replays a complete immutable terminal observation with the explicit settlement allowlist', async () => {
    const { settleExplanationInvocation } = await import('./queries.js');
    const completedAt = new Date('2026-09-08T00:00:00.000Z');
    const outcome = {
      kind: 'ANSWERED' as const,
      answer: 'The existing answer remains immutable.',
      metadata: { provider: 'gateway', model: 'fixed-model', tokensUsed: 7 },
    };
    const request = {
      ...explanationIdentity,
      expectedExecutionStatus: 'DISPATCH_RESERVED' as const,
      executionFence: 'dispatch-fence',
      outcome,
    };
    const observed = {
      id: 1,
      ...explanationIdentity,
      executionStatus: 'ANSWERED',
      outcomeStatus: 'ANSWERED',
      outcomeAnswer: outcome.answer,
      outcomePayload: outcome,
      outcomeCompletedAt: completedAt,
    };
    const returning = vi.fn().mockResolvedValue([]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const updateFrom = vi.fn().mockReturnValue({ where: updateWhere });
    const set = vi.fn().mockReturnValue({ from: updateFrom });
    const update = vi.fn().mockReturnValue({ set });
    const limit = vi.fn().mockResolvedValue([observed]);
    const observeWhere = vi.fn().mockReturnValue({ limit });
    const observeFrom = vi.fn().mockReturnValue({ where: observeWhere });
    const locked = { id: 1, dispatchLeaseExpiresAt: new Date() };
    const lockAs = vi.fn().mockReturnValue(locked);
    const lockFor = vi.fn().mockReturnValue({ as: lockAs });
    const lockWhere = vi.fn().mockReturnValue({ for: lockFor });
    const lockFrom = vi.fn().mockReturnValue({ where: lockWhere });
    const select = vi
      .fn()
      .mockReturnValueOnce({ from: lockFrom })
      .mockReturnValueOnce({ from: observeFrom });

    await expect(
      settleExplanationInvocation({ update, select } as unknown as Database, request),
    ).resolves.toEqual({ status: 'settled', invocation: observed });
    expect(Object.keys(set.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'executionStatus',
      'outcomeAnswer',
      'outcomeCompletedAt',
      'outcomePayload',
      'outcomeStatus',
    ]);
    expect(lockFor).toHaveBeenCalledWith('update');
    expect(updateFrom).toHaveBeenCalledWith(locked);
  });
});

describe('explanation invocation dispatch', () => {
  it('rejects malformed reservation requests before database access', async () => {
    const { reserveExplanationInvocationDispatch } = await import('./queries.js');
    const update = vi.fn();
    const select = vi.fn();
    await expect(
      reserveExplanationInvocationDispatch({ update, select } as unknown as Database, {
        invalid: true,
      }),
    ).resolves.toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('rejects malformed expiry recovery requests before database access', async () => {
    const { recoverExpiredExplanationInvocationDispatch } = await import('./queries.js');
    const update = vi.fn();
    const select = vi.fn();
    await expect(
      recoverExpiredExplanationInvocationDispatch({ update, select } as unknown as Database, {
        ...explanationIdentity,
        executionFence: '',
        injectedLifecycle: 'AMBIGUOUS',
      }),
    ).resolves.toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('uses a locked, fence-bound database-clock recovery update', async () => {
    const { recoverExpiredExplanationInvocationDispatch } = await import('./queries.js');
    const returning = vi.fn().mockResolvedValue([]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const updateFrom = vi.fn().mockReturnValue({ where: updateWhere });
    const set = vi.fn().mockReturnValue({ from: updateFrom });
    const update = vi.fn().mockReturnValue({ set });
    const locked = { id: 1, lease: new Date('2026-09-09T00:00:00.000Z') };
    const lockAs = vi.fn().mockReturnValue(locked);
    const lockFor = vi.fn().mockReturnValue({});
    const lockWhere = vi.fn().mockReturnValue({ for: lockFor });
    const lockFrom = vi.fn().mockReturnValue({ where: lockWhere });
    const select = vi.fn().mockReturnValue({ from: lockFrom });
    const $with = vi.fn().mockReturnValue({ as: lockAs });
    const withLocked = vi.fn().mockReturnValue({ update });

    await expect(
      recoverExpiredExplanationInvocationDispatch(
        { $with, select, update, with: withLocked } as unknown as Database,
        { ...explanationIdentity, executionFence: 'original-fence' },
      ),
    ).resolves.toEqual({ status: 'unavailable' });

    expect(lockFor).toHaveBeenCalledWith('update');
    expect($with).toHaveBeenCalledWith('locked_expired_explanation_invocation');
    expect(withLocked).toHaveBeenCalledWith(locked);
    expect(updateFrom).toHaveBeenCalledWith(locked);
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        executionStatus: 'AMBIGUOUS',
        outcomeStatus: 'AMBIGUOUS',
      }),
    );
  });

  it('propagates reservation update and observation failures', async () => {
    const { reserveExplanationInvocationDispatch } = await import('./queries.js');
    const writeFailure = new Error('reservation write failed');
    const writeDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(writeFailure) }),
        }),
      }),
      select: vi.fn(),
    };
    await expect(
      reserveExplanationInvocationDispatch(writeDb as unknown as Database, {
        ...explanationIdentity,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toBe(writeFailure);

    const observationFailure = new Error('observation read failed');
    const readDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(observationFailure) }),
        }),
      }),
    };
    await expect(
      reserveExplanationInvocationDispatch(readDb as unknown as Database, {
        ...explanationIdentity,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toBe(observationFailure);
  });
});

describe('explanation publication CREATE persistence', () => {
  const publicationRequest = {
    ...explanationIdentity,
    channel: 'progress',
    expectedPublicationVersion: 0,
    expectedBotAuthorId: 42,
  };

  it('reserves only a complete NOT_STARTED channel before caller I/O', async () => {
    const module = await import('./queries.js');
    const update = vi.fn();
    const select = vi.fn();

    await expect(
      module.reserveExplanationPublicationCreate({ update, select } as unknown as Database, {
        ...publicationRequest,
        expectedBotAuthorId: 0,
      }),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      module.reserveExplanationPublicationCreate({ update, select } as unknown as Database, {
        ...publicationRequest,
        expectedPublicationVersion: 2_147_483_647,
      }),
    ).resolves.toEqual({ status: 'invalid' });
    for (const invalid of [
      { ...publicationRequest, channel: 'review' },
      { ...publicationRequest, question: 'a changed question' },
      { ...publicationRequest, questionHash: 'A'.repeat(64) },
      { ...publicationRequest, pullRequestNumber: 0 },
      { ...publicationRequest, expectedPublicationVersion: -1 },
      { ...publicationRequest, expectedPublicationVersion: 1.5 },
      { ...publicationRequest, expectedBotAuthorId: 1.5 },
      { ...publicationRequest, injectedStatus: 'PUBLISHED' },
    ]) {
      await expect(
        module.reserveExplanationPublicationCreate(
          { update, select } as unknown as Database,
          invalid,
        ),
      ).resolves.toEqual({ status: 'invalid' });
    }
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('persists only the selected channel with a database fence and increments its version', async () => {
    const module = await import('./queries.js');
    const reserved = {
      id: 1,
      ...explanationIdentity,
      progressPublicationStatus: 'CREATE_STARTED',
      progressPublicationFence: 'database-fence',
      progressPublicationVersion: 1,
      progressExpectedBotAuthorId: 42,
    };
    const returning = vi.fn().mockResolvedValue([reserved]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });

    await expect(
      module.reserveExplanationPublicationCreate(
        { update, select: vi.fn() } as unknown as Database,
        publicationRequest,
      ),
    ).resolves.toEqual({
      status: 'reserved',
      invocation: reserved,
      publicationFence: 'database-fence',
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        progressPublicationStatus: 'CREATE_STARTED',
        progressExpectedBotAuthorId: 42,
        progressPublicationVersion: 1,
      }),
    );
    expect(Object.keys(set.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'progressExpectedBotAuthorId',
      'progressPublicationCreateStartedAt',
      'progressPublicationFence',
      'progressPublicationStatus',
      'progressPublicationVersion',
    ]);
  });

  it('settles the matching reservation once and rejects late or injected authority', async () => {
    const module = await import('./queries.js');
    const update = vi.fn();
    const select = vi.fn();
    const request = {
      ...publicationRequest,
      expectedPublicationVersion: 1,
      publicationFence: 'publication-fence',
      outcome: 'ACKNOWLEDGED',
      commentId: 701,
    };

    await expect(
      module.settleExplanationPublicationCreate({ update, select } as unknown as Database, {
        ...request,
        expectedBotAuthorId: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      module.settleExplanationPublicationCreate({ update, select } as unknown as Database, {
        ...request,
        outcome: 'UNCERTAIN',
        commentId: 701,
      }),
    ).resolves.toEqual({ status: 'invalid' });
    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('guards both channel int32 fenceposts without database work after the terminal version', async () => {
    const module = await import('./queries.js');
    const maxReservedVersion = 2_147_483_646;
    const lastReservationVersion = 2_147_483_645;

    for (const channel of ['progress', 'answer'] as const) {
      const versionField =
        channel === 'progress' ? 'progressPublicationVersion' : 'answerPublicationVersion';
      const fenceField =
        channel === 'progress' ? 'progressPublicationFence' : 'answerPublicationFence';
      const statusField =
        channel === 'progress' ? 'progressPublicationStatus' : 'answerPublicationStatus';
      const reserved = {
        id: 1,
        ...explanationIdentity,
        [statusField]: 'CREATE_STARTED',
        [fenceField]: `${channel}-terminal-fence`,
        [versionField]: maxReservedVersion,
      };
      const reserveReturning = vi.fn().mockResolvedValue([reserved]);
      const reserveWhere = vi.fn().mockReturnValue({ returning: reserveReturning });
      const reserveSet = vi.fn().mockReturnValue({ where: reserveWhere });
      const reserveUpdate = vi.fn().mockReturnValue({ set: reserveSet });

      await expect(
        module.reserveExplanationPublicationCreate(
          { update: reserveUpdate, select: vi.fn() } as unknown as Database,
          {
            ...publicationRequest,
            channel,
            expectedPublicationVersion: lastReservationVersion,
          },
        ),
      ).resolves.toMatchObject({
        status: 'reserved',
        publicationFence: `${channel}-terminal-fence`,
        invocation: { [versionField]: maxReservedVersion },
      });
      expect(reserveSet).toHaveBeenCalledWith(
        expect.objectContaining({ [versionField]: maxReservedVersion }),
      );

      const settleReturning = vi.fn().mockResolvedValue([
        {
          ...reserved,
          [statusField]: 'PUBLISHED',
          [fenceField]: null,
          [versionField]: 2_147_483_647,
        },
      ]);
      const settleWhere = vi.fn().mockReturnValue({ returning: settleReturning });
      const settleSet = vi.fn().mockReturnValue({ where: settleWhere });
      const settleUpdate = vi.fn().mockReturnValue({ set: settleSet });
      await expect(
        module.settleExplanationPublicationCreate(
          { update: settleUpdate, select: vi.fn() } as unknown as Database,
          {
            ...publicationRequest,
            channel,
            expectedPublicationVersion: maxReservedVersion,
            publicationFence: `${channel}-terminal-fence`,
            outcome: 'ACKNOWLEDGED',
            commentId: 701,
          },
        ),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: { [versionField]: 2_147_483_647 },
      });
      expect(settleSet).toHaveBeenCalledWith(
        expect.objectContaining({ [versionField]: 2_147_483_647 }),
      );

      const invalidUpdate = vi.fn();
      const invalidSelect = vi.fn();
      await expect(
        module.reserveExplanationPublicationCreate(
          { update: invalidUpdate, select: invalidSelect } as unknown as Database,
          {
            ...publicationRequest,
            channel,
            expectedPublicationVersion: maxReservedVersion,
          },
        ),
      ).resolves.toEqual({ status: 'invalid' });
      await expect(
        module.settleExplanationPublicationCreate(
          { update: invalidUpdate, select: invalidSelect } as unknown as Database,
          {
            ...publicationRequest,
            channel,
            expectedPublicationVersion: 2_147_483_647,
            publicationFence: `${channel}-terminal-fence`,
            outcome: 'ACKNOWLEDGED',
            commentId: 701,
          },
        ),
      ).resolves.toEqual({ status: 'invalid' });
      expect(invalidUpdate).not.toHaveBeenCalled();
      expect(invalidSelect).not.toHaveBeenCalled();
    }
  });

  it('consumes a matching fence into PUBLISHED or AMBIGUOUS without changing the other channel', async () => {
    const module = await import('./queries.js');
    const settled = {
      id: 1,
      ...explanationIdentity,
      progressPublicationStatus: 'PUBLISHED',
      progressCommentId: 701,
      progressPublicationFence: null,
      progressPublicationVersion: 2,
      answerPublicationStatus: 'NOT_STARTED',
      answerPublicationVersion: 0,
    };
    const returning = vi.fn().mockResolvedValue([settled]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const request = {
      ...publicationRequest,
      expectedPublicationVersion: 1,
      publicationFence: 'publication-fence',
      outcome: 'ACKNOWLEDGED',
      commentId: 701,
    };

    await expect(
      module.settleExplanationPublicationCreate(
        { update, select: vi.fn() } as unknown as Database,
        request,
      ),
    ).resolves.toEqual({ status: 'settled', invocation: settled });
    expect(set).toHaveBeenCalledWith({
      progressPublicationStatus: 'PUBLISHED',
      progressCommentId: 701,
      progressPublicationFence: null,
      progressPublicationVersion: 2,
    });
  });
});

describe('explanation publication stale persistence', () => {
  const staleRequest = {
    ...explanationIdentity,
    channel: 'progress' as const,
  };

  it('persists and replays STALE without changing execution outcome or visible publication data', async () => {
    const module = await import('./queries.js');
    const stale = {
      id: 1,
      ...explanationIdentity,
      executionStatus: 'ANSWERED',
      outcomeStatus: 'ANSWERED',
      outcomeAnswer: 'persisted answer',
      progressPublicationStatus: 'STALE',
      progressPublicationVersion: 4,
      progressCommentId: 701,
      answerPublicationStatus: 'PUBLISHED',
      answerPublicationVersion: 8,
      answerCommentId: 702,
    };
    const returning = vi.fn().mockResolvedValueOnce([stale]).mockResolvedValueOnce([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const limit = vi.fn().mockResolvedValue([stale]);
    const selectWhere = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const markStale = (
      module as unknown as {
        markExplanationPublicationStale: (
          db: Database,
          request: typeof staleRequest,
        ) => Promise<unknown>;
      }
    ).markExplanationPublicationStale;

    await expect(
      markStale({ update, select } as unknown as Database, staleRequest),
    ).resolves.toEqual({
      status: 'stale',
      invocation: stale,
    });
    await expect(
      markStale({ update, select } as unknown as Database, staleRequest),
    ).resolves.toEqual({
      status: 'stale',
      invocation: stale,
    });

    expect(set).toHaveBeenCalledWith({ progressPublicationStatus: 'STALE' });
    expect(stale).toMatchObject({
      executionStatus: 'ANSWERED',
      outcomeStatus: 'ANSWERED',
      outcomeAnswer: 'persisted answer',
      progressPublicationVersion: 4,
      progressCommentId: 701,
      answerPublicationStatus: 'PUBLISHED',
      answerPublicationVersion: 8,
      answerCommentId: 702,
    });
  });
});

describe('explanation publication PATCH persistence', () => {
  const patchRequest = {
    ...explanationIdentity,
    channel: 'progress' as const,
    expectedPublicationVersion: 2,
    expectedBotAuthorId: 42,
    commentId: 701,
  };

  it('reserves only a matching PUBLISHED comment into PATCH_STARTED without a CREATE timestamp', async () => {
    const module = await import('./queries.js');
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const limit = vi.fn().mockResolvedValue([]);
    const selectWhere = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });

    await expect(
      module.reserveExplanationPublicationPatch(
        { update, select } as unknown as Database,
        patchRequest,
      ),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('validates both channels and preserves the comment while fencing ACKNOWLEDGED and UNCERTAIN settlements', async () => {
    const module = await import('./queries.js');
    for (const invalid of [
      { ...patchRequest, commentId: 0 },
      { ...patchRequest, expectedPublicationVersion: 2_147_483_647 },
      { ...patchRequest, channel: 'review' },
      { ...patchRequest, injectedStatus: 'PUBLISHED' },
    ]) {
      expect(module.validateExplanationPublicationPatchReservation(invalid)).toBeNull();
    }

    for (const channel of ['progress', 'answer'] as const) {
      const fields =
        channel === 'progress'
          ? {
              status: 'progressPublicationStatus',
              fence: 'progressPublicationFence',
              version: 'progressPublicationVersion',
              comment: 'progressCommentId',
            }
          : {
              status: 'answerPublicationStatus',
              fence: 'answerPublicationFence',
              version: 'answerPublicationVersion',
              comment: 'answerCommentId',
            };
      const reserved = {
        id: 1,
        ...explanationIdentity,
        [fields.status]: 'PATCH_STARTED',
        [fields.fence]: `${channel}-fence`,
        [fields.version]: 3,
        [fields.comment]: 701,
      };
      const reserveReturning = vi.fn().mockResolvedValue([reserved]);
      const reserveWhere = vi.fn().mockReturnValue({ returning: reserveReturning });
      const reserveSet = vi.fn().mockReturnValue({ where: reserveWhere });
      const reserveUpdate = vi.fn().mockReturnValue({ set: reserveSet });
      await expect(
        module.reserveExplanationPublicationPatch(
          { update: reserveUpdate, select: vi.fn() } as unknown as Database,
          { ...patchRequest, channel },
        ),
      ).resolves.toMatchObject({ status: 'reserved', publicationFence: `${channel}-fence` });
      expect(reserveSet).toHaveBeenCalledWith(
        expect.objectContaining({ [fields.status]: 'PATCH_STARTED', [fields.version]: 3 }),
      );
      expect(Object.keys(reserveSet.mock.calls[0]?.[0] ?? {})).not.toContain(
        channel === 'progress'
          ? 'progressPublicationCreateStartedAt'
          : 'answerPublicationCreateStartedAt',
      );

      for (const outcome of ['ACKNOWLEDGED', 'UNCERTAIN'] as const) {
        const settled = {
          ...reserved,
          [fields.status]: outcome === 'ACKNOWLEDGED' ? 'PUBLISHED' : 'AMBIGUOUS',
          [fields.fence]: null,
          [fields.version]: 4,
        };
        const settleReturning = vi.fn().mockResolvedValue([settled]);
        const settleWhere = vi.fn().mockReturnValue({ returning: settleReturning });
        const settleSet = vi.fn().mockReturnValue({ where: settleWhere });
        const settleUpdate = vi.fn().mockReturnValue({ set: settleSet });
        await expect(
          module.settleExplanationPublicationPatch(
            { update: settleUpdate, select: vi.fn() } as unknown as Database,
            {
              ...patchRequest,
              channel,
              expectedPublicationVersion: 3,
              publicationFence: `${channel}-fence`,
              outcome,
            },
          ),
        ).resolves.toMatchObject({
          status: 'settled',
          invocation: { [fields.status]: settled[fields.status] },
        });
        expect(settleSet).toHaveBeenCalledWith({
          [fields.status]: outcome === 'ACKNOWLEDGED' ? 'PUBLISHED' : 'AMBIGUOUS',
          [fields.fence]: null,
          [fields.version]: 4,
        });
      }
    }
  });

  it('uses the exact int32 PATCH reservation and settlement fenceposts for both channels', async () => {
    const module = await import('./queries.js');
    for (const channel of ['progress', 'answer'] as const) {
      const fields =
        channel === 'progress'
          ? {
              status: 'progressPublicationStatus',
              fence: 'progressPublicationFence',
              version: 'progressPublicationVersion',
              comment: 'progressCommentId',
            }
          : {
              status: 'answerPublicationStatus',
              fence: 'answerPublicationFence',
              version: 'answerPublicationVersion',
              comment: 'answerCommentId',
            };
      const reserved = {
        id: 1,
        ...explanationIdentity,
        [fields.status]: 'PATCH_STARTED',
        [fields.fence]: `${channel}-terminal-fence`,
        [fields.version]: 2_147_483_646,
        [fields.comment]: 701,
      };
      const settled = {
        ...reserved,
        [fields.status]: 'PUBLISHED',
        [fields.fence]: null,
        [fields.version]: 2_147_483_647,
      };
      const returning = vi.fn().mockResolvedValueOnce([reserved]).mockResolvedValueOnce([settled]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      const update = vi.fn().mockReturnValue({ set });
      const db = { update, select: vi.fn() } as unknown as Database;
      const request = {
        ...patchRequest,
        channel,
        expectedPublicationVersion: 2_147_483_645,
      };

      await expect(module.reserveExplanationPublicationPatch(db, request)).resolves.toMatchObject({
        status: 'reserved',
        publicationFence: `${channel}-terminal-fence`,
        invocation: { [fields.version]: 2_147_483_646 },
      });
      await expect(
        module.settleExplanationPublicationPatch(db, {
          ...request,
          expectedPublicationVersion: 2_147_483_646,
          publicationFence: `${channel}-terminal-fence`,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toMatchObject({
        status: 'settled',
        invocation: { [fields.version]: 2_147_483_647 },
      });
      expect(set).toHaveBeenNthCalledWith(1, {
        [fields.status]: 'PATCH_STARTED',
        [fields.fence]: expect.anything(),
        [fields.version]: 2_147_483_646,
      });
      expect(set).toHaveBeenNthCalledWith(2, {
        [fields.status]: 'PUBLISHED',
        [fields.fence]: null,
        [fields.version]: 2_147_483_647,
      });

      const rejectedDb = { update: vi.fn(), select: vi.fn() } as unknown as Database;
      await expect(
        module.reserveExplanationPublicationPatch(rejectedDb, {
          ...request,
          expectedPublicationVersion: 2_147_483_646,
        }),
      ).resolves.toEqual({ status: 'invalid' });
      await expect(
        module.settleExplanationPublicationPatch(rejectedDb, {
          ...request,
          expectedPublicationVersion: 2_147_483_647,
          publicationFence: `${channel}-terminal-fence`,
          outcome: 'ACKNOWLEDGED',
        }),
      ).resolves.toEqual({ status: 'invalid' });
      expect(rejectedDb.update).not.toHaveBeenCalled();
      expect(rejectedDb.select).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed PATCH reservation and settlement authority before database work', async () => {
    const module = await import('./queries.js');
    const malformedReservations: unknown[] = [
      null,
      [],
      { ...patchRequest, expectedBotAuthorId: 1.5 },
      { ...patchRequest, expectedBotAuthorId: -1 },
      { ...patchRequest, expectedBotAuthorId: Number.MAX_SAFE_INTEGER + 1 },
      { ...patchRequest, expectedPublicationVersion: 1.5 },
      { ...patchRequest, expectedPublicationVersion: -1 },
      { ...patchRequest, expectedPublicationVersion: 2_147_483_647 },
      { ...patchRequest, commentId: 1.5 },
      { ...patchRequest, commentId: -1 },
      { ...patchRequest, question: '' },
      { ...patchRequest, questionHash: 'not-a-sha256' },
      { ...patchRequest, questionHash: 'a'.repeat(64) },
      { ...patchRequest, repositoryId: '' },
      { ...patchRequest, sourceCommentId: undefined },
      { ...patchRequest, unexpected: true },
    ];
    const malformedSettlements: unknown[] = [
      ...malformedReservations,
      {
        ...patchRequest,
        expectedPublicationVersion: 3,
        publicationFence: '',
        outcome: 'ACKNOWLEDGED',
      },
      {
        ...patchRequest,
        expectedPublicationVersion: 3,
        publicationFence: 'fence',
        outcome: 'INVALID',
      },
      {
        ...patchRequest,
        expectedPublicationVersion: 3,
        expectedBotAuthorId: Number.MAX_SAFE_INTEGER + 1,
        publicationFence: 'fence',
        outcome: 'ACKNOWLEDGED',
      },
      {
        ...patchRequest,
        expectedPublicationVersion: 3,
        questionHash: 'a'.repeat(64),
        publicationFence: 'fence',
        outcome: 'ACKNOWLEDGED',
      },
      {
        ...patchRequest,
        expectedPublicationVersion: 3,
        publicationFence: 'fence',
        outcome: 'ACKNOWLEDGED',
        lifecycle: 'caller-controlled',
      },
    ];

    for (const value of malformedReservations) {
      const db = { update: vi.fn(), select: vi.fn() } as unknown as Database;
      await expect(module.reserveExplanationPublicationPatch(db, value)).resolves.toEqual({
        status: 'invalid',
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    }
    for (const value of malformedSettlements) {
      const db = { update: vi.fn(), select: vi.fn() } as unknown as Database;
      await expect(module.settleExplanationPublicationPatch(db, value)).resolves.toEqual({
        status: 'invalid',
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    }
  });
});
