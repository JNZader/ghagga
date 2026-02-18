/**
 * Register User Edge Function
 *
 * Called on login to create/update github_user_mappings.
 * Maps the Supabase user to their GitHub installations.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

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

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create user-scoped client to get user info
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

    // Extract GitHub identity from user metadata
    const githubUserId = user.user_metadata?.provider_id
      || user.identities?.find((i) => i.provider === 'github')?.id;
    const githubUsername = user.user_metadata?.user_name
      || user.user_metadata?.preferred_username;

    if (!githubUserId || !githubUsername) {
      return new Response(
        JSON.stringify({ error: 'GitHub identity not found in user metadata' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use service_role to read installations and write mappings
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) {
      console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Find installations by immutable account_id first, fallback to account_login
    let installations: { id: number }[] | null = null;
    let installError = null;

    // Try by numeric GitHub user ID (immutable, preferred)
    const { data: byId, error: byIdError } = await serviceClient
      .from('installations')
      .select('id')
      .eq('account_id', Number(githubUserId));

    if (!byIdError && byId && byId.length > 0) {
      installations = byId;
    } else {
      // Fallback to username (mutable, but works for older installations without account_id)
      const { data: byLogin, error: byLoginError } = await serviceClient
        .from('installations')
        .select('id')
        .eq('account_login', githubUsername);
      installations = byLogin;
      installError = byLoginError;
    }

    if (installError) {
      console.error('Failed to query installations:', installError);
      return new Response(
        JSON.stringify({ error: 'Failed to query installations' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Upsert mappings for each installation
    const mappings = (installations || []).map((inst) => ({
      supabase_user_id: user.id,
      github_user_id: Number(githubUserId),
      github_username: githubUsername,
      installation_id: inst.id,
    }));

    if (mappings.length > 0) {
      const { error: upsertError } = await serviceClient
        .from('github_user_mappings')
        .upsert(mappings, {
          onConflict: 'supabase_user_id,installation_id',
        });

      if (upsertError) {
        console.error('Failed to upsert mappings:', upsertError);
        return new Response(
          JSON.stringify({ error: 'Failed to create user mappings' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mappings_created: mappings.length,
        github_username: githubUsername,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('register-user error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
