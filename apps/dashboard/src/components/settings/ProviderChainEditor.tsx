import { type AvailableKeysMap, useAvailableKeys } from '@/lib/api';
import type { SaaSProvider } from '@/lib/types';
import { ProviderEntry, type ProviderEntryState } from './ProviderEntry';

interface ProviderChainEditorProps {
  chain: ProviderEntryState[];
  onChange: (chain: ProviderEntryState[]) => void;
  /** Pre-fetched available keys map (optional; editor fetches its own if not provided) */
  availableKeys?: AvailableKeysMap;
}

// Template for new entries. `id` is intentionally NOT part of the template:
// a module-level crypto.randomUUID() is evaluated ONCE at load time, so every
// added entry would share the same id → duplicate React keys → cross-wired
// entry state on add/remove/reorder. Generate a fresh id per add instead.
// crypto.randomUUID() throws in non-secure contexts (HTTP staging without TLS —
// self-hosters). Fall back to a sufficiently-unique id when it is unavailable.
const genId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DEFAULT_ENTRY: Omit<ProviderEntryState, 'id'> = {
  provider: 'gateway' as SaaSProvider,
  model: 'auto',
  apiKey: '',
  availableModels: [],
  hasExistingKey: false,
  validated: false,
  cliModel: undefined,
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
    // Always allow adding a new entry — same provider with different model is valid.
    // Default to gateway as the standard starting point; user can change to cli-bridge or ollama.
    const defaultProvider: SaaSProvider = 'gateway';
    onChange([...chain, { ...DEFAULT_ENTRY, id: genId(), provider: defaultProvider }]);
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
              key={entry.id}
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
