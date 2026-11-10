/**
 * Route-level tests for the `digestsEnabled` settings plumbing
 * (nightly-health-digest T3.5).
 *
 * Mirrors explanation-settings.test.ts: ghagga-db mocked, digest queue module
 * mocked (the routes lazy-import it for the scheduler hook), Hono app with a
 * stubbed auth user. Asserts: absent field resolves false with no scheduler
 * registered; installation-level enable flows to global-settings repos while a
 * per-repo override wins; toggling invokes the schedule/unschedule hook after a
 * successful upsert.
 */

import { DEFAULT_REPO_SETTINGS } from 'ghagga-db';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetRepoByFullName = vi.fn();
const mockGetRepositoryById = vi.fn();
const mockGetInstallationById = vi.fn();
const mockGetInstallationSettings = vi.fn();
const mockUpdateRepoSettings = vi.fn();
const mockUpsertInstallationSettings = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();
const mockGetReposByInstallationId = vi.fn();

vi.mock('ghagga-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-db')>();
  return {
    ...actual,
    getRepoByFullName: (...args: unknown[]) => mockGetRepoByFullName(...args),
    getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
    getInstallationById: (...args: unknown[]) => mockGetInstallationById(...args),
    getInstallationSettings: (...args: unknown[]) => mockGetInstallationSettings(...args),
    updateRepoSettings: (...args: unknown[]) => mockUpdateRepoSettings(...args),
    upsertInstallationSettings: (...args: unknown[]) => mockUpsertInstallationSettings(...args),
    getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
    getReposByInstallationId: (...args: unknown[]) => mockGetReposByInstallationId(...args),
  };
});

const mockScheduleReconcileForRepo = vi.fn();
const mockScheduleReconcileForInstallation = vi.fn();

vi.mock('../../queues/digest.js', () => ({
  digestQueue: {},
  reconcileDigestSchedulerForRepo: (...args: unknown[]) => mockScheduleReconcileForRepo(...args),
  reconcileDigestSchedulersForInstallation: (...args: unknown[]) =>
    mockScheduleReconcileForInstallation(...args),
}));

vi.mock('./utils.js', () => ({
  generateErrorId: () => 'err-test',
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  buildProviderChainView: () => [],
  maskApiKey: (value: string) => value,
}));

import { createInstallationsRouter } from './installations.js';
import { createSettingsRouter } from './settings.js';
import { logger } from './utils.js';

const mockDb = {} as never;
const user = { githubUserId: 1, githubLogin: 'maintainer', installationIds: [100] };

function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', createSettingsRouter(mockDb));
  app.route('/', createInstallationsRouter(mockDb));
  return app;
}

function repo(settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    installationId: 100,
    fullName: 'acme/app',
    settings: { ...DEFAULT_REPO_SETTINGS, ...settings },
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    useGlobalSettings: false,
    isActive: true,
    ...overrides,
  };
}

/** The per-repo scheduler hook resolves effective settings via this mock. */
function wireEffective(digestsEnabled: boolean) {
  mockGetRepositoryById.mockResolvedValue(repo());
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: { digestsEnabled },
    source: 'repo',
  });
}

/** Flush the fire-and-forget scheduler hook microtask chain. */
async function flushHooks() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetInstallationSettings.mockResolvedValue(null);
  mockGetInstallationById.mockResolvedValue({ id: 100, accountLogin: 'acme' });
  mockUpdateRepoSettings.mockResolvedValue(undefined);
  mockUpsertInstallationSettings.mockResolvedValue(undefined);
});

describe('digestsEnabled settings plumbing', () => {
  it('absent field at repo AND installation level → resolves false, no scheduler registered', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());

    const response = await createApp().request('/api/settings?repo=acme/app');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.digestsEnabled).toBe(false);
    // No PUT happened → the scheduler hook never fires.
    expect(mockScheduleReconcileForRepo).not.toHaveBeenCalled();
  });

  it('surfaces digestsEnabled false in the installation defaults view', async () => {
    const response = await createApp().request('/api/installation-settings?installation_id=100');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.digestsEnabled).toBe(false);
  });

  it('installation digestsEnabled:true + repo A useGlobalSettings → effective true; repo B per-repo false overrides', async () => {
    // Repo A: global settings — GET shows the GLOBAL digestsEnabled value.
    mockGetRepoByFullName.mockResolvedValue(repo({}, { useGlobalSettings: true }));
    mockGetInstallationSettings.mockResolvedValue({
      id: 1,
      installationId: 100,
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { ...DEFAULT_REPO_SETTINGS, digestsEnabled: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const globalView = await (await createApp().request('/api/settings?repo=acme/app')).json();
    expect(globalView.data.globalSettings.digestsEnabled).toBe(true);

    // Repo A hook resolution: effective settings resolve through the global row.
    mockGetRepositoryById.mockResolvedValue(
      repo({ digestsEnabled: true }, { useGlobalSettings: true }),
    );
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: true },
      source: 'global',
    });
    await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'acme/app', providerChain: [], enableMemory: true }),
    });
    await flushHooks();
    expect(mockScheduleReconcileForRepo).toHaveBeenCalledWith(expect.anything(), {}, 7);

    // Repo B: useGlobalSettings=false + digestsEnabled:false → per-repo wins.
    mockGetRepositoryById.mockResolvedValue(
      repo({ digestsEnabled: false }, { fullName: 'acme/other', useGlobalSettings: false }),
    );
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { digestsEnabled: false },
      source: 'repo',
    });
    mockGetRepoByFullName.mockResolvedValue(
      repo({ digestsEnabled: false }, { fullName: 'acme/other', useGlobalSettings: false }),
    );
    const perRepoView = await (await createApp().request('/api/settings?repo=acme/other')).json();
    expect(perRepoView.data.digestsEnabled).toBe(false);
  });

  it('persists an explicit repo opt-in AND invokes the scheduler hook after the upsert', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());
    wireEffective(true);

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        digestsEnabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateRepoSettings).toHaveBeenCalledWith(
      mockDb,
      7,
      expect.objectContaining({
        settings: expect.objectContaining({ digestsEnabled: true }),
      }),
    );
    await flushHooks();
    expect(mockScheduleReconcileForRepo).toHaveBeenCalledWith(mockDb, {}, 7);
  });

  it('coalesces installation-level digestsEnabled and invokes the installation hook', async () => {
    mockGetInstallationSettings.mockResolvedValue({
      id: 1,
      installationId: 100,
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { ...DEFAULT_REPO_SETTINGS },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await createApp().request('/api/installation-settings?installation_id=100', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [],
        digestsEnabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockUpsertInstallationSettings).toHaveBeenCalledWith(
      mockDb,
      100,
      expect.objectContaining({
        settings: expect.objectContaining({ digestsEnabled: true }),
      }),
    );
    await flushHooks();
    expect(mockScheduleReconcileForInstallation).toHaveBeenCalledWith(mockDb, {}, 100);
  });

  it('omitted digestsEnabled on a repo PUT preserves the stored value (coalescing)', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo({ digestsEnabled: true }));

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'acme/app', providerChain: [], enableMemory: false }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateRepoSettings).toHaveBeenCalledWith(
      mockDb,
      7,
      expect.objectContaining({
        settings: expect.objectContaining({ digestsEnabled: true }),
      }),
    );
  });

  it('rejects a non-boolean digestsEnabled with a validation error', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        digestsEnabled: 'yes',
      }),
    });

    expect(response.status).toBe(400);
    expect(mockUpdateRepoSettings).not.toHaveBeenCalled();
  });
});

// ─── Scheduler reconcile failure surfacing (resilience B4) ───────
//
// Regression: the hook was fire-and-forget, so Redis being down during the
// PUT returned a plain 200 with the digest enabled in the DB but never
// scheduled — zero signal. The reconcile is now AWAITED; on failure the
// save still succeeds (200, setting persisted) but the failure is logged
// at error level and surfaced via a warning header.

describe('scheduler reconcile failure surfacing (resilience B4)', () => {
  it('repo PUT: rejecting reconcile → 200, setting persisted, error logged + warning header', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());
    wireEffective(true);
    mockScheduleReconcileForRepo.mockRejectedValueOnce(new Error('redis unreachable'));

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        digestsEnabled: true,
      }),
    });

    // The save IS persisted — a scheduler hiccup never fails the PUT.
    expect(response.status).toBe(200);
    expect(mockUpdateRepoSettings).toHaveBeenCalledWith(
      mockDb,
      7,
      expect.objectContaining({
        settings: expect.objectContaining({ digestsEnabled: true }),
      }),
    );
    // ...but the failure is visible: error log + warning header on the 200.
    expect(response.headers.get('X-Ghagga-Warning')).toBe('digest-scheduler-reconcile-failed');
    expect(logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 7 }),
      expect.stringContaining('scheduler reconcile failed'),
    );
  });

  it('repo PUT: healthy reconcile → 200 with NO warning header', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());
    wireEffective(true);

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        digestsEnabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Ghagga-Warning')).toBeNull();
  });

  it('installation PUT: rejecting reconcile → 200, upsert persisted, error logged + warning header', async () => {
    mockGetInstallationSettings.mockResolvedValue({
      id: 1,
      installationId: 100,
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { ...DEFAULT_REPO_SETTINGS },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockScheduleReconcileForInstallation.mockRejectedValueOnce(new Error('redis unreachable'));

    const response = await createApp().request('/api/installation-settings?installation_id=100', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [],
        digestsEnabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockUpsertInstallationSettings).toHaveBeenCalledWith(
      mockDb,
      100,
      expect.objectContaining({
        settings: expect.objectContaining({ digestsEnabled: true }),
      }),
    );
    expect(response.headers.get('X-Ghagga-Warning')).toBe('digest-scheduler-reconcile-failed');
    expect(logger.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 100 }),
      expect.stringContaining('scheduler reconcile failed'),
    );
  });
});
