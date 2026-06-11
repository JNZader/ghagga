/**
 * OllamaFields component tests.
 *
 * Covers the Ollama-only model input rendered inside the provider-mode
 * block: the free-text input, suggestions datalist, and the onModelChange
 * callback wiring.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntryState } from '../ProviderEntry';
import { OllamaFields } from './OllamaFields';

function createEntry(overrides: Partial<ProviderEntryState> = {}): ProviderEntryState {
  return {
    id: 'entry-0',
    provider: 'ollama',
    model: '',
    apiKey: '',
    availableModels: [],
    hasExistingKey: false,
    validated: false,
    ...overrides,
  };
}

describe('OllamaFields', () => {
  it('renders a free-text input with the expected placeholder', () => {
    render(<OllamaFields index={0} entry={createEntry()} onModelChange={vi.fn()} />);

    expect(screen.getByPlaceholderText(/llama3, codellama, qwen2\.5-coder/i)).toBeInTheDocument();
  });

  it('displays the current model value in the input', () => {
    render(
      <OllamaFields
        index={0}
        entry={createEntry({ model: 'codellama' })}
        onModelChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('codellama')).toBeInTheDocument();
  });

  it('renders a datalist with the suggested ollama models', () => {
    const { container } = render(
      <OllamaFields index={0} entry={createEntry()} onModelChange={vi.fn()} />,
    );

    const datalist = container.querySelector('datalist#ollama-models-0');
    expect(datalist).not.toBeNull();
    expect(datalist?.querySelectorAll('option').length).toBeGreaterThan(0);
    // Spot-check a known suggestion
    expect(datalist?.querySelector('option[value="qwen2.5-coder"]')).not.toBeNull();
  });

  it('calls onModelChange with the new value when the user types', () => {
    const onModelChange = vi.fn();
    render(<OllamaFields index={0} entry={createEntry()} onModelChange={onModelChange} />);

    fireEvent.change(screen.getByPlaceholderText(/llama3, codellama/i), {
      target: { value: 'mistral' },
    });

    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith('mistral');
  });

  it('uses index in the datalist id so multiple OllamaFields can coexist', () => {
    const { container } = render(
      <OllamaFields index={3} entry={createEntry()} onModelChange={vi.fn()} />,
    );

    expect(container.querySelector('datalist#ollama-models-3')).not.toBeNull();
    expect(container.querySelector('datalist#ollama-models-0')).toBeNull();
  });
});
