import { useEffect, useState } from 'react';
import type { AvailableKeysMap } from '@/lib/api';
import { useValidateProvider } from '@/lib/api';
import type { SaaSProvider } from '@/lib/types';
import { CliBridgeFields } from './provider-fields/CliBridgeFields';
import { CredentialBlock } from './provider-fields/CredentialBlock';
import { GatewayFields } from './provider-fields/GatewayFields';
import { ModelSelector } from './provider-fields/ModelSelector';
import { OllamaFields } from './provider-fields/OllamaFields';
import { KNOWN_MODELS } from './provider-fields/shared';

// ─── Types ──────────────────────────────────────────────────────

export interface ProviderEntryState {
  /** Unique identifier for this entry */
  id: string;
  provider: SaaSProvider;
  model: string;
  apiKey: string;
  /** Models available after validation */
  availableModels: string[];
  /** Whether this entry has a key saved on the server */
  hasExistingKey: boolean;
  /** Masked key from server (e.g., "sk-...xxxx") */
  maskedApiKey?: string;
  /** Validation status */
  validated: boolean;
  /** OpenCode model in `provider/model` format. Only for cli-bridge + opencode. */
  cliModel?: string;
  /** Gateway base URL. Only for gateway provider. */
  gatewayUrl?: string;
}

interface ProviderEntryProps {
  index: number;
  entry: ProviderEntryState;
  totalEntries: number;
  /** Saved (masked) keys available for reuse, keyed by provider name */
  availableKeys?: AvailableKeysMap;
  onChange: (entry: ProviderEntryState) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

// ─── Component ──────────────────────────────────────────────────

export function ProviderEntry({
  index,
  entry,
  totalEntries,
  availableKeys = {},
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: ProviderEntryProps) {
  const validateProvider = useValidateProvider();
  const [validationError, setValidationError] = useState<string | null>(null);

  const isCLIBridge = entry.provider === 'cli-bridge';
  const isGateway = entry.provider === 'gateway';
  const isOllama = entry.provider === 'ollama';
  // All 3 providers may optionally accept an API key / bearer token
  const needsApiKey = !isOllama;
  // Can validate if: key typed, existing key saved, ollama (keyless), or cli-bridge (keyless flow)
  const canValidate =
    isOllama || isCLIBridge || entry.apiKey.trim().length > 0 || entry.hasExistingKey;
  // For opencode: cliModel is required to validate / show free banner
  const isOpencode = isCLIBridge && entry.model === 'opencode';
  // Free opencode/* models don't need API keys — used to hide the credential block
  const isFreeModel = isOpencode && entry.cliModel?.startsWith('opencode/');

  // Effective model list: prefer entry's availableModels, fall back to KNOWN_MODELS.
  // This ensures the dropdown is always populated for entries with saved keys,
  // even if availableModels was lost during a re-render.
  // If the currently selected model isn't in the list, prepend it so it stays visible.
  const baseModels =
    entry.availableModels.length > 0
      ? entry.availableModels
      : entry.hasExistingKey || entry.validated
        ? (KNOWN_MODELS[entry.provider] ?? [])
        : [];
  const effectiveModels =
    entry.model && !baseModels.includes(entry.model) ? [entry.model, ...baseModels] : baseModels;

  // Reset validation error on mount
  useEffect(() => {
    setValidationError(null);
  }, []);

  /**
   * Switch the entry to a different provider. Resets transient state
   * (apiKey, cliModel, gatewayUrl, validation) and seeds the new provider's
   * defaults. Each provider has its own initial model + validated state:
   *   - gateway:    model 'auto', validated=false (token still needs validate)
   *   - cli-bridge: model 'auto', validated=true (no validation flow)
   *   - ollama:     model '',      validated=false (keyless but model required)
   */
  const handleProviderChange = (provider: SaaSProvider) => {
    // CredentialBlock uses key={entry.provider} → re-mounts and resets keyMode to 'reuse'.
    const isNewGateway = provider === 'gateway';
    const isNewCli = provider === 'cli-bridge';
    onChange({
      ...entry,
      provider,
      model: provider === 'ollama' ? '' : 'auto',
      apiKey: '',
      validated: isNewCli, // cli-bridge starts pre-validated; others need explicit validation
      hasExistingKey: false,
      maskedApiKey: undefined,
      availableModels: KNOWN_MODELS[provider] ?? [],
      cliModel: undefined,
      gatewayUrl: isNewGateway ? '' : undefined,
    });
  };

  /**
   * Switch the CLI tool (entry.model) for a cli-bridge entry. Resets cliModel
   * and any entered API key since credentials are tool-specific. opencode is
   * special: it requires a cliModel before it can be considered valid.
   */
  const handleCliToolChange = (cliTool: string) => {
    onChange({
      ...entry,
      model: cliTool,
      cliModel: undefined,
      apiKey: '',
      hasExistingKey: false,
      maskedApiKey: undefined,
      validated: cliTool !== 'opencode',
    });
  };

  const handleApiKeyChange = (apiKey: string) => {
    onChange({
      ...entry,
      apiKey,
      // CLI bridge doesn't use validation flow for its credential, so keep validated state
      validated: isCLIBridge ? entry.validated : false,
      availableModels: isCLIBridge ? entry.availableModels : [],
    });
    setValidationError(null);
  };

  const handleValidate = async () => {
    setValidationError(null);
    try {
      const result = await validateProvider.mutateAsync({
        provider: entry.provider,
        // Send apiKey only if the user typed a new one.
        // If hasExistingKey and no new key typed, send undefined — server resolves from saved chain.
        apiKey: needsApiKey && entry.apiKey.trim() ? entry.apiKey : undefined,
      });

      if (result.valid) {
        onChange({
          ...entry,
          availableModels: result.models,
          validated: true,
          model: entry.model || result.models[0] || '',
        });
      } else {
        setValidationError(result.error || 'Validation failed');
        onChange({ ...entry, validated: false, availableModels: [] });
      }
    } catch {
      setValidationError('Failed to reach validation server');
    }
  };

  const handleModelChange = (model: string) => {
    onChange({ ...entry, model });
  };

  return (
    <div className="rounded-lg border border-surface-border bg-surface-bg/50 p-4">
      {/* Header: Index + Reorder + Remove */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">
            {index + 1}
          </span>
          <span className="text-xs text-text-secondary">
            {index === 0 ? 'Primary' : 'Fallback'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {totalEntries > 1 && (
            <>
              <button
                type="button"
                onClick={onMoveUp}
                disabled={index === 0}
                className="rounded-sm p-1 text-text-secondary hover:bg-surface-border/50 hover:text-text-primary disabled:opacity-30"
                title="Move up"
              >
                &#9650;
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={index === totalEntries - 1}
                className="rounded-sm p-1 text-text-secondary hover:bg-surface-border/50 hover:text-text-primary disabled:opacity-30"
                title="Move down"
              >
                &#9660;
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="ml-2 rounded-sm p-1 text-text-secondary hover:bg-red-500/20 hover:text-red-400"
            title="Remove provider"
          >
            &#10005;
          </button>
        </div>
      </div>

      {/* Provider Mode: Gateway | CLI Bridge | Ollama */}
      <div className="mb-3">
        <span className="mb-1 block text-xs font-medium text-text-secondary">Provider</span>
        <div className="mb-2 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${index}`}
              checked={entry.provider === 'gateway'}
              onChange={() => handleProviderChange('gateway')}
              className="accent-primary-500"
            />
            <span className="text-text-secondary">LLM Gateway</span>
            <span className="text-[10px] text-blue-400/70">(mcp-llm-bridge)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${index}`}
              checked={entry.provider === 'cli-bridge'}
              onChange={() => handleProviderChange('cli-bridge')}
              className="accent-primary-500"
            />
            <span className="text-text-secondary">Local CLI</span>
            <span className="text-[10px] text-yellow-400/70">(Claude/OpenCode/Copilot — $0)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${index}`}
              checked={entry.provider === 'ollama'}
              onChange={() => handleProviderChange('ollama')}
              className="accent-primary-500"
            />
            <span className="text-text-secondary">Ollama</span>
            <span className="text-[10px] text-green-400/70">(local — $0)</span>
          </label>
        </div>

        {entry.provider === 'gateway' ? (
          /* Gateway: model is always 'auto' — show info instead of selector */
          <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-300">
            Model: <code className="font-mono">auto</code> — the gateway handles model selection
          </div>
        ) : entry.provider === 'cli-bridge' ? (
          <CliBridgeFields
            index={index}
            entry={entry}
            onCliToolChange={handleCliToolChange}
            onCliModelChange={(cliModel) =>
              onChange({
                ...entry,
                cliModel,
                validated: false, // Model changed — prior validation is stale
              })
            }
          />
        ) : (
          /* Ollama: free-text model input with suggestions */
          <OllamaFields
            index={index}
            entry={entry}
            onModelChange={(model) => onChange({ ...entry, model })}
          />
        )}
      </div>

      {/* LLM Gateway: URL + Model input */}
      {isGateway && (
        <GatewayFields
          index={index}
          entry={entry}
          onUrlChange={(gatewayUrl) => onChange({ ...entry, gatewayUrl, validated: false })}
          onModelChange={(model) => onChange({ ...entry, model: model || 'auto' })}
        />
      )}

      {/* API Key / Credential Input + Validate Button */}
      {/* Hidden for ollama (no key needed) and free opencode models */}
      {!isOllama && !isFreeModel && (
        <CredentialBlock
          key={entry.provider}
          index={index}
          entry={entry}
          availableKeys={availableKeys}
          isPending={validateProvider.isPending}
          canValidate={canValidate}
          validationError={validationError}
          onApiKeyChange={handleApiKeyChange}
          onChange={onChange}
          onValidate={handleValidate}
        />
      )}

      {/* Model Selector — hidden for CLI Bridge (uses CLI dropdown) and Gateway (always 'auto') */}
      <div className={isCLIBridge || isGateway ? 'hidden' : ''}>
        <ModelSelector
          index={index}
          entry={entry}
          effectiveModels={effectiveModels}
          onModelChange={handleModelChange}
        />
      </div>
    </div>
  );
}
