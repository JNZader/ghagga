/**
 * Tests for GlobalSettings page.
 *
 * Since GlobalSettings is a large page component with many dependencies,
 * we test the key behaviors by rendering GlobalSettings with
 * all API hooks mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock modules ───────────────────────────────────────────────

// Mock api hooks
const mockUseInstallations = vi.fn();
const mockUseInstallationSettings = vi.fn();
const mockUseUpdateInstallationSettings = vi.fn();
const mockUseValidateProvider = vi.fn();

vi.mock('@/lib/api', () => ({
  useInstallations: () => mockUseInstallations(),
  useInstallationSettings: () => mockUseInstallationSettings(),
  useUpdateInstallationSettings: () => mockUseUpdateInstallationSettings(),
  useValidateProvider: () => mockUseValidateProvider(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

// Mock ProviderChainEditor (complex component we're not testing here)
vi.mock('@/components/settings/ProviderChainEditor', () => ({
  ProviderChainEditor: () => <div data-testid="provider-chain-editor" />,
}));

// Now import the component under test
import { GlobalSettings } from './GlobalSettings';

// ─── Helpers ────────────────────────────────────────────────────

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderGlobalSettings() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <GlobalSettings />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// Default mock return values
const DEFAULT_INSTALLATION = {
  data: [{ id: 100, accountLogin: 'testuser', accountType: 'User' }],
  isLoading: false,
};

const DEFAULT_SETTINGS = {
  data: {
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: false,
    enableMemory: true,
    enableBlastRadius: false,
    customRules: '',
    ignorePatterns: [],
    disabledTools: [],
    registeredTools: [],
  },
  isLoading: false,
};

const DEFAULT_UPDATE = {
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
};

const DEFAULT_VALIDATE = {
  mutateAsync: vi.fn(),
  isPending: false,
};

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockUseInstallations.mockReturnValue(DEFAULT_INSTALLATION);
  mockUseInstallationSettings.mockReturnValue(DEFAULT_SETTINGS);
  mockUseUpdateInstallationSettings.mockReturnValue(DEFAULT_UPDATE);
  mockUseValidateProvider.mockReturnValue(DEFAULT_VALIDATE);
});

// ═══════════════════════════════════════════════════════════════════
// Workflow Installation Card
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Installation Card', () => {
  it('renders the inline workflow installation card', async () => {
    renderGlobalSettings();

    await vi.waitFor(() => {
      expect(screen.getByText('Inline Workflow Installation')).toBeInTheDocument();
    });
  });

  it('shows instructions to go to Repository Settings for per-repo management', async () => {
    renderGlobalSettings();

    await vi.waitFor(() => {
      expect(screen.getByText(/Workflows are automatically injected/)).toBeInTheDocument();
      expect(screen.getByText(/Repository Settings/)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Page structure
// ═══════════════════════════════════════════════════════════════════

describe('GlobalSettings page', () => {
  it('renders page header', () => {
    renderGlobalSettings();

    expect(screen.getByText('Global Settings')).toBeInTheDocument();
  });

  it('shows loading spinner when installation is loading', () => {
    mockUseInstallations.mockReturnValue({ data: undefined, isLoading: true });

    renderGlobalSettings();

    // Should show a spinner (not crash)
    const spinners = document.querySelectorAll('.animate-spin');
    expect(spinners.length).toBeGreaterThan(0);
  });
});
