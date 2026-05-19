/**
 * ModelSelector component tests.
 *
 * Covers the generic model selector rendered after the credential block
 * for providers that expose multiple models. The visibility guard
 * (hidden for cli-bridge + gateway) lives in the PARENT (ProviderEntry),
 * not in this component — this file documents that contract and exercises
 * the component's own branching: datalist input vs. fallback hint, plus
 * onModelChange wiring.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntryState } from '../ProviderEntry';
import { ModelSelector } from './ModelSelector';

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

describe('ModelSelector — datalist input branch (effectiveModels populated)', () => {
  it('renders the input + datalist with each effectiveModels option', () => {
    const { container } = render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: '' })}
        effectiveModels={['llama3', 'codellama', 'mistral']}
        onModelChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type or select a model/i)).toBeInTheDocument();

    const datalist = container.querySelector('datalist');
    expect(datalist).not.toBeNull();
    expect(datalist?.querySelector('option[value="llama3"]')).not.toBeNull();
    expect(datalist?.querySelector('option[value="codellama"]')).not.toBeNull();
    expect(datalist?.querySelector('option[value="mistral"]')).not.toBeNull();
  });

  it('shows the current entry.model as the input value', () => {
    render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: 'codellama' })}
        effectiveModels={['llama3', 'codellama']}
        onModelChange={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('codellama')).toBeInTheDocument();
  });

  it('calls onModelChange with the new value when the user types', () => {
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: 'llama3' })}
        effectiveModels={['llama3', 'codellama']}
        onModelChange={onModelChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/type or select a model/i), {
      target: { value: 'codellama' },
    });

    expect(onModelChange).toHaveBeenCalledOnce();
    expect(onModelChange).toHaveBeenCalledWith('codellama');
  });

  it('uses the index in the input id so multiple selectors can coexist', () => {
    const { container } = render(
      <ModelSelector
        index={2}
        entry={createEntry({ provider: 'ollama', model: '' })}
        effectiveModels={['llama3']}
        onModelChange={vi.fn()}
      />,
    );

    expect(container.querySelector('input#model-selector-2')).not.toBeNull();
    expect(container.querySelector('input#model-selector-0')).toBeNull();
  });

  it('uses entry.provider + effectiveModels.length in the datalist id (re-keys when the list changes)', () => {
    const { container, rerender } = render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: '' })}
        effectiveModels={['llama3']}
        onModelChange={vi.fn()}
      />,
    );

    expect(container.querySelector('datalist#models-ollama-1')).not.toBeNull();

    rerender(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: '' })}
        effectiveModels={['llama3', 'codellama', 'mistral']}
        onModelChange={vi.fn()}
      />,
    );

    expect(container.querySelector('datalist#models-ollama-3')).not.toBeNull();
    expect(container.querySelector('datalist#models-ollama-1')).toBeNull();
  });

  // Branch coverage: effectiveModels=[] but entry.model is set — the
  // condition `effectiveModels.length > 0 || entry.model` still takes the
  // datalist branch (this is the original ProviderEntry behavior preserved
  // byte-for-byte during the extraction).
  it('takes the datalist branch when effectiveModels is empty but entry.model is set', () => {
    const { container } = render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: 'gemma3' })}
        effectiveModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText(/type or select a model/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('gemma3')).toBeInTheDocument();
    // The datalist exists but has no options
    const datalist = container.querySelector('datalist');
    expect(datalist).not.toBeNull();
    expect(datalist?.querySelectorAll('option').length).toBe(0);
  });
});

describe('ModelSelector — empty fallback branch', () => {
  it('shows the "Validate first" hint when both effectiveModels and entry.model are empty', () => {
    render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'ollama', model: '' })}
        effectiveModels={[]}
        onModelChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/validate your api key first to see available models/i),
    ).toBeInTheDocument();
    // No input rendered in this branch
    expect(screen.queryByPlaceholderText(/type or select a model/i)).not.toBeInTheDocument();
  });
});

describe('ModelSelector — visibility guard ownership', () => {
  // This contract is enforced in the PARENT (ProviderEntry):
  //
  //   <div className={isCLIBridge || isGateway ? 'hidden' : ''}>
  //     <ModelSelector ... />
  //   </div>
  //
  // ModelSelector itself is provider-agnostic — it renders whatever it's
  // told. This test pins the contract by exercising the component with a
  // cli-bridge entry directly and verifying it renders normally (proving
  // the guard MUST stay in the parent).
  it('renders normally even for cli-bridge entries (guard is parent-side)', () => {
    render(
      <ModelSelector
        index={0}
        entry={createEntry({ provider: 'cli-bridge', model: 'opencode' })}
        effectiveModels={['auto', 'opencode']}
        onModelChange={vi.fn()}
      />,
    );

    // Renders without throwing; the input is present.
    expect(screen.getByPlaceholderText(/type or select a model/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('opencode')).toBeInTheDocument();
  });
});
