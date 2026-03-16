/**
 * ProviderChainEditor component tests.
 *
 * Tests the chain editor's empty state, add/remove behavior,
 * rendering of provider entries, and key selector propagation.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableKeysMap } from '@/lib/api';
import { createTestQueryClient } from '@/test/test-utils';
import { ProviderChainEditor } from './ProviderChainEditor';
import type { ProviderEntryState } from './ProviderEntry';

// ─── Mock fetch for useValidateProvider inside ProviderEntry ────
// Also covers the useAvailableKeys fetch (returns empty keys by default)

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: {} }),
});
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ───────────────────────────────────────────────────

function renderWithQuery(ui: React.ReactElement) {
  const client = createTestQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function createEntry(overrides: Partial<ProviderEntryState> = {}): ProviderEntryState {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'sk-test',
    availableModels: ['claude-sonnet-4-20250514'],
    hasExistingKey: false,
    validated: true,
    ...overrides,
  };
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('ProviderChainEditor', () => {
  it('renders empty state with "Add Provider" button when chain is empty', () => {
    const onChange = vi.fn();
    renderWithQuery(<ProviderChainEditor chain={[]} onChange={onChange} />);

    expect(screen.getByText(/no providers configured/i)).toBeInTheDocument();
    expect(screen.getByText(/add provider/i)).toBeInTheDocument();
  });

  it('calls onChange with a new default entry when "Add Provider" is clicked', () => {
    const onChange = vi.fn();
    renderWithQuery(<ProviderChainEditor chain={[]} onChange={onChange} />);

    fireEvent.click(screen.getByText(/add provider/i));

    expect(onChange).toHaveBeenCalledOnce();
    const newChain = onChange.mock.calls[0]?.[0];
    expect(newChain).toHaveLength(1);
    expect(newChain[0].provider).toBeDefined();
  });

  it('renders provider entries when chain has items', () => {
    const onChange = vi.fn();
    const chain = [createEntry({ provider: 'anthropic' }), createEntry({ provider: 'openai' })];

    renderWithQuery(<ProviderChainEditor chain={chain} onChange={onChange} />);

    // Should show "Primary" and "Fallback" labels
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Fallback')).toBeInTheDocument();
  });

  it('shows "Add Fallback Provider" button when chain has fewer than 5 entries', () => {
    const onChange = vi.fn();
    const chain = [createEntry()];

    renderWithQuery(<ProviderChainEditor chain={chain} onChange={onChange} />);

    expect(screen.getByText(/add fallback provider/i)).toBeInTheDocument();
  });

  it('propagates availableKeys to child ProviderEntry components', () => {
    const onChange = vi.fn();
    const availableKeys: AvailableKeysMap = {
      openai: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    const chain = [
      createEntry({ provider: 'openai', hasExistingKey: false, apiKey: '', validated: false }),
    ];

    renderWithQuery(
      <ProviderChainEditor chain={chain} onChange={onChange} availableKeys={availableKeys} />,
    );

    // The key selector should appear because a saved key exists for 'openai'
    expect(screen.getByRole('combobox', { name: /select a saved api key/i })).toBeInTheDocument();
  });
});
