import { useEffect, useState } from 'react';
import type { AvailableKeysMap } from '@/lib/api';
import { useValidateProvider } from '@/lib/api';
import type { SaaSProvider } from '@/lib/types';
import { CliBridgeFields } from './provider-fields/CliBridgeFields';
import { GatewayFields } from './provider-fields/GatewayFields';
import { OllamaFields } from './provider-fields/OllamaFields';
import { CLI_OPTIONS, getCliCredentialLabel, KNOWN_MODELS } from './provider-fields/shared';

// Re-export shared constants for backwards compatibility with parent pages
// (Settings.tsx, GlobalSettings.tsx) that import KNOWN_MODELS from here.
export { KNOWN_MODELS };

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
  // 'new' means the user wants to type a new key; 'reuse' means picking a saved one
  const [keyMode, setKeyMode] = useState<'reuse' | 'new'>('reuse');

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
  // Free opencode/* models don't need API keys — used by the credential block below
  const isFreeModel = isOpencode && entry.cliModel?.startsWith('opencode/');

  // Saved key for the current provider (from global/installation settings)
  const savedKeyInfo = availableKeys[entry.provider];
  const hasSavedKey = !!savedKeyInfo;
  // Show the selector when there is a saved key AND the user hasn't explicitly chosen 'new'
  const showReuseSelector = needsApiKey && hasSavedKey && !entry.hasExistingKey;
  // Effective mode: if the entry already has its own key, always show the input
  const effectiveMode = entry.hasExistingKey ? 'new' : keyMode;

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

  const _handleProviderChange = (provider: SaaSProvider) => {
    setKeyMode('reuse'); // reset to default so the selector shows if a saved key exists
    onChange({
      ...entry,
      provider,
      model: '',
      apiKey: '',
      availableModels: [],
      validated: false,
      hasExistingKey: false,
      maskedApiKey: undefined,
      cliModel: undefined,
      gatewayUrl: undefined,
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
              onChange={() => {
                onChange({
                  ...entry,
                  provider: 'gateway' as SaaSProvider,
                  model: 'auto',
                  apiKey: '',
                  validated: false,
                  hasExistingKey: false,
                  maskedApiKey: undefined,
                  availableModels: KNOWN_MODELS.gateway ?? [],
                  cliModel: undefined,
                  gatewayUrl: '',
                });
              }}
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
              onChange={() => {
                onChange({
                  ...entry,
                  provider: 'cli-bridge' as SaaSProvider,
                  model: 'auto',
                  apiKey: '',
                  validated: true,
                  hasExistingKey: false,
                  maskedApiKey: undefined,
                  availableModels: KNOWN_MODELS['cli-bridge'] ?? [],
                  cliModel: undefined,
                });
              }}
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
              onChange={() => {
                onChange({
                  ...entry,
                  provider: 'ollama' as SaaSProvider,
                  model: '',
                  apiKey: '',
                  validated: false,
                  hasExistingKey: false,
                  maskedApiKey: undefined,
                  availableModels: KNOWN_MODELS.ollama ?? [],
                  cliModel: undefined,
                  gatewayUrl: undefined,
                });
              }}
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
          /* CLI tool selector */
          <select
            value={entry.model}
            onChange={(e) => {
              const newTool = e.target.value;
              // On tool change: reset cliModel and clear entered API key (credentials are tool-specific)
              onChange({
                ...entry,
                model: newTool,
                cliModel: undefined,
                apiKey: '',
                hasExistingKey: false,
                maskedApiKey: undefined,
                validated: newTool !== 'opencode', // opencode needs cliModel before it's "valid"
              });
            }}
            className="select-field"
          >
            {CLI_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          /* Ollama: free-text model input with suggestions */
          <OllamaFields
            index={index}
            entry={entry}
            onModelChange={(model) => onChange({ ...entry, model })}
          />
        )}
      </div>

      {/* CLI Bridge: cliModel input + help + free-banner */}
      {isCLIBridge && (
        <CliBridgeFields
          index={index}
          entry={entry}
          onCliModelChange={(cliModel) =>
            onChange({
              ...entry,
              cliModel,
              validated: false, // Model changed — prior validation is stale
            })
          }
        />
      )}

      {/* LLM Gateway: URL + Model input */}
      {isGateway && (
        <GatewayFields
          index={index}
          entry={entry}
          onUrlChange={(gatewayUrl) =>
            onChange({ ...entry, gatewayUrl, validated: false })
          }
          onModelChange={(model) => onChange({ ...entry, model: model || 'auto' })}
        />
      )}

      {/* API Key / Credential Input + Validate Button */}
      {/* Hidden for ollama (no key needed) and free opencode models */}
      <div className={`mb-3 ${isOllama || isFreeModel ? 'hidden' : ''}`}>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-text-secondary">
            {isGateway
              ? 'Gateway Token'
              : isCLIBridge
                ? getCliCredentialLabel(entry.model, entry.cliModel)
                : 'API Key'}
          </span>
          {/* Toggle between reusing a saved key and entering a new one */}
          {showReuseSelector && !isCLIBridge && (
            <button
              type="button"
              onClick={() => setKeyMode((m) => (m === 'reuse' ? 'new' : 'reuse'))}
              className="text-xs text-primary-400 underline hover:text-primary-300"
            >
              {effectiveMode === 'reuse' ? '+ Use a different key' : '↩ Use saved key'}
            </button>
          )}
        </div>

        {showReuseSelector && effectiveMode === 'reuse' ? (
          /* ── Key Selector: reuse a saved key ── */
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                // One-click to apply the saved key — no dropdown needed when there's only one option.
                const knownModels = KNOWN_MODELS[entry.provider] ?? [];
                onChange({
                  ...entry,
                  apiKey: '',
                  hasExistingKey: true,
                  maskedApiKey: savedKeyInfo?.maskedApiKey,
                  validated: true,
                  availableModels: knownModels,
                  model: entry.model || knownModels[0] || '',
                });
              }}
              className="input-field flex-1 cursor-pointer text-left text-text-secondary hover:border-primary-600/50 hover:text-text-primary"
            >
              {savedKeyInfo?.maskedApiKey ?? 'Saved key'} — click to use
            </button>
            <button
              type="button"
              onClick={handleValidate}
              disabled={!canValidate || validateProvider.isPending}
              className="btn-secondary whitespace-nowrap text-sm"
            >
              {validateProvider.isPending
                ? 'Checking...'
                : entry.validated
                  ? 'Valid ✓'
                  : 'Validate'}
            </button>
          </div>
        ) : (
          /* ── Manual input: enter or replace a key ── */
          <div className="flex items-center gap-3">
            <input
              type="password"
              value={entry.apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder={
                entry.hasExistingKey
                  ? entry.maskedApiKey || 'Key saved (enter new to replace)'
                  : isGateway
                    ? 'Enter gateway bearer token...'
                    : isCLIBridge
                      ? `Enter ${getCliCredentialLabel(entry.model, entry.cliModel).toLowerCase()}...`
                      : 'Enter API key...'
              }
              className="input-field flex-1"
            />
            {/* Only show validate button for gateway (bearer token validation) */}
            {isGateway && (
              <button
                type="button"
                onClick={handleValidate}
                disabled={!canValidate || validateProvider.isPending}
                className="btn-secondary whitespace-nowrap text-sm"
              >
                {validateProvider.isPending
                  ? 'Checking...'
                  : entry.validated
                    ? 'Valid \u2713'
                    : 'Validate'}
              </button>
            )}
          </div>
        )}

        {/* Validation status */}
        {validationError && <p className="mt-1 text-xs text-red-400">{validationError}</p>}
        {isGateway && entry.validated && !validationError && (
          <p className="mt-1 text-xs text-green-400">Gateway token validated successfully</p>
        )}
        {entry.hasExistingKey && !entry.apiKey && !entry.validated && (
          <p className="mt-1 text-xs text-text-secondary">
            Existing key will be preserved. Enter a new key to replace it.
          </p>
        )}
      </div>

      {/* Model Selector — hidden for CLI Bridge (uses CLI dropdown) and Gateway (always 'auto') */}
      <div className={isCLIBridge || isGateway ? 'hidden' : ''}>
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
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="Type or select a model..."
              className="input-field w-full"
            />
            <datalist id={`models-${entry.provider}-${effectiveModels.length}`}>
              {effectiveModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        ) : entry.model ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 rounded-md border border-surface-border bg-surface-bg px-3 py-2 text-sm text-text-primary">
              {entry.model}
            </span>
            <span className="text-xs text-text-secondary">Validate to see all models</span>
          </div>
        ) : (
          <div className="rounded-md border border-surface-border bg-surface-bg px-3 py-2 text-sm text-text-secondary">
            Validate your API key first to see available models
          </div>
        )}
      </div>
    </div>
  );
}
