/**
 * Opt-in surface for `/ghagga explain`.
 *
 * The webhook and worker already refuse explanations unless the effective
 * repository settings say `explanationsEnabled`. These routes are the only
 * maintainer-facing way to turn that flag on. Omitted values stay off.
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
  };
});

vi.mock('./utils.js', () => ({
  generateErrorId: () => 'err-test',
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  buildProviderChainView: () => [],
  maskApiKey: (value: string) => value,
}));

import { createInstallationsRouter } from './installations.js';
import { createSettingsRouter } from './settings.js';

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

function repo(settings: Record<string, unknown> = {}) {
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
  };
}

describe('explanation settings opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallationSettings.mockResolvedValue(null);
    mockGetInstallationById.mockResolvedValue({ id: 100, accountLogin: 'acme' });
    mockUpdateRepoSettings.mockResolvedValue(undefined);
    mockUpsertInstallationSettings.mockResolvedValue(undefined);
  });

  it('reports explanations as disabled when the stored settings omit the flag', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());

    const response = await createApp().request('/api/settings?repo=acme/app');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.explanationsEnabled).toBe(false);
  });

  it('persists an explicit repository opt-in and preserves an omitted flag', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo({ explanationsEnabled: true }));

    const enabled = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        explanationsEnabled: true,
      }),
    });
    expect(enabled.status).toBe(200);
    expect(mockUpdateRepoSettings).toHaveBeenCalledWith(
      mockDb,
      7,
      expect.objectContaining({
        settings: expect.objectContaining({
          explanationsEnabled: true,
          enableMemory: DEFAULT_REPO_SETTINGS.enableMemory,
        }),
      }),
    );

    mockUpdateRepoSettings.mockClear();
    const preserved = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'acme/app', providerChain: [], enableMemory: false }),
    });
    expect(preserved.status).toBe(200);
    expect(mockUpdateRepoSettings.mock.calls[0]?.[2].settings.explanationsEnabled).toBe(true);
    expect(mockUpdateRepoSettings.mock.calls[0]?.[2].settings.enableMemory).toBe(false);
  });

  it('rejects a non-boolean explanationsEnabled value before writing settings', async () => {
    mockGetRepoByFullName.mockResolvedValue(repo());

    const response = await createApp().request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'acme/app',
        providerChain: [],
        explanationsEnabled: 'yes',
      }),
    });

    expect(response.status).toBe(400);
    expect(mockUpdateRepoSettings).not.toHaveBeenCalled();
  });

  it('defaults installation explanations to false and persists an explicit opt-in', async () => {
    mockGetInstallationSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { ...DEFAULT_REPO_SETTINGS },
    });

    const missing = await createApp().request('/api/installation-settings?installation_id=100');
    expect((await missing.json()).data.explanationsEnabled).toBe(false);

    mockGetInstallationSettings.mockResolvedValue(null);
    const empty = await createApp().request('/api/installation-settings?installation_id=100');
    expect((await empty.json()).data.explanationsEnabled).toBe(false);

    mockGetInstallationSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: { ...DEFAULT_REPO_SETTINGS, explanationsEnabled: false },
    });
    const updated = await createApp().request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [],
        explanationsEnabled: true,
      }),
    });
    expect(updated.status).toBe(200);
    expect(mockUpsertInstallationSettings).toHaveBeenCalledWith(
      mockDb,
      100,
      expect.objectContaining({
        settings: expect.objectContaining({ explanationsEnabled: true }),
      }),
    );
  });

  it('copies a repository explanation opt-in to global settings and keeps an omitted flag off', async () => {
    mockGetRepositoryById.mockResolvedValueOnce(repo({ explanationsEnabled: true }));
    const enabled = await createApp().request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 7 }),
    });
    expect(enabled.status).toBe(200);
    expect(mockUpsertInstallationSettings.mock.calls[0]?.[2].settings.explanationsEnabled).toBe(
      true,
    );

    mockUpsertInstallationSettings.mockClear();
    mockGetRepositoryById.mockResolvedValueOnce(repo());
    const omitted = await createApp().request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 7 }),
    });
    expect(omitted.status).toBe(200);
    expect(mockUpsertInstallationSettings.mock.calls[0]?.[2].settings.explanationsEnabled).toBe(
      false,
    );
  });
});
