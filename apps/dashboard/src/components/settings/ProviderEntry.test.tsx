/**
 * ProviderEntry component tests — wrapper logic only.
 *
 * After the phase-1..4 refactor, the per-provider field UI lives in
 * provider-fields/{OllamaFields,CliBridgeFields,GatewayFields}.tsx with
 * dedicated test files. This file exercises the orchestrator: the radio
 * selector, header (index + reorder + remove), validation flow, and the
 * key-reuse selector that wraps the credential block.
 *
 * Coverage gaps closed here (per PR #185-#188 review backlog):
 *   - Move-up / move-down callback wiring
 *   - Validate button async flow (mock mutation → success + error states)
 *   - "Use saved key" reverse toggle (new → reuse round-trip)
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableKeysMap } from '@/lib/api';
import { createTestQueryClient } from '@/test/test-utils';
import { ProviderEntry, type ProviderEntryState } from './ProviderEntry';

// ─── Mock fetch + localStorage for useValidateProvider ──────────
//
// Stubbed at module top so the bindings are in place before the component
// imports `fetchApi` from '@/lib/api'. fetchApi calls
// `localStorage.getItem('ghagga_token')`, and Vitest 4 + jsdom 29 does not
// always provide a working localStorage — so we stub both. The stubs are
// re-installed in `beforeEach` so the `afterEach(vi.unstubAllGlobals)` cleanup
// (added to prevent cross-file pollution when Vitest reuses workers) does not
// leave subsequent tests in this file without bindings.

const mockFetch = vi.fn();
const mockLocalStorage = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
vi.stubGlobal('fetch', mockFetch);
vi.stubGlobal('localStorage', mockLocalStorage);

/** Make fetch resolve with the given validation response body. */
function mockValidationOk(body: { valid: boolean; models?: string[]; error?: string }) {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

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
  callbacks: Partial<{
    onChange: typeof noop;
    onRemove: typeof noop;
    onMoveUp: typeof noop;
    onMoveDown: typeof noop;
  }> = {},
  availableKeys: AvailableKeysMap = {},
  options: { index?: number; totalEntries?: number } = {},
) {
  return renderWithQuery(
    <ProviderEntry
      index={options.index ?? 0}
      entry={entry}
      totalEntries={options.totalEntries ?? 1}
      availableKeys={availableKeys}
      onChange={callbacks.onChange ?? noop}
      onRemove={callbacks.onRemove ?? noop}
      onMoveUp={callbacks.onMoveUp ?? noop}
      onMoveDown={callbacks.onMoveDown ?? noop}
    />,
  );
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-install module-level stubs because `afterEach(vi.unstubAllGlobals)`
  // wipes them between tests. Matches the pattern in src/lib/api.test.ts.
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('localStorage', mockLocalStorage);
  // Default fetch response — most tests do not exercise validation, but the
  // mock must always resolve to avoid promise hangs if validate is triggered.
  mockValidationOk({ valid: true, models: [] });
});

afterEach(() => {
  // Clear the vi.stubGlobal bindings so they don't leak across files when
  // Vitest reuses the worker. Matches the pattern in src/lib/api.test.ts.
  vi.unstubAllGlobals();
});

// ─── Tests ─────────────────────────────────────────────────────

describe('ProviderEntry — provider selector', () => {
  it('renders three radio options (Gateway, Local CLI, Ollama)', () => {
    renderEntry(createEntry({ provider: 'gateway' }));

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByLabelText(/llm gateway/i)).toBeChecked();
    expect(screen.getByLabelText(/local cli/i)).not.toBeChecked();
    expect(screen.getByLabelText(/ollama/i)).not.toBeChecked();
  });

  it('propagates provider=ollama via onChange and resets transient state', () => {
    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderEntry(createEntry({ provider: 'gateway', apiKey: 'sk-test' }), { onChange });

    fireEvent.click(screen.getByLabelText(/ollama/i));

    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.provider).toBe('ollama');
    expect(next.apiKey).toBe('');
    expect(next.model).toBe('');
    expect(next.validated).toBe(false);
  });

  it('propagates provider=cli-bridge and starts the entry pre-validated', () => {
    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderEntry(createEntry({ provider: 'gateway' }), { onChange });

    fireEvent.click(screen.getByLabelText(/local cli/i));

    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.provider).toBe('cli-bridge');
    expect(next.model).toBe('auto');
    // cli-bridge starts validated=true because there's no validation flow for the
    // default tool; opencode flips it back to false via the CLI tool selector.
    expect(next.validated).toBe(true);
  });
});

describe('ProviderEntry — cli-bridge tool switching', () => {
  // Coverage gap: CliBridgeFields.test.tsx verifies the onCliToolChange callback
  // is invoked, but never asserts the PARENT reset (handleCliToolChange in
  // ProviderEntry.tsx:135-145). Switching the CLI tool must wipe tool-specific
  // credentials and recompute `validated` based on the new tool.
  it('resets cliModel, apiKey, hasExistingKey, maskedApiKey and recomputes validated when the CLI tool changes', () => {
    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    const { container } = renderEntry(
      createEntry({
        provider: 'cli-bridge',
        model: 'opencode',
        cliModel: 'anthropic/claude-3-7-sonnet-20250219',
        apiKey: 'some-key',
        hasExistingKey: true,
        maskedApiKey: 'sk-...wxyz',
        validated: true,
      }),
      { onChange },
    );

    // The CLI tool selector is the only <select> in the entry (the hidden
    // generic Model Selector also carries value='opencode' on its <input list>,
    // so `getByDisplayValue` is ambiguous — querying by tag is unambiguous).
    const cliToolSelect = container.querySelector('select');
    if (!cliToolSelect) throw new Error('CLI tool <select> not found');
    fireEvent.change(cliToolSelect, { target: { value: 'auto' } });

    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.model).toBe('auto');
    expect(next.cliModel).toBeUndefined();
    expect(next.apiKey).toBe('');
    expect(next.hasExistingKey).toBe(false);
    expect(next.maskedApiKey).toBeUndefined();
    // validated is `cliTool !== 'opencode'` — switching to 'auto' should validate.
    expect(next.validated).toBe(true);
  });
});

describe('ProviderEntry — header (index, reorder, remove)', () => {
  it('shows "Primary" for index 0 and "Fallback" otherwise', () => {
    const { rerender } = renderEntry(createEntry(), {}, {}, { index: 0 });
    expect(screen.getByText('Primary')).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderEntry
          index={1}
          entry={createEntry()}
          totalEntries={2}
          onChange={noop}
          onRemove={noop}
          onMoveUp={noop}
          onMoveDown={noop}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Fallback')).toBeInTheDocument();
  });

  it('hides reorder controls when there is only one entry', () => {
    renderEntry(createEntry(), {}, {}, { index: 0, totalEntries: 1 });
    expect(screen.queryByTitle('Move up')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Move down')).not.toBeInTheDocument();
  });

  // Coverage gap: move-up / move-down callbacks were rendered but never asserted.
  it('invokes onMoveUp / onMoveDown when the reorder buttons are clicked', () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    renderEntry(
      createEntry(),
      { onMoveUp, onMoveDown },
      {},
      { index: 1, totalEntries: 3 },
    );

    fireEvent.click(screen.getByTitle('Move up'));
    fireEvent.click(screen.getByTitle('Move down'));

    expect(onMoveUp).toHaveBeenCalledOnce();
    expect(onMoveDown).toHaveBeenCalledOnce();
  });

  it('invokes onRemove when the X button is clicked', () => {
    const onRemove = vi.fn();
    renderEntry(createEntry(), { onRemove });

    fireEvent.click(screen.getByTitle('Remove provider'));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe('ProviderEntry — credential block + validate button', () => {
  it('disables Validate when no API key and no existing key (gateway)', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: '', hasExistingKey: false }));

    expect(screen.getByRole('button', { name: /validate/i })).toBeDisabled();
  });

  it('enables Validate when an API key has been entered', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: 'sk-test' }));

    expect(screen.getByRole('button', { name: /validate/i })).toBeEnabled();
  });

  it('shows the validated status message when entry.validated is true', () => {
    renderEntry(createEntry({ provider: 'gateway', apiKey: 'sk-test', validated: true }));

    expect(screen.getByText(/gateway token validated successfully/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /valid/i })).toBeInTheDocument();
  });

  // Coverage gap: validate-button async success flow (mock mutation, click,
  // assert onChange called with availableModels + validated=true).
  it('calls onChange with availableModels + validated=true on successful validation', async () => {
    mockValidationOk({ valid: true, models: ['model-x', 'model-y'] });

    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderEntry(
      createEntry({ provider: 'gateway', apiKey: 'sk-good', gatewayUrl: 'https://gw.test' }),
      { onChange },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const next = onChange.mock.calls[0]?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.validated).toBe(true);
    expect(next.availableModels).toEqual(['model-x', 'model-y']);
  });

  // Coverage gap: validate-button async error flow shows the server-supplied
  // error message and sets validated=false.
  it('shows the server error and onChange with validated=false when validation fails', async () => {
    mockValidationOk({ valid: false, models: [], error: 'Invalid bearer token' });

    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderEntry(
      createEntry({ provider: 'gateway', apiKey: 'sk-bad', gatewayUrl: 'https://gw.test' }),
      { onChange },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid bearer token/i)).toBeInTheDocument();
    });
    const next = onChange.mock.calls.at(-1)?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.validated).toBe(false);
    expect(next.availableModels).toEqual([]);
  });
});

describe('ProviderEntry — key-reuse selector', () => {
  const availableKeys: AvailableKeysMap = {
    gateway: { maskedApiKey: 'sk-...wxyz', source: 'global' },
  };

  it('shows the masked-key button when a saved key exists for the provider', () => {
    renderEntry(createEntry({ provider: 'gateway' }), {}, availableKeys);

    expect(screen.getByText(/sk-\.\.\.wxyz.*click to use/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter gateway bearer token/i)).not.toBeInTheDocument();
  });

  it('calls onChange with hasExistingKey=true when the saved-key button is clicked', () => {
    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderEntry(createEntry({ provider: 'gateway' }), { onChange }, availableKeys);

    fireEvent.click(screen.getByText(/sk-\.\.\.wxyz.*click to use/i));

    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]?.[0];
    if (!next) throw new Error('onChange not called');
    expect(next.hasExistingKey).toBe(true);
    expect(next.maskedApiKey).toBe('sk-...wxyz');
    expect(next.apiKey).toBe('');
    expect(next.validated).toBe(true);
    expect(next.availableModels.length).toBeGreaterThan(0);
  });

  // Coverage gap: reverse-toggle. The user can switch reuse → new and back
  // to reuse without re-mounting the component.
  it('toggles between reuse and new key entry modes on the "Use ..." button', () => {
    renderEntry(createEntry({ provider: 'gateway' }), {}, availableKeys);

    // Initial: reuse mode — saved-key button visible, no password input.
    expect(screen.getByText(/click to use/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter gateway bearer token/i)).not.toBeInTheDocument();

    // Click "Use a different key" → switches to manual input mode.
    fireEvent.click(screen.getByText(/use a different key/i));
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();

    // Click "Use saved key" → switches back to reuse mode.
    fireEvent.click(screen.getByText(/use saved key/i));
    expect(screen.getByText(/click to use/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter gateway bearer token/i)).not.toBeInTheDocument();
  });

  it('does NOT show the key selector when no saved key matches the provider', () => {
    const otherProviderKeys: AvailableKeysMap = {
      'cli-bridge': { maskedApiKey: 'token-...xyz', source: 'global' },
    };
    renderEntry(createEntry({ provider: 'gateway' }), {}, otherProviderKeys);

    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
  });
});
