/**
 * Provider resolution helper tests.
 *
 * Covers the read-time migration of legacy stored providers (e.g. 'github'
 * saved by an old "ghagga login") to 'gateway', so first-run users with a
 * stale config get a working review instead of a hard exit.
 */

import { describe, expect, it } from 'vitest';
import { isLegacyProvider, LEGACY_CLI_PROVIDERS, remapLegacyStoredProvider } from './providers.js';

describe('isLegacyProvider', () => {
  it('returns true for all legacy providers', () => {
    for (const provider of LEGACY_CLI_PROVIDERS) {
      expect(isLegacyProvider(provider)).toBe(true);
    }
  });

  it('returns false for current providers', () => {
    expect(isLegacyProvider('gateway')).toBe(false);
    expect(isLegacyProvider('cli-bridge')).toBe(false);
    expect(isLegacyProvider('ollama')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLegacyProvider(undefined)).toBe(false);
  });
});

describe('remapLegacyStoredProvider', () => {
  it("remaps stored 'github' (old login default) to 'gateway'", () => {
    expect(remapLegacyStoredProvider('github')).toEqual({
      provider: 'gateway',
      remapped: true,
    });
  });

  it('remaps every legacy provider to gateway', () => {
    for (const provider of LEGACY_CLI_PROVIDERS) {
      const result = remapLegacyStoredProvider(provider);
      expect(result.provider).toBe('gateway');
      expect(result.remapped).toBe(true);
    }
  });

  it('passes current providers through untouched', () => {
    expect(remapLegacyStoredProvider('gateway')).toEqual({
      provider: 'gateway',
      remapped: false,
    });
    expect(remapLegacyStoredProvider('ollama')).toEqual({
      provider: 'ollama',
      remapped: false,
    });
    expect(remapLegacyStoredProvider('cli-bridge')).toEqual({
      provider: 'cli-bridge',
      remapped: false,
    });
  });

  it('passes unknown strings through (validated downstream)', () => {
    expect(remapLegacyStoredProvider('not-a-provider')).toEqual({
      provider: 'not-a-provider',
      remapped: false,
    });
  });
});
