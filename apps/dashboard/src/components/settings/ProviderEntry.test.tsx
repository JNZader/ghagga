/**
 * ProviderEntry component tests.
 *
 * Tests rendering of provider dropdown, API key input,
 * validation button states, model selection, and the key selector.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableKeysMap } from '@/lib/api';
import { createTestQueryClient } from '@/test/test-utils';
import { ProviderEntry, type ProviderEntryState } from './ProviderEntry';

// ─── Mock fetch for useValidateProvider ─────────────────────────

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
    model: '',
    apiKey: '',
    availableModels: [],
    hasExistingKey: false,
    validated: false,
    ...overrides,
  };
}

const noop = vi.fn();

function renderEntry(
  entry: ProviderEntryState,
  onChange = noop,
  availableKeys: AvailableKeysMap = {},
) {
  return renderWithQuery(
    <ProviderEntry
      index={0}
      entry={entry}
      totalEntries={1}
      availableKeys={availableKeys}
      onChange={onChange}
      onRemove={noop}
      onMoveUp={noop}
      onMoveDown={noop}
    />,
  );
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('ProviderEntry', () => {
  it('renders provider dropdown with correct options', () => {
    renderEntry(createEntry());

    const select = screen.getByDisplayValue('Anthropic');
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe('SELECT');
  });

  it('renders API key input for non-GitHub providers (no saved keys)', () => {
    renderEntry(createEntry({ provider: 'anthropic' }));

    const input = screen.getByPlaceholderText(/enter api key/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'password');
  });

  it('shows GitHub Models disclaimer instead of API key input for GitHub provider', () => {
    renderEntry(createEntry({ provider: 'github' }));

    expect(screen.getByText(/github models is not available/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter api key/i)).not.toBeInTheDocument();
  });

  it('shows "Validate" button that is disabled when apiKey is empty', () => {
    renderEntry(createEntry({ provider: 'openai', apiKey: '' }));

    const button = screen.getByRole('button', { name: /validate/i });
    expect(button).toBeDisabled();
  });

  it('shows "Valid ✓" text when entry is validated', () => {
    renderEntry(createEntry({ provider: 'openai', apiKey: 'sk-test', validated: true }));

    expect(screen.getByText(/valid ✓/i)).toBeInTheDocument();
  });

  it('renders model dropdown when availableModels are present', () => {
    renderEntry(
      createEntry({
        provider: 'openai',
        validated: true,
        availableModels: ['gpt-4o', 'gpt-4o-mini'],
        model: 'gpt-4o',
      }),
    );

    const modelSelect = screen.getByDisplayValue('gpt-4o');
    expect(modelSelect).toBeInTheDocument();
  });

  it('shows "Primary" label for index 0', () => {
    renderEntry(createEntry());
    expect(screen.getByText('Primary')).toBeInTheDocument();
  });

  it('calls onChange when provider dropdown changes', () => {
    const onChange = vi.fn();
    renderEntry(createEntry({ provider: 'anthropic' }), onChange);

    const select = screen.getByDisplayValue('Anthropic');
    fireEvent.change(select, { target: { value: 'openai' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].provider).toBe('openai');
  });

  // ── Key Selector (Bug 1) ──────────────────────────────────────

  it('shows key selector dropdown when a saved key exists for the provider', () => {
    const availableKeys: AvailableKeysMap = {
      anthropic: { maskedApiKey: 'sk-...wxyz', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'anthropic' }), noop, availableKeys);

    // Should render a <select> with the saved key option, not the password input
    expect(screen.getByRole('combobox', { name: /select a saved api key/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter api key/i)).not.toBeInTheDocument();
  });

  it('shows "Use a different key" toggle when saved key is available', () => {
    const availableKeys: AvailableKeysMap = {
      openai: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'openai' }), noop, availableKeys);

    expect(screen.getByText(/use a different key/i)).toBeInTheDocument();
  });

  it('switches to manual input when "Use a different key" is clicked', () => {
    const availableKeys: AvailableKeysMap = {
      openai: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'openai' }), noop, availableKeys);

    fireEvent.click(screen.getByText(/use a different key/i));

    // After switching, the password input should be visible
    expect(screen.getByPlaceholderText(/enter api key/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: /select a saved api key/i }),
    ).not.toBeInTheDocument();
  });

  it('calls onChange with hasExistingKey=true when a saved key is selected', () => {
    const onChange = vi.fn();
    const availableKeys: AvailableKeysMap = {
      openai: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'openai' }), onChange, availableKeys);

    const selector = screen.getByRole('combobox', { name: /select a saved api key/i });
    fireEvent.change(selector, { target: { value: 'openai' } });

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0]?.[0] as ProviderEntryState;
    expect(updated.hasExistingKey).toBe(true);
    expect(updated.maskedApiKey).toBe('sk-...abcd');
    expect(updated.apiKey).toBe(''); // key is NOT exposed to the frontend
  });

  it('does NOT show key selector when entry already has its own key (hasExistingKey=true)', () => {
    const availableKeys: AvailableKeysMap = {
      openai: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(
      createEntry({ provider: 'openai', hasExistingKey: true, maskedApiKey: 'sk-...repo' }),
      noop,
      availableKeys,
    );

    // Should show the manual input (not the selector) — placeholder uses the maskedApiKey
    expect(
      screen.queryByRole('combobox', { name: /select a saved api key/i }),
    ).not.toBeInTheDocument();
    // The password input shows the repo's own masked key as placeholder
    expect(screen.getByPlaceholderText('sk-...repo')).toBeInTheDocument();
  });

  it('does NOT show key selector when no saved key exists for the provider', () => {
    const availableKeys: AvailableKeysMap = {
      anthropic: { maskedApiKey: 'sk-...wxyz', source: 'global' },
    };
    // openai entry but only anthropic is in availableKeys
    renderEntry(createEntry({ provider: 'openai' }), noop, availableKeys);

    expect(
      screen.queryByRole('combobox', { name: /select a saved api key/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter api key/i)).toBeInTheDocument();
  });
});
