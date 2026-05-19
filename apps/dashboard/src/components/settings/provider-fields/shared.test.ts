/**
 * shared.ts pure-function tests.
 *
 * Covers domain helpers that compose state mutations consumed by the
 * provider-fields subcomponents. The components themselves are exercised in
 * their dedicated *.test.tsx files — this file pins the helper contracts in
 * isolation so refactors can't silently change the resulting state shape.
 */

import { describe, expect, it } from 'vitest';
import type { AvailableKeyInfo } from '@/lib/api';
import type { ProviderEntryState } from '../ProviderEntry';
import { applySavedKey, KNOWN_MODELS } from './shared';

function createEntry(overrides: Partial<ProviderEntryState> = {}): ProviderEntryState {
  return {
    id: 'entry-0',
    provider: 'gateway',
    model: 'auto',
    apiKey: '',
    availableModels: [],
    hasExistingKey: false,
    validated: false,
    ...overrides,
  };
}

const savedKey: AvailableKeyInfo = {
  maskedApiKey: 'sk-...wxyz',
  source: 'global',
};

describe('applySavedKey', () => {
  it('returns a state with hasExistingKey=true, validated=true, apiKey cleared, masked key set', () => {
    const entry = createEntry({
      provider: 'gateway',
      apiKey: 'typed-but-discarded',
      hasExistingKey: false,
      validated: false,
    });

    const next = applySavedKey(entry, savedKey);

    expect(next.hasExistingKey).toBe(true);
    expect(next.validated).toBe(true);
    expect(next.apiKey).toBe('');
    expect(next.maskedApiKey).toBe('sk-...wxyz');
  });

  it('seeds availableModels from KNOWN_MODELS for the entry provider (gateway)', () => {
    const entry = createEntry({ provider: 'gateway' });

    const next = applySavedKey(entry, savedKey);

    expect(next.availableModels).toEqual(KNOWN_MODELS.gateway);
  });

  it('seeds availableModels from KNOWN_MODELS for cli-bridge', () => {
    const entry = createEntry({ provider: 'cli-bridge', model: '' });

    const next = applySavedKey(entry, savedKey);

    expect(next.availableModels).toEqual(KNOWN_MODELS['cli-bridge']);
  });

  it('preserves entry.model when it is already set', () => {
    const entry = createEntry({
      provider: 'cli-bridge',
      model: 'gemini', // already chosen by the user
    });

    const next = applySavedKey(entry, savedKey);

    expect(next.model).toBe('gemini');
  });

  it('falls back to KNOWN_MODELS[provider][0] when entry.model is empty', () => {
    const entry = createEntry({
      provider: 'cli-bridge',
      model: '',
    });

    const next = applySavedKey(entry, savedKey);

    // cli-bridge known models = ['auto', 'opencode', 'copilot', 'gemini']
    expect(next.model).toBe('auto');
  });

  it('falls back to "" when entry.model is empty AND KNOWN_MODELS is empty for the provider', () => {
    // Construct a synthetic state with an unknown provider to exercise the
    // `?? []` fallback. We cast through unknown to bypass the SaaSProvider
    // type guard — runtime callers can never hit this with real types, but
    // the helper must remain defensive.
    const entry = {
      ...createEntry({ model: '' }),
      provider: 'unknown-provider' as unknown as ProviderEntryState['provider'],
    };

    const next = applySavedKey(entry, savedKey);

    expect(next.model).toBe('');
    expect(next.availableModels).toEqual([]);
  });

  it('keeps unrelated entry fields unchanged (id, provider, cliModel, gatewayUrl)', () => {
    const entry = createEntry({
      id: 'entry-7',
      provider: 'cli-bridge',
      model: 'opencode',
      cliModel: 'anthropic/claude-sonnet-4-5',
      gatewayUrl: 'https://example.test',
    });

    const next = applySavedKey(entry, savedKey);

    expect(next.id).toBe('entry-7');
    expect(next.provider).toBe('cli-bridge');
    expect(next.cliModel).toBe('anthropic/claude-sonnet-4-5');
    expect(next.gatewayUrl).toBe('https://example.test');
  });

  it('does not mutate the input entry (returns a new object)', () => {
    const entry = createEntry({ provider: 'gateway', apiKey: 'sk-old' });
    const snapshot = { ...entry };

    const next = applySavedKey(entry, savedKey);

    expect(entry).toEqual(snapshot); // original unchanged
    expect(next).not.toBe(entry);
  });
});
