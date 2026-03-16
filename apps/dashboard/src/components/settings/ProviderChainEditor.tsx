import { type AvailableKeysMap, useAvailableKeys } from '@/lib/api';
import type { SaaSProvider } from '@/lib/types';
import { ProviderEntry, type ProviderEntryState } from './ProviderEntry';

interface ProviderChainEditorProps {
  chain: ProviderEntryState[];
  onChange: (chain: ProviderEntryState[]) => void;
  /** Pre-fetched available keys map (optional; editor fetches its own if not provided) */
  availableKeys?: AvailableKeysMap;
}

const DEFAULT_ENTRY: ProviderEntryState = {
  provider: 'github' as SaaSProvider,
  model: '',
  apiKey: '',
  availableModels: [],
  hasExistingKey: false,
  validated: false,
};

export function ProviderChainEditor({
  chain,
  onChange,
  availableKeys: keysProp,
}: ProviderChainEditorProps) {
  // Fetch available keys if not provided as a prop (self-contained usage)
  const { data: fetchedKeys } = useAvailableKeys();
  const availableKeys: AvailableKeysMap = keysProp ?? fetchedKeys ?? {};
  const handleEntryChange = (index: number, entry: ProviderEntryState) => {
    const updated = [...chain];
    updated[index] = entry;
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    onChange(chain.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const updated = [...chain];
    const a = updated[index];
    const b = updated[index - 1];
    if (a !== undefined && b !== undefined) {
      updated[index - 1] = a;
      updated[index] = b;
    }
    onChange(updated);
  };

  const handleMoveDown = (index: number) => {
    if (index === chain.length - 1) return;
    const updated = [...chain];
    const a = updated[index];
    const b = updated[index + 1];
    if (a !== undefined && b !== undefined) {
      updated[index] = b;
      updated[index + 1] = a;
    }
    onChange(updated);
  };

  const handleAdd = () => {
    // Pick a provider not already in the chain, or default to github
    const usedProviders = new Set(chain.map((e) => e.provider));
    const available = (['github', 'openai', 'anthropic', 'google', 'qwen'] as SaaSProvider[]).find(
      (p) => !usedProviders.has(p),
    );
    onChange([...chain, { ...DEFAULT_ENTRY, provider: available ?? 'github' }]);
  };

  return (
    <div className="space-y-3">
      {chain.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border p-6 text-center">
          <p className="mb-2 text-sm text-text-secondary">
            No providers configured. Add at least one to enable AI review.
          </p>
          <button type="button" onClick={handleAdd} className="btn-primary text-sm">
            + Add Provider
          </button>
        </div>
      ) : (
        <>
          {chain.map((entry, index) => (
            <ProviderEntry
              key={`provider-${entry.provider}`}
              index={index}
              entry={entry}
              totalEntries={chain.length}
              availableKeys={availableKeys}
              onChange={(updated) => handleEntryChange(index, updated)}
              onRemove={() => handleRemove(index)}
              onMoveUp={() => handleMoveUp(index)}
              onMoveDown={() => handleMoveDown(index)}
            />
          ))}

          {chain.length < 5 && (
            <button
              type="button"
              onClick={handleAdd}
              className="w-full rounded-lg border border-dashed border-surface-border px-4 py-2 text-sm text-text-secondary transition-colors hover:border-primary-600/50 hover:text-primary-400"
            >
              + Add Fallback Provider
            </button>
          )}
        </>
      )}
    </div>
  );
}
