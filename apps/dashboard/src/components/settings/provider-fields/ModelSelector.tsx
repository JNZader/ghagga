import type { ProviderEntryState } from '../ProviderEntry';

export interface ModelSelectorProps {
  /** Position in the provider chain — used to disambiguate label/input ids when multiple entries render side by side */
  index: number;
  entry: ProviderEntryState;
  /**
   * Pre-computed model list passed by the parent.
   *
   * The parent derives this from `entry.availableModels` with a `KNOWN_MODELS`
   * fallback (and prepends `entry.model` if it isn't already in the list) so
   * the dropdown stays populated even before validation. Keeping derivation
   * in the parent avoids duplicating that logic here.
   */
  effectiveModels: string[];
  onModelChange: (model: string) => void;
}

/**
 * Generic model selector — datalist-backed text input shown after the
 * credential block for providers that expose multiple models.
 *
 * Visibility: the parent (`ProviderEntry`) hides this component for
 * `cli-bridge` (its tool selector lives in `CliBridgeFields`) and `gateway`
 * (model is always `auto`). This component itself is provider-agnostic — it
 * just renders whatever `effectiveModels` it's given.
 *
 * Rendering branches:
 *   1. `effectiveModels.length > 0 || entry.model` → datalist input
 *   2. fallback → "Validate first" hint
 */
export function ModelSelector({
  index,
  entry,
  effectiveModels,
  onModelChange,
}: ModelSelectorProps) {
  return (
    <>
      <label
        htmlFor={`model-selector-${index}`}
        className="mb-1 block text-xs font-medium text-text-secondary"
      >
        Model
      </label>
      {effectiveModels.length > 0 || entry.model ? (
        <div>
          <input
            id={`model-selector-${index}`}
            type="text"
            list={`models-${entry.provider}-${effectiveModels.length}`}
            value={entry.model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="Type or select a model..."
            className="input-field w-full"
          />
          <datalist id={`models-${entry.provider}-${effectiveModels.length}`}>
            {effectiveModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      ) : (
        <div className="rounded-md border border-surface-border bg-surface-bg px-3 py-2 text-sm text-text-secondary">
          Validate your API key first to see available models
        </div>
      )}
    </>
  );
}
