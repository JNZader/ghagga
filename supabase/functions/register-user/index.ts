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

  try {
    // Extract user JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

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
    const serviceClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Find installations where account_login matches the GitHub username
    const { data: installations, error: installError } = await serviceClient
      .from('installations')
      .select('id')
      .eq('account_login', githubUsername);

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
