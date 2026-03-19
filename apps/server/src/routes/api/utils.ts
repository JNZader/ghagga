/**
 * Shared helpers for the dashboard API routes.
 */

import { randomUUID } from 'node:crypto';
import type { DbProviderChainEntry } from 'ghagga-db';
import { decrypt } from 'ghagga-db';
import { logger as rootLogger } from '../../lib/logger.js';

export const logger = rootLogger.child({ module: 'api' });

/**
 * Generate a short error ID for support correlation.
 * Used in 500 responses so users can report the ID to support.
 */
export function generateErrorId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Mask an API key for safe display.
 * Shows the first 3 chars and last 4 chars: "sk-...xxxx"
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  const prefix = key.slice(0, 3);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

/**
 * Build a safe provider chain view for API responses.
 * Decrypts and masks API keys — never exposes raw encrypted values.
 */
export function buildProviderChainView(chain: DbProviderChainEntry[]) {
  return chain.map((entry) => {
    const view: {
      provider: typeof entry.provider;
      model: string;
      hasApiKey: boolean;
      maskedApiKey?: string;
      cliModel?: string;
      gatewayUrl?: string;
    } = {
      provider: entry.provider,
      model: entry.model,
      hasApiKey: entry.encryptedApiKey != null,
      maskedApiKey: entry.encryptedApiKey ? maskApiKey(decrypt(entry.encryptedApiKey)) : undefined,
    };
    // Only include cliModel when present (don't add undefined to every entry)
    if (entry.cliModel) {
      view.cliModel = entry.cliModel;
    }
    // Only include gatewayUrl when present (gateway provider entries)
    if (entry.gatewayUrl) {
      view.gatewayUrl = entry.gatewayUrl;
    }
    return view;
  });
}
