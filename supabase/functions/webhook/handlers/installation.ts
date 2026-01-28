/**
 * Installation Event Handler
 *
 * Handles GitHub App installation and repository events.
 * Manages app installations, repository access changes, and related state.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type {
  InstallationEventPayload,
  InstallationRepositoriesEventPayload,
} from '../../_shared/types/index.ts';

/**
 * Result of installation event handling
 */
export interface InstallationResult {
  success: boolean;
  message: string;
  action: string;
  installationId: number;
  accountLogin: string;
  repositoriesAffected?: number;
}

/**
 * Get Supabase client for database operations
 */
function getSupabaseClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase credentials not configured');
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

/**
 * Handle GitHub App installation events
 *
 * Actions: created, deleted, suspend, unsuspend, new_permissions_accepted
 */
export async function handleInstallation(
  payload: InstallationEventPayload,
  deliveryId: string
): Promise<InstallationResult> {
  const { action, installation } = payload;
  const accountLogin = installation.account.login;

  console.log(
    `[${deliveryId}] Installation ${action} for ${accountLogin} (ID: ${installation.id})`
  );

  try {
    const supabase = getSupabaseClient();

    switch (action) {
      case 'created': {
        // Record new installation
        const { error } = await supabase.from('installations').upsert({
          installation_id: installation.id,
          account_login: accountLogin,
          account_type: installation.target_type.toLowerCase(),
          account_id: installation.target_id,
          repository_selection: installation.repository_selection,
          permissions: installation.permissions,
          events: installation.events,
          status: 'active',
          created_at: installation.created_at,
          updated_at: new Date().toISOString(),
        });

        if (error) {
          console.error(`[${deliveryId}] Failed to record installation:`, error);
          // Continue even if recording fails - don't block the webhook
        }

        // Record initial repositories if included
        if (payload.repositories && payload.repositories.length > 0) {
          const repoRecords = payload.repositories.map((repo) => ({
            installation_id: installation.id,
            repository_id: repo.id,
            repository_name: repo.name,
            repository_full_name: repo.full_name,
            is_private: repo.private,
            status: 'active',
            added_at: new Date().toISOString(),
          }));

          const { error: repoError } = await supabase
            .from('installation_repositories')
            .upsert(repoRecords);

          if (repoError) {
            console.error(`[${deliveryId}] Failed to record repositories:`, repoError);
          }
        }

        return {
          success: true,
          message: 'Installation created successfully',
          action,
          installationId: installation.id,
          accountLogin,
          repositoriesAffected: payload.repositories?.length || 0,
        };
      }

      case 'deleted': {
        // Mark installation as deleted
        const { error } = await supabase
          .from('installations')
          .update({
            status: 'deleted',
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', installation.id);

        if (error) {
          console.error(`[${deliveryId}] Failed to update installation status:`, error);
        }

        // Mark all repositories as removed
        const { error: repoError } = await supabase
          .from('installation_repositories')
          .update({
            status: 'removed',
            removed_at: new Date().toISOString(),
          })
          .eq('installation_id', installation.id);

        if (repoError) {
          console.error(`[${deliveryId}] Failed to update repository status:`, repoError);
        }

        return {
          success: true,
          message: 'Installation deleted',
          action,
          installationId: installation.id,
          accountLogin,
        };
      }

      case 'suspend': {
        // Mark installation as suspended
        const { error } = await supabase
          .from('installations')
          .update({
            status: 'suspended',
            suspended_at: installation.suspended_at,
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', installation.id);

        if (error) {
          console.error(`[${deliveryId}] Failed to suspend installation:`, error);
        }

        return {
          success: true,
          message: 'Installation suspended',
          action,
          installationId: installation.id,
          accountLogin,
        };
      }

      case 'unsuspend': {
        // Reactivate installation
        const { error } = await supabase
          .from('installations')
          .update({
            status: 'active',
            suspended_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', installation.id);

        if (error) {
          console.error(`[${deliveryId}] Failed to unsuspend installation:`, error);
        }

        return {
          success: true,
          message: 'Installation reactivated',
          action,
          installationId: installation.id,
          accountLogin,
        };
      }

      case 'new_permissions_accepted': {
        // Update permissions
        const { error } = await supabase
          .from('installations')
          .update({
            permissions: installation.permissions,
            events: installation.events,
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', installation.id);

        if (error) {
          console.error(`[${deliveryId}] Failed to update permissions:`, error);
        }

        return {
          success: true,
          message: 'Permissions updated',
          action,
          installationId: installation.id,
          accountLogin,
        };
      }

      default:
        return {
          success: true,
          message: `Unhandled installation action: ${action}`,
          action,
          installationId: installation.id,
          accountLogin,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${deliveryId}] Installation handler error:`, errorMessage);

    return {
      success: false,
      message: `Error handling installation: ${errorMessage}`,
      action,
      installationId: installation.id,
      accountLogin,
    };
  }
}

/**
 * Handle repository added/removed events for an installation
 */
export async function handleInstallationRepositories(
  payload: InstallationRepositoriesEventPayload,
  deliveryId: string
): Promise<InstallationResult> {
  const { action, installation, repositories_added, repositories_removed } = payload;
  const accountLogin = installation.account.login;

  console.log(
    `[${deliveryId}] Installation repositories ${action} for ${accountLogin} ` +
      `(added: ${repositories_added.length}, removed: ${repositories_removed.length})`
  );

  try {
    const supabase = getSupabaseClient();

    // Handle added repositories
    if (repositories_added.length > 0) {
      const addedRecords = repositories_added.map((repo) => ({
        installation_id: installation.id,
        repository_id: repo.id,
        repository_name: repo.name,
        repository_full_name: repo.full_name,
        is_private: repo.private,
        status: 'active',
        added_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from('installation_repositories')
        .upsert(addedRecords);

      if (error) {
        console.error(`[${deliveryId}] Failed to add repositories:`, error);
      }
    }

    // Handle removed repositories
    if (repositories_removed.length > 0) {
      const removedIds = repositories_removed.map((repo) => repo.id);

      const { error } = await supabase
        .from('installation_repositories')
        .update({
          status: 'removed',
          removed_at: new Date().toISOString(),
        })
        .eq('installation_id', installation.id)
        .in('repository_id', removedIds);

      if (error) {
        console.error(`[${deliveryId}] Failed to remove repositories:`, error);
      }
    }

    // Update installation's repository selection if changed
    const { error: installError } = await supabase
      .from('installations')
      .update({
        repository_selection: payload.repository_selection,
        updated_at: new Date().toISOString(),
      })
      .eq('installation_id', installation.id);

    if (installError) {
      console.error(`[${deliveryId}] Failed to update installation:`, installError);
    }

    return {
      success: true,
      message: `Repositories updated: ${repositories_added.length} added, ${repositories_removed.length} removed`,
      action,
      installationId: installation.id,
      accountLogin,
      repositoriesAffected: repositories_added.length + repositories_removed.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${deliveryId}] Installation repositories handler error:`, errorMessage);

    return {
      success: false,
      message: `Error handling repositories: ${errorMessage}`,
      action,
      installationId: installation.id,
      accountLogin,
    };
  }
}
