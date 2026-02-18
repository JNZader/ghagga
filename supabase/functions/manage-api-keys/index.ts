/**
 * Manage API Keys Edge Function
 *
 * Allows authenticated users to save/remove encrypted API keys for their repos.
 * Keys are encrypted with AES-256-GCM before storage.
 * NEVER returns the actual key — only the configured status.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { encrypt } from '../_shared/crypto/encryption.ts';

const VALID_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

const PROVIDER_COLUMN_MAP: Record<Provider, string> = {
  anthropic: 'anthropic_api_key_encrypted',
  openai: 'openai_api_key_encrypted',
  google: 'google_ai_api_key_encrypted',
};

const API_KEY_PREFIX_MAP: Record<Provider, RegExp> = {
  anthropic: /^sk-ant-/,
  openai: /^sk-/,
  google: /^AIza/,
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Extract user JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create user-scoped client to verify auth
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { repo_config_id, provider, api_key } = body as {
      repo_config_id: string;
      provider: string;
      api_key?: string | null;
    };

    if (!repo_config_id || !provider) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: repo_config_id, provider' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!UUID_REGEX.test(repo_config_id)) {
      return new Response(
        JSON.stringify({ error: 'Invalid repo_config_id format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!VALID_PROVIDERS.includes(provider as Provider)) {
      return new Response(
        JSON.stringify({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate API key format if saving
    if (api_key && api_key.trim().length > 0) {
      const expectedPrefix = API_KEY_PREFIX_MAP[provider as Provider];
      if (expectedPrefix && !expectedPrefix.test(api_key.trim())) {
        return new Response(
          JSON.stringify({ error: `Invalid API key format for provider ${provider}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Verify user owns this repo via github_user_mappings
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) {
      console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Get the repo config to check ownership
    const { data: repoConfig, error: repoError } = await serviceClient
      .from('repo_configs')
      .select('id, installation_id, api_keys_configured')
      .eq('id', repo_config_id)
      .single();

    if (repoError || !repoConfig) {
      return new Response(
        JSON.stringify({ error: 'Repository configuration not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify user has access to this installation
    const { data: mapping, error: mappingError } = await serviceClient
      .from('github_user_mappings')
      .select('id')
      .eq('supabase_user_id', user.id)
      .eq('installation_id', repoConfig.installation_id)
      .single();

    if (mappingError || !mapping) {
      return new Response(
        JSON.stringify({ error: 'You do not have access to this repository' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Prepare update
    const column = PROVIDER_COLUMN_MAP[provider as Provider];
    const apiKeysConfigured = { ...(repoConfig.api_keys_configured || {}) };

    let encryptedKey: string | null = null;
    if (api_key && api_key.trim().length > 0) {
      // Save: encrypt and store
      encryptedKey = await encrypt(api_key.trim());
      apiKeysConfigured[provider] = true;
    } else {
      // Remove: set to null
      encryptedKey = null;
      apiKeysConfigured[provider] = false;
    }

    // Update using service_role (bypasses the trigger protection)
    const { error: updateError } = await serviceClient
      .from('repo_configs')
      .update({
        [column]: encryptedKey,
        api_keys_configured: apiKeysConfigured,
      })
      .eq('id', repo_config_id);

    if (updateError) {
      console.error('Failed to update API key:', updateError);
      return new Response(
        JSON.stringify({ error: 'Failed to save API key' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        api_keys_configured: apiKeysConfigured,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('manage-api-keys error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
