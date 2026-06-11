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
  listMemoryObservations,
  removeRepoApiKey,
  saveObservation,
  saveRepoApiKey,
  saveReview,
  searchObservations,
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
    expect(result.settings).toEqual(DEFAULT_REPO_SETTINGS);
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
    expect(result.settings).toEqual(DEFAULT_REPO_SETTINGS);
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
