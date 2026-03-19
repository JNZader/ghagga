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

// ─── Known Models per Provider (for instant model selection without re-validation) ──

export const KNOWN_MODELS: Record<SaaSProvider, string[]> = {
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  cerebras: ['llama3.1-8b', 'gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: [
    // ── Free models (no credits needed) ──
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'google/gemma-3-27b-it:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'qwen/qwen3-coder:free',
    'stepfun/step-3.5-flash:free',
    'minimax/minimax-m2.5:free',
    // ── Paid models (requires credits) ──
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-chat',
  ],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-20250414',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini'],
  google: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ],
  github: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'Phi-4', 'Mistral-Large-2411', 'DeepSeek-R1'],
  qwen: ['qwen-coder-plus', 'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-coder-turbo', 'qwen-long'],
  'cli-bridge': ['auto', 'opencode', 'copilot', 'gemini'],
  gateway: ['auto'],
};

// ─── Provider Labels ────────────────────────────────────────────

const API_PROVIDER_OPTIONS: { value: SaaSProvider; label: string }[] = [
  { value: 'groq', label: 'Groq (Free)' },
  { value: 'cerebras', label: 'Cerebras (Free)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter (Multi-Model)' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'qwen', label: 'Qwen (Alibaba Cloud)' },
];

const CLI_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto-detect (best available)' },
  { value: 'opencode', label: 'OpenCode (recommended)' },
  { value: 'copilot', label: 'Copilot CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
];

/** Free OpenCode models — no API key needed */
const OPENCODE_FREE_MODELS = [
  'opencode/gpt-5-nano',
  'opencode/big-pickle',
  'opencode/mimo-v2-pro-free',
  'opencode/minimax-m2.5-free',
  'opencode/nemotron-3-super-free',
  'opencode/mimo-v2-omni-free',
];

/** Curated OpenCode model suggestions (require API key for the provider) */
const OPENCODE_PAID_MODELS = [
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5-codex',
  'groq/openai/gpt-oss-120b',
  'openrouter/deepseek/deepseek-chat',
];

const OPENCODE_MODEL_SUGGESTIONS = [...OPENCODE_FREE_MODELS, ...OPENCODE_PAID_MODELS];

/** Derive a human-readable credential label from the CLI tool and cliModel prefix */
function getCliCredentialLabel(cliTool: string, cliModel?: string): string {
  if (cliTool === 'gemini') return 'Gemini API Key';
  if (cliTool === 'copilot') return 'GitHub Token (Fine-Grained PAT)';
  if (cliTool === 'auto') return 'API Key (optional)';

  // opencode — derive from cliModel prefix
  if (cliTool === 'opencode' && cliModel) {
    const prefix = cliModel.split('/')[0];
    switch (prefix) {
      case 'opencode':
        return ''; // Free models — no API key needed
      case 'anthropic':
        return 'Anthropic API Key';
      case 'openai':
        return 'OpenAI API Key';
      case 'google':
        return 'Gemini API Key';
      case 'github-copilot':
        return 'GitHub Token';
      case 'groq':
        return 'Groq API Key';
      case 'openrouter':
        return 'OpenRouter API Key';
      default:
        return 'Provider API Key';
    }
  }

  return 'Provider API Key';
}

/** Get contextual help text for the CLI credential input */
function getCliCredentialHelp(cliTool: string): string {
  switch (cliTool) {
    case 'opencode':
      return 'Models prefixed with opencode/ are free and need no API key. For other providers (anthropic/, openai/, etc.), provide the corresponding API key.';
    case 'gemini':
      return 'Provide a Gemini API key, or leave empty to use the server\u2019s GEMINI_API_KEY.';
    case 'copilot':
      return 'Provide a GitHub Fine-Grained PAT with Copilot permissions, or leave empty to use the server\u2019s token.';
    case 'auto':
      return 'Credentials are optional. The server will use its own keys if no credential is provided.';
    default:
      return '';
  }
}

/** Check if cliModel matches the expected provider/model format */
function isValidCliModelFormat(cliModel: string): boolean {
  return /^[^/]+\/.+$/.test(cliModel);
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

  const isGitHub = entry.provider === 'github';
  const isCLIBridge = entry.provider === 'cli-bridge';
  const isGateway = entry.provider === 'gateway';
  // CLI bridge entries CAN have API keys now (opencode, gemini, copilot all accept credentials)
  // Gateway uses apiKey for the bearer token (configured in dashboard, not env vars)
  const needsApiKey = !isGitHub;
  // Can validate if: GitHub (no key needed), has a new key typed, OR has an existing saved key
  const canValidate = isGitHub || entry.apiKey.trim().length > 0 || entry.hasExistingKey;
  // For opencode: cliModel is required — disable save/validate if missing
  const isOpencode = isCLIBridge && entry.model === 'opencode';
  const cliModelMissing = isOpencode && !entry.cliModel?.trim();
  const cliModelInvalid =
    isOpencode && entry.cliModel?.trim() && !isValidCliModelFormat(entry.cliModel.trim());
  // Free opencode/* models don't need API keys
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

      {/* Provider Mode: API vs CLI Bridge */}
      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-text-secondary">Provider</label>
        <div className="mb-2 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${index}`}
              checked={entry.provider !== 'cli-bridge' && entry.provider !== 'gateway'}
              onChange={() => {
                if (entry.provider === 'cli-bridge' || entry.provider === 'gateway') {
                  handleProviderChange('groq' as SaaSProvider);
                }
              }}
              className="accent-primary-500"
            />
            <span className="text-text-secondary">API Provider</span>
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
            <span className="text-text-secondary">CLI Bridge</span>
            <span className="text-[10px] text-yellow-400/70">(uses server CLIs — $0)</span>
          </label>
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
            <span className="text-[10px] text-blue-400/70">(centralized — your own gateway)</span>
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
          /* API provider dropdown */
          <select
            value={entry.provider}
            onChange={(e) => handleProviderChange(e.target.value as SaaSProvider)}
            className="select-field"
          >
            {API_PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* CLI Bridge: OpenCode model input (only when opencode is selected) */}
      {isCLIBridge && entry.model === 'opencode' && (
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary">
            OpenCode Model (provider/model)
            <span className="ml-1 text-red-400">*</span>
          </label>
          <input
            type="text"
            list={`cli-model-suggestions-${index}`}
            value={entry.cliModel ?? ''}
            onChange={(e) => {
              const newCliModel = e.target.value;
              onChange({
                ...entry,
                cliModel: newCliModel,
                validated: false, // Model changed — prior validation is stale
              });
            }}
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

      {/* LLM Gateway: URL + Model input */}
      {isGateway && (
        <div className="mb-3 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Gateway URL
              <span className="ml-1 text-red-400">*</span>
            </label>
            <input
              type="text"
              value={entry.gatewayUrl ?? ''}
              onChange={(e) => {
                onChange({
                  ...entry,
                  gatewayUrl: e.target.value,
                  validated: false,
                });
              }}
              placeholder="https://llm-gateway.example.com"
              className="input-field w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Model
              <span className="ml-2 font-normal text-text-muted">
                (type or select from gateway)
              </span>
            </label>
            <input
              type="text"
              list={`gateway-models-${index}`}
              value={entry.model === 'auto' ? '' : entry.model}
              onChange={(e) => {
                onChange({
                  ...entry,
                  model: e.target.value || 'auto',
                });
              }}
              placeholder="auto (gateway selects best available)"
              className="input-field w-full"
            />
            <datalist id={`gateway-models-${index}`}>
              <option value="auto">Auto — gateway selects best available</option>
              <option value="opencode/gpt-5-nano">GPT-5 Nano (free)</option>
              <option value="opencode/big-pickle">Big Pickle (free)</option>
              <option value="opencode/minimax-m2.5-free">MiniMax M2.5 Free</option>
              <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
              <option value="anthropic/claude-opus-4-6">Claude Opus 4.6</option>
              <option value="github-copilot/claude-sonnet-4.5">Claude Sonnet 4.5 (Copilot)</option>
              <option value="github-copilot/gpt-5">GPT-5 (Copilot)</option>
              <option value="openai/gpt-5-codex">GPT-5 Codex</option>
              <option value="opencode-go/kimi-k2.5">Kimi K2.5</option>
            </datalist>
            <p className="mt-1 text-xs text-text-secondary">
              Leave empty for auto-selection. Type any model ID available on your gateway.
            </p>
          </div>
          <p className="text-xs text-text-secondary">The token goes in the API Key field below.</p>
        </div>
      )}

      {/* CLI Bridge: contextual help text */}
      {isCLIBridge && (
        <div className="mb-3 rounded-md border border-surface-border/50 bg-surface-bg/30 p-3 text-xs text-text-secondary">
          <p>{getCliCredentialHelp(entry.model)}</p>
        </div>
      )}

      {/* Free model banner — no API key needed */}
      {isFreeModel && (
        <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-400">
          <p>✨ Free model — no API key required. Just save and start reviewing!</p>
        </div>
      )}

      {/* API Key / Credential Input + Validate Button */}
      <div className={`mb-3 ${isGitHub || isFreeModel ? 'hidden' : ''}`}>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">
            {isGateway
              ? 'Gateway Token'
              : isCLIBridge
                ? getCliCredentialLabel(entry.model, entry.cliModel)
                : 'API Key'}
          </label>
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
            {!isCLIBridge && !isGateway && (
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
        {!isCLIBridge && !isGateway && entry.validated && !validationError && (
          <p className="mt-1 text-xs text-green-400">API key validated successfully</p>
        )}
        {entry.hasExistingKey && !entry.apiKey && !entry.validated && (
          <p className="mt-1 text-xs text-text-secondary">
            Existing key will be preserved. Enter a new key to replace it.
          </p>
        )}
      </div>

      {/* Model Selector — combo input with datalist for type-ahead + free text */}
      {/* Hidden for CLI Bridge (model is selected in the CLI dropdown above) and Gateway (always 'auto') */}
      <div className={isCLIBridge || isGateway ? 'hidden' : ''}>
        <label className="mb-1 block text-xs font-medium text-text-secondary">Model</label>
        {effectiveModels.length > 0 || entry.model ? (
          <div>
            <input
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
