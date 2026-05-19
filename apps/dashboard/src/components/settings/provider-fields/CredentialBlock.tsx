import { useState } from 'react';
import type { AvailableKeysMap } from '@/lib/api';
import type { ProviderEntryState } from '../ProviderEntry';
import { applySavedKey, getCliCredentialLabel } from './shared';

export interface CredentialBlockProps {
  index: number;
  entry: ProviderEntryState;
  /** Saved (masked) keys available for reuse, keyed by provider name */
  availableKeys?: AvailableKeysMap;
  /** Whether the Validate action is currently in-flight */
  isPending: boolean;
  /** Computed by parent: whether the Validate button should be enabled */
  canValidate: boolean;
  /** Validation error message, if any, from the parent-owned validation flow */
  validationError: string | null;
  /** Update the entry's apiKey field (also resets parent validation state) */
  onApiKeyChange: (apiKey: string) => void;
  /** Generic entry update — used when the user reuses a saved key */
  onChange: (entry: ProviderEntryState) => void;
  /** Trigger the validation flow (parent owns useValidateProvider) */
  onValidate: () => void;
}

/**
 * Credential block — API key / token input, Validate button, and the
 * saved-key reuse selector.
 *
 * Extracted from ProviderEntry to isolate the credential-mode state
 * (reuse-saved-key vs enter-new-key) from the parent's orchestration logic.
 *
 * State ownership:
 *   - Internal: keyMode (toggle between reuse/new), and the derived
 *     savedKeyInfo / showReuseSelector / effectiveMode.
 *   - External (props): validationError, isPending, canValidate, plus the
 *     callbacks that bubble back to the parent's validation hook.
 *
 * The parent uses `key={entry.provider}` to force a re-mount on provider
 * switch, which resets `keyMode` back to 'reuse'. This avoids an effect-based
 * reset and keeps the toggle purely local.
 */
export function CredentialBlock({
  index,
  entry,
  availableKeys = {},
  isPending,
  canValidate,
  validationError,
  onApiKeyChange,
  onChange,
  onValidate,
}: CredentialBlockProps) {
  // 'new' means the user wants to type a new key; 'reuse' means picking a saved one
  const [keyMode, setKeyMode] = useState<'reuse' | 'new'>('reuse');

  const isCLIBridge = entry.provider === 'cli-bridge';
  const isGateway = entry.provider === 'gateway';
  const needsApiKey = entry.provider !== 'ollama';

  // Saved key for the current provider (from global/installation settings)
  const savedKeyInfo = availableKeys[entry.provider];
  const hasSavedKey = !!savedKeyInfo;
  // Show the selector when there is a saved key AND the user hasn't explicitly chosen 'new'
  const showReuseSelector = needsApiKey && hasSavedKey && !entry.hasExistingKey;
  // Effective mode: if the entry already has its own key, always show the input
  const effectiveMode = entry.hasExistingKey ? 'new' : keyMode;

  return (
    <div className="mb-3" data-testid={`credential-block-${index}`}>
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
              // `savedKeyInfo` is guaranteed non-null here: this branch only renders when
              // `showReuseSelector` is true, which requires `hasSavedKey` (i.e. savedKeyInfo exists).
              if (!savedKeyInfo) return;
              onChange(applySavedKey(entry, savedKeyInfo));
            }}
            className="input-field flex-1 cursor-pointer text-left text-text-secondary hover:border-primary-600/50 hover:text-text-primary"
          >
            {savedKeyInfo?.maskedApiKey ?? 'Saved key'} — click to use
          </button>
          <button
            type="button"
            onClick={onValidate}
            disabled={!canValidate || isPending}
            className="btn-secondary whitespace-nowrap text-sm"
          >
            {isPending ? 'Checking...' : entry.validated ? 'Valid ✓' : 'Validate'}
          </button>
        </div>
      ) : (
        /* ── Manual input: enter or replace a key ── */
        <div className="flex items-center gap-3">
          <input
            type="password"
            value={entry.apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
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
              onClick={onValidate}
              disabled={!canValidate || isPending}
              className="btn-secondary whitespace-nowrap text-sm"
            >
              {isPending ? 'Checking...' : entry.validated ? 'Valid ✓' : 'Validate'}
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
  );
}
