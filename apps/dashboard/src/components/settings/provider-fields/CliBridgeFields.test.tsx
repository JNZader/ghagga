/**
 * CliBridgeFields component tests.
 *
 * Covers the CLI-bridge specific surface:
 *   - CLI tool selector (Auto / OpenCode / Copilot / Gemini)
 *   - OpenCode model input + missing/invalid format warnings
 *   - Contextual help text per tool
 *   - Free-model banner for opencode/* models
 *
 * Coverage gaps closed (per PR #185-#188 review backlog):
 *   - cliModel invalid-format warning (`"badformat"` triggers yellow warning)
 *   - CLI tool change propagates via onCliToolChange (caller handles reset)
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntryState } from '../ProviderEntry';
import { CliBridgeFields } from './CliBridgeFields';

function createEntry(overrides: Partial<ProviderEntryState> = {}): ProviderEntryState {
  return {
    id: 'entry-0',
    provider: 'cli-bridge',
    model: 'auto',
    apiKey: '',
    availableModels: [],
    hasExistingKey: false,
    validated: true,
    ...overrides,
  };
}

function renderFields(
  entry: ProviderEntryState,
  onCliToolChange = vi.fn(),
  onCliModelChange = vi.fn(),
  index = 0,
) {
  return render(
    <CliBridgeFields
      index={index}
      entry={entry}
      onCliToolChange={onCliToolChange}
      onCliModelChange={onCliModelChange}
    />,
  );
}

describe('CliBridgeFields — CLI tool selector', () => {
  it('renders the four CLI options (auto, opencode, copilot, gemini)', () => {
    const { container } = renderFields(createEntry());

    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    if (!select) return;

    expect(within(select).getByRole('option', { name: /auto-detect/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /opencode/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /copilot/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /gemini/i })).toBeInTheDocument();
  });

  it('shows the currently selected CLI tool in the select', () => {
    const { container } = renderFields(createEntry({ model: 'opencode' }));

    expect(container.querySelector('select')?.value).toBe('opencode');
  });

  // Coverage gap: CLI tool change propagates via onCliToolChange so the
  // parent can reset cliModel + apiKey + validated state.
  it('calls onCliToolChange with the new tool when the user picks a different CLI', () => {
    const onCliToolChange = vi.fn();
    const { container } = renderFields(createEntry({ model: 'auto' }), onCliToolChange);

    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    if (!select) return;

    fireEvent.change(select, { target: { value: 'opencode' } });

    expect(onCliToolChange).toHaveBeenCalledOnce();
    expect(onCliToolChange).toHaveBeenCalledWith('opencode');
  });
});

describe('CliBridgeFields — OpenCode model input', () => {
  it('renders the OpenCode model input only when CLI tool is opencode', () => {
    const { rerender } = renderFields(createEntry({ model: 'auto' }));
    expect(screen.queryByLabelText(/opencode model/i)).not.toBeInTheDocument();

    rerender(
      <CliBridgeFields
        index={0}
        entry={createEntry({ model: 'opencode' })}
        onCliToolChange={vi.fn()}
        onCliModelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/opencode model/i)).toBeInTheDocument();
  });

  it('warns when opencode is selected but cliModel is empty (missing)', () => {
    renderFields(createEntry({ model: 'opencode', cliModel: '' }));

    expect(screen.getByText(/model is required when using opencode/i)).toBeInTheDocument();
  });

  // Coverage gap: invalid-format warning was untested before.
  it('warns when cliModel is set but does not match provider/model format', () => {
    renderFields(createEntry({ model: 'opencode', cliModel: 'badformat' }));

    expect(screen.getByText(/expected format/i)).toBeInTheDocument();
    // Missing-model warning must NOT show when a value is present
    expect(screen.queryByText(/model is required when using opencode/i)).not.toBeInTheDocument();
  });

  it('does NOT warn when cliModel matches provider/model format', () => {
    renderFields(
      createEntry({ model: 'opencode', cliModel: 'anthropic/claude-sonnet-4-5' }),
    );

    expect(screen.queryByText(/expected format/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/model is required when using opencode/i)).not.toBeInTheDocument();
  });

  it('calls onCliModelChange with the new value when the user types', () => {
    const onCliModelChange = vi.fn();
    renderFields(
      createEntry({ model: 'opencode', cliModel: '' }),
      vi.fn(),
      onCliModelChange,
    );

    fireEvent.change(screen.getByLabelText(/opencode model/i), {
      target: { value: 'openai/gpt-5-codex' },
    });

    expect(onCliModelChange).toHaveBeenCalledOnce();
    expect(onCliModelChange).toHaveBeenCalledWith('openai/gpt-5-codex');
  });
});

describe('CliBridgeFields — contextual help', () => {
  it('shows the opencode-specific help when CLI tool is opencode', () => {
    renderFields(createEntry({ model: 'opencode', cliModel: '' }));

    expect(
      screen.getByText(/models prefixed with opencode\/ are free/i),
    ).toBeInTheDocument();
  });

  it('shows the gemini-specific help when CLI tool is gemini', () => {
    renderFields(createEntry({ model: 'gemini' }));

    expect(screen.getByText(/provide a gemini api key/i)).toBeInTheDocument();
  });
});

describe('CliBridgeFields — free-model banner', () => {
  it('shows the free-model banner for opencode/* models', () => {
    renderFields(
      createEntry({ model: 'opencode', cliModel: 'opencode/gpt-5-nano', validated: true }),
    );

    expect(screen.getByText(/free model/i)).toBeInTheDocument();
    expect(screen.getByText(/no api key required/i)).toBeInTheDocument();
  });

  it('does NOT show the free-model banner for paid opencode providers', () => {
    renderFields(
      createEntry({
        model: 'opencode',
        cliModel: 'anthropic/claude-sonnet-4-5',
        validated: true,
      }),
    );

    expect(screen.queryByText(/no api key required/i)).not.toBeInTheDocument();
  });
});
