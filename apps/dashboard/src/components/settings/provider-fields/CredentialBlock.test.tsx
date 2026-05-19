/**
 * CredentialBlock component tests.
 *
 * Covers the credential UI in isolation: label rendering (Gateway / CLI /
 * Ollama variants), the saved-key reuse selector, the toggle button, the
 * password input placeholders, the Validate button states, and the
 * validation status messages.
 *
 * The parent (ProviderEntry) owns the validation flow (useValidateProvider)
 * and passes the `validationError`, `isPending`, `canValidate`, and
 * `onValidate` props. Integration tests for the parent-driven validate flow
 * live in ProviderEntry.test.tsx — this file exercises the subcomponent
 * with controlled props.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AvailableKeysMap } from '@/lib/api';
import type { ProviderEntryState } from '../ProviderEntry';
import { CredentialBlock, type CredentialBlockProps } from './CredentialBlock';

// ─── Helpers ───────────────────────────────────────────────────

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

function renderBlock(props: Partial<CredentialBlockProps> = {}) {
  const defaults: CredentialBlockProps = {
    index: 0,
    entry: createEntry(),
    availableKeys: {},
    isPending: false,
    canValidate: false,
    validationError: null,
    onApiKeyChange: vi.fn(),
    onChange: vi.fn(),
    onValidate: vi.fn(),
  };
  return render(<CredentialBlock {...defaults} {...props} />);
}

// ─── Tests ─────────────────────────────────────────────────────

describe('CredentialBlock — credential label', () => {
  it('renders "Gateway Token" label for gateway provider', () => {
    renderBlock({ entry: createEntry({ provider: 'gateway' }) });
    expect(screen.getByText('Gateway Token')).toBeInTheDocument();
  });

  it('renders "API Key" label for cli-bridge with no cliModel (defaults to Provider API Key)', () => {
    renderBlock({ entry: createEntry({ provider: 'cli-bridge', model: 'auto' }) });
    // cli-bridge + auto → "API Key (optional)" per getCliCredentialLabel
    expect(screen.getByText(/api key/i)).toBeInTheDocument();
  });

  it('renders provider-specific label for cli-bridge + opencode + cliModel', () => {
    renderBlock({
      entry: createEntry({
        provider: 'cli-bridge',
        model: 'opencode',
        cliModel: 'anthropic/claude-sonnet-4-5',
      }),
    });
    expect(screen.getByText('Anthropic API Key')).toBeInTheDocument();
  });
});

describe('CredentialBlock — validate button', () => {
  it('disables Validate when canValidate=false', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      canValidate: false,
    });
    expect(screen.getByRole('button', { name: /validate/i })).toBeDisabled();
  });

  it('enables Validate when canValidate=true', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway', apiKey: 'sk-test' }),
      canValidate: true,
    });
    expect(screen.getByRole('button', { name: /validate/i })).toBeEnabled();
  });

  it('shows "Checking..." while isPending=true', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway', apiKey: 'sk-test' }),
      canValidate: true,
      isPending: true,
    });
    const btn = screen.getByRole('button', { name: /checking/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('shows "Valid ✓" when entry.validated=true', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway', apiKey: 'sk-test', validated: true }),
      canValidate: true,
    });
    expect(screen.getByRole('button', { name: /valid/i })).toBeInTheDocument();
  });

  it('calls onValidate when Validate is clicked', () => {
    const onValidate = vi.fn();
    renderBlock({
      entry: createEntry({ provider: 'gateway', apiKey: 'sk-test' }),
      canValidate: true,
      onValidate,
    });
    fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    expect(onValidate).toHaveBeenCalledOnce();
  });

  it('does NOT render a Validate button for cli-bridge (manual-input branch, no saved key)', () => {
    renderBlock({
      entry: createEntry({ provider: 'cli-bridge', model: 'gemini' }),
      canValidate: true,
    });
    // cli-bridge has no validation flow for the credential itself — the
    // Validate button is gateway-only in the manual-input branch.
    expect(
      screen.queryByRole('button', { name: /validate|valid|checking/i }),
    ).not.toBeInTheDocument();
  });
});

describe('CredentialBlock — password input', () => {
  it('shows gateway-specific placeholder when no existing key', () => {
    renderBlock({ entry: createEntry({ provider: 'gateway' }) });
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
  });

  it('shows cli-bridge-specific placeholder derived from credential label', () => {
    renderBlock({
      entry: createEntry({ provider: 'cli-bridge', model: 'gemini' }),
    });
    // gemini → "Gemini API Key" → lowercased into placeholder
    expect(screen.getByPlaceholderText(/enter gemini api key/i)).toBeInTheDocument();
  });

  it('shows the masked existing key as placeholder when hasExistingKey=true', () => {
    renderBlock({
      entry: createEntry({
        provider: 'gateway',
        hasExistingKey: true,
        maskedApiKey: 'sk-...abcd',
      }),
    });
    expect(screen.getByPlaceholderText('sk-...abcd')).toBeInTheDocument();
  });

  it('calls onApiKeyChange when the user types', () => {
    const onApiKeyChange = vi.fn();
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      onApiKeyChange,
    });
    fireEvent.change(screen.getByPlaceholderText(/enter gateway bearer token/i), {
      target: { value: 'sk-new' },
    });
    expect(onApiKeyChange).toHaveBeenCalledOnce();
    expect(onApiKeyChange).toHaveBeenCalledWith('sk-new');
  });
});

describe('CredentialBlock — saved-key reuse selector', () => {
  const availableKeys: AvailableKeysMap = {
    gateway: { maskedApiKey: 'sk-...wxyz', source: 'global' },
  };

  it('shows the masked-key button when a saved key exists for the provider', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      availableKeys,
    });
    expect(screen.getByText(/sk-\.\.\.wxyz.*click to use/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter gateway bearer token/i)).not.toBeInTheDocument();
  });

  it('calls onChange with hasExistingKey=true when the saved-key button is clicked', () => {
    const onChange = vi.fn<(entry: ProviderEntryState) => void>();
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      availableKeys,
      onChange,
    });

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

  it('toggles between reuse and new key entry modes on the "Use ..." button', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      availableKeys,
    });

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

  it('does NOT show the saved-key selector when no saved key matches the provider', () => {
    const otherProviderKeys: AvailableKeysMap = {
      'cli-bridge': { maskedApiKey: 'token-...xyz', source: 'global' },
    };
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      availableKeys: otherProviderKeys,
    });

    expect(screen.queryByText(/click to use/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter gateway bearer token/i)).toBeInTheDocument();
  });

  it('hides the toggle button for cli-bridge even when a saved key exists', () => {
    // CLI Bridge tokens don't go through the reuse-vs-new flow — the toggle
    // button (showReuseSelector && !isCLIBridge) is intentionally hidden.
    const cliKeys: AvailableKeysMap = {
      'cli-bridge': { maskedApiKey: 'token-...xyz', source: 'global' },
    };
    renderBlock({
      entry: createEntry({ provider: 'cli-bridge', model: 'gemini' }),
      availableKeys: cliKeys,
    });
    expect(screen.queryByText(/use a different key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/use saved key/i)).not.toBeInTheDocument();
  });

  it('hides the toggle button when there is no saved key for the provider', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      availableKeys: {},
    });
    expect(screen.queryByText(/use a different key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/use saved key/i)).not.toBeInTheDocument();
  });
});

describe('CredentialBlock — validation status messages', () => {
  it('renders the validation error message when validationError is set', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway' }),
      validationError: 'Invalid bearer token',
    });
    expect(screen.getByText('Invalid bearer token')).toBeInTheDocument();
  });

  it('renders the gateway success message when validated=true and no error', () => {
    renderBlock({
      entry: createEntry({ provider: 'gateway', apiKey: 'sk-test', validated: true }),
    });
    expect(screen.getByText(/gateway token validated successfully/i)).toBeInTheDocument();
  });

  it('renders the existing-key-preserved hint when hasExistingKey but no new key typed', () => {
    renderBlock({
      entry: createEntry({
        provider: 'gateway',
        hasExistingKey: true,
        maskedApiKey: 'sk-...wxyz',
        apiKey: '',
        validated: false,
      }),
    });
    expect(
      screen.getByText(/existing key will be preserved.*enter a new key to replace/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the success message for non-gateway providers even when validated=true', () => {
    renderBlock({
      entry: createEntry({
        provider: 'cli-bridge',
        model: 'opencode',
        cliModel: 'anthropic/claude-sonnet-4-5',
        apiKey: 'sk-test',
        validated: true,
      }),
    });
    expect(screen.queryByText(/validated successfully/i)).not.toBeInTheDocument();
  });
});
