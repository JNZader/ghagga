/**
 * Per-repo credential loader
 *
 * Loads and decrypts API keys stored per-repo in repo_configs.
 * Falls back gracefully — if no per-repo keys, returns empty object
 * so providers use their env var defaults.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '../crypto/encryption.ts';
import type { PerRepoCredentials } from './registry.ts';

/**
 * Load decrypted per-repo API keys for a given repository
 *
 * @param repoFullName - Full repo name (e.g., "owner/repo")
 * @param supabaseClient - Supabase client (service_role to read encrypted columns)
 * @returns Decrypted credentials map, empty object if none configured
 */
export async function getRepoCredentials(
  repoFullName: string,
  supabaseClient: SupabaseClient
): Promise<PerRepoCredentials> {
  try {
    const { data, error } = await supabaseClient
      .from('repo_configs')
      .select('anthropic_api_key_encrypted, openai_api_key_encrypted, google_ai_api_key_encrypted')
      .eq('repo_full_name', repoFullName)
      .single();

    if (error || !data) {
      return {};
    }

    const credentials: PerRepoCredentials = {};

    if (data.anthropic_api_key_encrypted) {
      try {
        credentials.anthropic = await decrypt(data.anthropic_api_key_encrypted);
      } catch {
        console.warn(`Failed to decrypt Anthropic key for ${repoFullName}`);
      }
    }

    if (data.openai_api_key_encrypted) {
      try {
        credentials.openai = await decrypt(data.openai_api_key_encrypted);
      } catch {
        console.warn(`Failed to decrypt OpenAI key for ${repoFullName}`);
      }
    }

    if (data.google_ai_api_key_encrypted) {
      try {
        credentials.google = await decrypt(data.google_ai_api_key_encrypted);
      } catch {
        console.warn(`Failed to decrypt Google AI key for ${repoFullName}`);
      }
    }

    return credentials;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`Failed to load credentials for ${repoFullName}: ${message}`);
    return {};
  }
}
