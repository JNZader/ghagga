import type { ProviderEntryState } from '../ProviderEntry';
import {
  CLI_OPTIONS,
  getCliCredentialHelp,
  isValidCliModelFormat,
  OPENCODE_MODEL_SUGGESTIONS,
} from './shared';

export interface CliBridgeFieldsProps {
  index: number;
  entry: ProviderEntryState;
  /** Called when the user picks a different CLI tool (entry.model) */
  onCliToolChange: (cliTool: string) => void;
  /** Called when the user edits the OpenCode model input (entry.cliModel) */
  onCliModelChange: (cliModel: string) => void;
}

/**
 * CLI Bridge-specific provider fields.
 *
 * Renders, in order:
 *   1. CLI tool selector (Auto / OpenCode / Copilot / Gemini)
 *   2. OpenCode model input (only when CLI tool === 'opencode')
 *   3. Contextual help text for the selected CLI tool
 *   4. Free-model banner (only when the cliModel is an opencode/* free model)
 *
 * The API-key / credential block lives in the parent (ProviderEntry) because
 * it is shared across providers and needs the validate-button wiring.
 */
export function CliBridgeFields({
  index,
  entry,
  onCliToolChange,
  onCliModelChange,
}: CliBridgeFieldsProps) {
  const isOpencode = entry.model === 'opencode';
  const trimmedCliModel = entry.cliModel?.trim();
  const cliModelMissing = isOpencode && !trimmedCliModel;
  const cliModelInvalid =
    isOpencode && !!trimmedCliModel && !isValidCliModelFormat(trimmedCliModel);
  const isFreeModel = isOpencode && entry.cliModel?.startsWith('opencode/');

  return (
    <>
      {/* CLI tool selector */}
      <select
        value={entry.model}
        onChange={(e) => onCliToolChange(e.target.value)}
        className="select-field"
      >
        {CLI_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* OpenCode model input (only when opencode is selected) */}
      {isOpencode && (
        <div className="mb-3">
          <label
            htmlFor={`cli-model-${index}`}
            className="mb-1 block text-xs font-medium text-text-secondary"
          >
            OpenCode Model (provider/model)
            <span className="ml-1 text-red-400">*</span>
          </label>
          <input
            id={`cli-model-${index}`}
            type="text"
            list={`cli-model-suggestions-${index}`}
            value={entry.cliModel ?? ''}
            onChange={(e) => onCliModelChange(e.target.value)}
            placeholder="e.g., anthropic/claude-sonnet-4-5"
            className="input-field w-full"
          />
          <datalist id={`cli-model-suggestions-${index}`}>
            {OPENCODE_MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {cliModelMissing && (
            <p className="mt-1 text-xs text-yellow-400">
              Model is required when using OpenCode. Select or type a provider/model.
            </p>
          )}
          {cliModelInvalid && (
            <p className="mt-1 text-xs text-yellow-400">
              Expected format: <code className="rounded bg-surface-bg px-1">provider/model</code>{' '}
              (e.g., anthropic/claude-sonnet-4-5)
            </p>
          )}
        </div>
      )}

      {/* Contextual help for the selected CLI tool */}
      <div className="mb-3 rounded-md border border-surface-border/50 bg-surface-bg/30 p-3 text-xs text-text-secondary">
        <p>{getCliCredentialHelp(entry.model)}</p>
      </div>

      {/* Free model banner — no API key needed */}
      {isFreeModel && (
        <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-400">
          <p>✨ Free model — no API key required. Just save and start reviewing!</p>
        </div>
      )}
    </>
  );
}
