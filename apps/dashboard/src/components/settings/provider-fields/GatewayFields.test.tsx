/**
 * GatewayFields component tests.
 *
 * Covers the LLM Gateway URL input + model datalist. The validate button
 * and validation status messages live in the parent (ProviderEntry)
 * credential block, so they are tested there.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntryState } from '../ProviderEntry';
import { GatewayFields } from './GatewayFields';

function createEntry(overrides: Partial<ProviderEntryState> = {}): ProviderEntryState {
  return {
    id: 'entry-0',
    provider: 'gateway',
    model: 'auto',
    apiKey: '',
    availableModels: [],
    hasExistingKey: false,
    validated: false,
    gatewayUrl: '',
    ...overrides,
  };
}

function renderFields(
  entry: ProviderEntryState,
  onUrlChange = vi.fn(),
  onModelChange = vi.fn(),
  index = 0,
) {
  return render(
    <GatewayFields
      index={index}
      entry={entry}
      onUrlChange={onUrlChange}
      onModelChange={onModelChange}
    />,
  );
}

describe('GatewayFields — URL input', () => {
  it('renders the Gateway URL input with the expected placeholder', () => {
    renderFields(createEntry());

    expect(screen.getByLabelText(/gateway url/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/llm-gateway\.example\.com/i)).toBeInTheDocument();
  });

  it('shows the entry.gatewayUrl as the current input value', () => {
    renderFields(createEntry({ gatewayUrl: 'https://my-gateway.test' }));

    expect(screen.getByDisplayValue('https://my-gateway.test')).toBeInTheDocument();
  });

  it('calls onUrlChange with the new URL when the user types', () => {
    const onUrlChange = vi.fn();
    renderFields(createEntry(), onUrlChange);

    fireEvent.change(screen.getByLabelText(/gateway url/i), {
      target: { value: 'https://new-gw.example' },
    });

    expect(onUrlChange).toHaveBeenCalledOnce();
    expect(onUrlChange).toHaveBeenCalledWith('https://new-gw.example');
  });
});

describe('GatewayFields — Model input', () => {
  it('renders the Model input with the auto placeholder', () => {
    renderFields(createEntry());

    expect(screen.getByLabelText(/^model/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/auto \(gateway selects best available\)/i),
    ).toBeInTheDocument();
  });

  it('renders an empty value when entry.model is "auto"', () => {
    const { container } = renderFields(createEntry({ model: 'auto' }));

    const modelInput = container.querySelector('#gateway-model-0') as HTMLInputElement;
    expect(modelInput.value).toBe('');
  });

  it('renders the literal entry.model value when not "auto"', () => {
    renderFields(createEntry({ model: 'github-copilot/gpt-5-mini' }));

    expect(screen.getByDisplayValue('github-copilot/gpt-5-mini')).toBeInTheDocument();
  });

  it('calls onModelChange with the typed value', () => {
    const onModelChange = vi.fn();
    renderFields(createEntry(), vi.fn(), onModelChange);

    fireEvent.change(screen.getByLabelText(/^model/i), {
      target: { value: 'anthropic/claude-sonnet-4-5' },
    });

    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
  });

  it('calls onModelChange with an empty string when the user clears the input', () => {
    // The parent decides how to map empty -> 'auto'; the subcomponent just forwards.
    const onModelChange = vi.fn();
    renderFields(createEntry({ model: 'openai/gpt-5-codex' }), vi.fn(), onModelChange);

    fireEvent.change(screen.getByLabelText(/^model/i), {
      target: { value: '' },
    });

    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith('');
  });

  it('renders a datalist with the curated gateway model suggestions', () => {
    const { container } = renderFields(createEntry());

    const datalist = container.querySelector('datalist#gateway-models-0');
    expect(datalist).not.toBeNull();
    // Spot-check a couple of expected options
    expect(datalist?.querySelector('option[value="github-copilot/gpt-4o"]')).not.toBeNull();
    expect(datalist?.querySelector('option[value="anthropic/claude-sonnet-4-5"]')).not.toBeNull();
  });
});
