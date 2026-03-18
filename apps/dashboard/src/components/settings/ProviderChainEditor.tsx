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
  const serverKeys: AvailableKeysMap = keysProp ?? fetchedKeys ?? {};

  // Merge with keys from existing chain entries — this allows a second entry
  // for the same provider to "reuse" the key from the first entry, even if
  // the key only exists in the repo chain (not in global/installation settings).
  const availableKeys: AvailableKeysMap = { ...serverKeys };
  for (const entry of chain) {
    if (entry.hasExistingKey && entry.maskedApiKey && !availableKeys[entry.provider]) {
      availableKeys[entry.provider] = { maskedApiKey: entry.maskedApiKey, source: 'global' };
    }
  }
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
    // Always allow adding a new entry — same provider with different model is valid
    // (e.g., two Groq entries with different models for multi-provider distribution).
    // Default to groq as a sensible starting point; user can change provider/model.
    const defaultProvider: SaaSProvider = 'groq';
    onChange([...chain, { ...DEFAULT_ENTRY, provider: defaultProvider }]);
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
              key={`provider-${index}`}
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

          {chain.length < 9 && (
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
