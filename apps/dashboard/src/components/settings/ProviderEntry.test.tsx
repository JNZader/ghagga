/**
 * ProviderEntry component tests.
 *
 * Tests rendering of the provider radio selector (gateway / cli-bridge / ollama),
 * credential inputs, validation flow, model selection, key-reuse selector,
 * and reorder controls.
 *
 * The component was refactored from a dropdown of legacy providers
 * (anthropic / openai / github / etc.) to a 3-radio-button UI matching the
 * current `SaaSProvider` union: 'gateway' | 'cli-bridge' | 'ollama'.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
    id: 'entry-0',
    provider: 'gateway',
    model: 'auto',
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
  options: { index?: number; totalEntries?: number } = {},
) {
  return renderWithQuery(
    <ProviderEntry
      index={options.index ?? 0}
      entry={entry}
      totalEntries={options.totalEntries ?? 1}
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

describe('ProviderEntry — provider selector (radio buttons)', () => {
  it('renders three radio options: LLM Gateway, Local CLI, Ollama', () => {
    renderEntry(createEntry({ provider: 'gateway' }));

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);

    expect(screen.getByLabelText(/llm gateway/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/local cli/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ollama/i)).toBeInTheDocument();
  });

  it('marks the gateway radio checked when provider is gateway', () => {
    renderEntry(createEntry({ provider: 'gateway' }));

    expect(screen.getByLabelText(/llm gateway/i)).toBeChecked();
    expect(screen.getByLabelText(/local cli/i)).not.toBeChecked();
    expect(screen.getByLabelText(/ollama/i)).not.toBeChecked();
  });

  it('marks the cli-bridge radio checked when provider is cli-bridge', () => {
    renderEntry(createEntry({ provider: 'cli-bridge', model: 'auto' }));

    expect(screen.getByLabelText(/local cli/i)).toBeChecked();
  });

  it('marks the ollama radio checked when provider is ollama', () => {
    renderEntry(createEntry({ provider: 'ollama', model: '' }));

    expect(screen.getByLabelText(/ollama/i)).toBeChecked();
  });

  it('calls onChange with provider=ollama when the ollama radio is selected', () => {
    const onChange = vi.fn();
    renderEntry(createEntry({ provider: 'gateway' }), onChange);

    fireEvent.click(screen.getByLabelText(/ollama/i));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].provider).toBe('ollama');
  });

  it('calls onChange with provider=cli-bridge when the Local CLI radio is selected', () => {
    const onChange = vi.fn();
    renderEntry(createEntry({ provider: 'gateway' }), onChange);

    fireEvent.click(screen.getByLabelText(/local cli/i));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].provider).toBe('cli-bridge');
  });
});

describe('ProviderEntry — gateway provider', () => {
  it('shows Gateway URL and Gateway Token inputs', () => {
    renderEntry(createEntry({ provider: 'gateway', model: 'auto' }));

    expect(screen.getByLabelText(/gateway url/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
  });

  it('renders a "Validate" button that is disabled when no API key and no existing key', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: '', hasExistingKey: false }));

    const button = screen.getByRole('button', { name: /validate/i });
    expect(button).toBeDisabled();
  });

  it('renders an enabled "Validate" button when an API key has been entered', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: 'sk-test' }));

    const button = screen.getByRole('button', { name: /validate/i });
    expect(button).toBeEnabled();
  });

  it('shows the validated status message when entry.validated is true', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: 'sk-test', validated: true }));

    // The button flips its label and the inline status note is rendered below.
    expect(screen.getByText(/gateway token validated successfully/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /valid/i })).toBeInTheDocument();
  });
});

describe('ProviderEntry — cli-bridge provider', () => {
  it('renders the CLI tool dropdown with the expected options', () => {
    const { container } = renderEntry(
      createEntry({ provider: 'cli-bridge', model: 'auto', validated: true }),
    );

    // The CLI tool selector is the only native <select> in the component
    // (a hidden datalist-backed input has role="combobox" but is not a <select>).
    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    if (!select) return;

    expect(within(select).getByRole('option', { name: /auto-detect/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /opencode/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /copilot/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /gemini/i })).toBeInTheDocument();
  });

  it('shows the OpenCode model input when the opencode CLI is selected', () => {
    renderEntry(createEntry({ provider: 'cli-bridge', model: 'opencode' }));

    expect(screen.getByLabelText(/opencode model/i)).toBeInTheDocument();
  });

  it('warns when opencode is selected but cliModel is missing', () => {
    renderEntry(createEntry({ provider: 'cli-bridge', model: 'opencode', cliModel: '' }));

    expect(screen.getByText(/model is required when using opencode/i)).toBeInTheDocument();
  });

  it('shows the free-model banner for opencode/* models', () => {
    renderEntry(
      createEntry({
        provider: 'cli-bridge',
        model: 'opencode',
        cliModel: 'opencode/gpt-5-nano',
        validated: true,
      }),
    );

    expect(screen.getByText(/free model/i)).toBeInTheDocument();
  });
});

describe('ProviderEntry — ollama provider', () => {
  it('renders a free-text model input with suggestions', () => {
    renderEntry(createEntry({ provider: 'ollama', model: '' }));

    expect(
      screen.getByPlaceholderText(/llama3, codellama, qwen2\.5-coder/i),
    ).toBeInTheDocument();
  });

  it('hides the API-key block for the keyless ollama provider', () => {
    const { container } = renderEntry(createEntry({ provider: 'ollama', model: '' }));

    // The credential block keeps its DOM but adds the `hidden` class for ollama
    // (and for free opencode models). The contract: every password input is
    // inside a hidden container, so the credential UI is invisible.
    const passwordInputs = container.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBeGreaterThan(0);
    passwordInputs.forEach((input) => {
      const hiddenAncestor = input.closest('.hidden');
      expect(hiddenAncestor).not.toBeNull();
    });
  });

  it('propagates ollama model changes via onChange', () => {
    const onChange = vi.fn();
    renderEntry(createEntry({ provider: 'ollama', model: '' }), onChange);

    fireEvent.change(screen.getByPlaceholderText(/llama3, codellama/i), {
      target: { value: 'codellama' },
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].model).toBe('codellama');
  });
});

describe('ProviderEntry — index labels and reorder controls', () => {
  it('shows "Primary" label for the first entry (index 0)', () => {
    renderEntry(createEntry(), noop, {}, { index: 0 });
    expect(screen.getByText('Primary')).toBeInTheDocument();
  });

  it('shows "Fallback" label for non-primary entries', () => {
    renderEntry(createEntry(), noop, {}, { index: 1, totalEntries: 2 });
    expect(screen.getByText('Fallback')).toBeInTheDocument();
  });

  it('hides reorder controls when there is only one entry', () => {
    renderEntry(createEntry(), noop, {}, { index: 0, totalEntries: 1 });

    expect(screen.queryByTitle('Move up')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Move down')).not.toBeInTheDocument();
  });

  it('shows reorder controls when there are multiple entries', () => {
    renderEntry(createEntry(), noop, {}, { index: 0, totalEntries: 2 });

    expect(screen.getByTitle('Move up')).toBeInTheDocument();
    expect(screen.getByTitle('Move down')).toBeInTheDocument();
  });
});

// ── Key-reuse selector (saved keys from installation/global settings) ──

describe('ProviderEntry — key-reuse selector', () => {
  it('shows the key selector button when a saved key exists for the gateway provider', () => {
    const availableKeys: AvailableKeysMap = {
      gateway: { maskedApiKey: 'sk-...wxyz', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'gateway' }), noop, availableKeys);

    // Should render a button with the masked key, NOT the password input
    expect(screen.getByText(/sk-\.\.\.wxyz.*click to use/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter gateway bearer token/i)).not.toBeInTheDocument();
  });

  it('shows "Use a different key" toggle when a saved key is available', () => {
    const availableKeys: AvailableKeysMap = {
      gateway: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'gateway' }), noop, availableKeys);

    expect(screen.getByText(/use a different key/i)).toBeInTheDocument();
  });

  it('switches to manual input when "Use a different key" is clicked', () => {
    const availableKeys: AvailableKeysMap = {
      gateway: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'gateway' }), noop, availableKeys);

    fireEvent.click(screen.getByText(/use a different key/i));

    // After switching, the password input should be visible
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();
  });

  it('calls onChange with hasExistingKey=true when the saved-key button is clicked', () => {
    const onChange = vi.fn();
    const availableKeys: AvailableKeysMap = {
      gateway: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'gateway' }), onChange, availableKeys);

    // Click the "click to use" button — it contains the masked key
    fireEvent.click(screen.getByText(/sk-\.\.\.abcd.*click to use/i));

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0]?.[0] as ProviderEntryState;
    expect(updated.hasExistingKey).toBe(true);
    expect(updated.maskedApiKey).toBe('sk-...abcd');
    expect(updated.apiKey).toBe(''); // key is NOT exposed to the frontend
    expect(updated.validated).toBe(true);
    expect(updated.availableModels.length).toBeGreaterThan(0);
  });

  it('does NOT show the key selector when the entry already has its own saved key', () => {
    const availableKeys: AvailableKeysMap = {
      gateway: { maskedApiKey: 'sk-...abcd', source: 'global' },
    };
    renderEntry(
      createEntry({ provider: 'gateway', hasExistingKey: true, maskedApiKey: 'sk-...repo' }),
      noop,
      availableKeys,
    );

    // The reuse button must not appear — the entry already has a key of its own
    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();
    // The password input shows the repo's own masked key as placeholder
    expect(screen.getByPlaceholderText('sk-...repo')).toBeInTheDocument();
  });

  it('does NOT show the key selector when no saved key exists for the current provider', () => {
    const availableKeys: AvailableKeysMap = {
      'cli-bridge': { maskedApiKey: 'token-...wxyz', source: 'global' },
    };
    // gateway entry but only cli-bridge has a saved key
    renderEntry(createEntry({ provider: 'gateway' }), noop, availableKeys);

    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
  });
});
