import { useEffect, useState } from 'react';
import type { AvailableKeysMap } from '@/lib/api';
import { useValidateProvider } from '@/lib/api';
import type { SaaSProvider } from '@/lib/types';

// ─── Types ──────────────────────────────────────────────────────

export interface ProviderEntryState {
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

// ─── Provider Labels ────────────────────────────────────────────

const PROVIDER_OPTIONS: { value: SaaSProvider; label: string }[] = [
  { value: 'github', label: 'GitHub Models (Free)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'qwen', label: 'Qwen (Alibaba Cloud)' },
];

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

  const isGitHub = entry.provider === 'github';
  const needsApiKey = !isGitHub;
  const canValidate = isGitHub || entry.apiKey.trim().length > 0;

  // Saved key for the current provider (from global/installation settings)
  const savedKeyInfo = availableKeys[entry.provider];
  const hasSavedKey = !!savedKeyInfo;
  // Show the selector when there is a saved key AND the user hasn't explicitly chosen 'new'
  const showReuseSelector = needsApiKey && hasSavedKey && !entry.hasExistingKey;
  // Effective mode: if the entry already has its own key, always show the input
  const effectiveMode = entry.hasExistingKey ? 'new' : keyMode;

  // Reset validation when provider or apiKey changes
  useEffect(() => {
    setValidationError(null);
  }, []);

  const handleProviderChange = (provider: SaaSProvider) => {
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
    });
  };

  const handleApiKeyChange = (apiKey: string) => {
    onChange({
      ...entry,
      apiKey,
      validated: false,
      availableModels: [],
    });
    setValidationError(null);
  };

  const handleValidate = async () => {
    setValidationError(null);
    try {
      const result = await validateProvider.mutateAsync({
        provider: entry.provider,
        apiKey: needsApiKey ? entry.apiKey : undefined,
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

      {/* Provider Dropdown */}
      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-text-secondary">Provider</label>
        <select
          value={entry.provider}
          onChange={(e) => handleProviderChange(e.target.value as SaaSProvider)}
          className="select-field"
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* API Key Input + Validate Button */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">API Key</label>
          {/* Toggle between reusing a saved key and entering a new one */}
          {showReuseSelector && (
            <button
              type="button"
              onClick={() => setKeyMode((m) => (m === 'reuse' ? 'new' : 'reuse'))}
              className="text-xs text-primary-400 underline hover:text-primary-300"
            >
              {effectiveMode === 'reuse' ? 'Enter new key instead' : 'Use saved key'}
            </button>
          )}
        </div>

        {isGitHub ? (
          <div>
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300">
              GitHub Models is not available in SaaS mode (webhook reviews use installation tokens
              which lack the required <code className="font-mono">models</code> permission). Use a
              provider with an API key instead (Anthropic, OpenAI, Google, or Qwen).
            </div>
          </div>
        ) : showReuseSelector && effectiveMode === 'reuse' ? (
          /* ── Key Selector: reuse a saved key ── */
          <div className="flex items-center gap-3">
            <select
              aria-label="Select a saved API key"
              value={savedKeyInfo ? entry.provider : ''}
              onChange={() => {
                // Selecting "use saved key" signals the server to copy the global key.
                // We clear apiKey so the PUT handler falls back to the global chain.
                onChange({
                  ...entry,
                  apiKey: '',
                  hasExistingKey: true,
                  maskedApiKey: savedKeyInfo?.maskedApiKey,
                  validated: true,
                });
              }}
              className="select-field flex-1"
            >
              <option value="" disabled>
                Select a saved key...
              </option>
              {savedKeyInfo && (
                <option value={entry.provider}>
                  {savedKeyInfo.maskedApiKey} (from Global Settings)
                </option>
              )}
            </select>
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
                  : 'Enter API key...'
              }
              className="input-field flex-1"
            />
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
        )}

        {/* Validation status */}
        {validationError && <p className="mt-1 text-xs text-red-400">{validationError}</p>}
        {entry.validated && !validationError && (
          <p className="mt-1 text-xs text-green-400">API key validated successfully</p>
        )}
        {entry.hasExistingKey && !entry.apiKey && !entry.validated && (
          <p className="mt-1 text-xs text-text-secondary">
            Existing key will be preserved. Enter a new key to replace it.
          </p>
        )}
      </div>

      {/* Model Dropdown */}
      <div>
        <label className="mb-1 block text-xs font-medium text-text-secondary">Model</label>
        {entry.availableModels.length > 0 || entry.validated ? (
          <select
            value={entry.model}
            onChange={(e) => handleModelChange(e.target.value)}
            className="select-field"
          >
            <option value="">Select a model...</option>
            {entry.availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : entry.model ? (
          // Pre-selected model from saved settings (not yet validated this session)
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
