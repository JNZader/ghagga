import type { ProviderEntryState } from '../ProviderEntry';
import { OLLAMA_MODEL_SUGGESTIONS } from './shared';

export interface OllamaFieldsProps {
  index: number;
  entry: ProviderEntryState;
  onModelChange: (model: string) => void;
}

/**
 * Ollama-specific provider fields.
 *
 * Renders the free-text model input (with suggestions datalist) shown directly
 * under the provider radio when "ollama" is selected.
 *
 * The model selector that appears AFTER the credential block (which is hidden
 * for ollama anyway) is rendered by the parent — see ProviderEntry's "Model
 * Selector" block at the end.
 */
export function OllamaFields({ index, entry, onModelChange }: OllamaFieldsProps) {
  return (
    <div>
      <input
        type="text"
        list={`ollama-models-${index}`}
        value={entry.model}
        onChange={(e) => onModelChange(e.target.value)}
        placeholder="e.g., llama3, codellama, qwen2.5-coder"
        className="input-field w-full"
      />
      <datalist id={`ollama-models-${index}`}>
        {OLLAMA_MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
