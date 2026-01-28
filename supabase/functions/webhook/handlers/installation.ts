/**
 * Installation Handler
 *
 * Handles GitHub App installation and uninstallation events.
 * - Creates installation records when app is installed
 * - Creates default repo configs for each repository
 * - Cleans up data when app is uninstalled
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  Installation,
  InstallationInsert,
  RepoConfigInsert,
} from '../../_shared/types/database.ts';
import type {
  InstallationEventPayload,
  GitHubRepositoryShort,
} from '../../_shared/types/github.ts';

/**
 * Result type for handler operations
 */
export interface HandlerResult {
  success: boolean;
  message: string;
  data?: {
    installation_id?: number;
    repos_configured?: number;
  };
}

/**
 * Creates a Supabase client with service role for database operations
 */
function getSupabaseClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    throw new Error('Missing Supabase configuration');
  }

  return createClient(url, key);
}

/**
 * Handles installation created event
 *
 * When a GitHub App is installed:
 * 1. Stores the installation record in the database
 * 2. Creates default repo configs for each repository
 */
export async function handleInstallationCreated(
  payload: InstallationEventPayload
): Promise<HandlerResult> {
  const supabase = getSupabaseClient();
  const { installation, repositories } = payload;

  // Prepare installation record
  const installationData: InstallationInsert = {
    id: installation.id,
    account_login: installation.account.login,
    account_type: installation.target_type,
    account_avatar_url: installation.account.avatar_url,
  };

  // Insert installation record
  const { error: installError } = await supabase
    .from('installations')
    .upsert(installationData, { onConflict: 'id' });

  if (installError) {
    console.error('Failed to create installation:', installError);
    return {
      success: false,
      message: `Failed to create installation: ${installError.message}`,
    };
  }

  // Create default configs for repositories
  let reposConfigured = 0;
  if (repositories && repositories.length > 0) {
    const configResult = await createDefaultConfigs(
      supabase,
      installation.id,
      repositories
    );
    reposConfigured = configResult.count;
  }

  console.log(
    `Installation ${installation.id} created for ${installation.account.login} with ${reposConfigured} repos`
  );

  return {
    success: true,
    message: `Installation created successfully`,
    data: {
      installation_id: installation.id,
      repos_configured: reposConfigured,
    },
  };
}

/**
 * Handles installation deleted event
 *
 * When a GitHub App is uninstalled:
 * 1. Removes all repo configs for this installation (cascade delete)
 * 2. Removes the installation record
 * Note: Related reviews, threads, and hebbian data are also cascade deleted
 */
export async function handleInstallationDeleted(
  payload: InstallationEventPayload
): Promise<HandlerResult> {
  const supabase = getSupabaseClient();
  const { installation } = payload;

  // Delete installation (cascade will clean up repo_configs and related data)
  const { error: deleteError } = await supabase
    .from('installations')
    .delete()
    .eq('id', installation.id);

  if (deleteError) {
    console.error('Failed to delete installation:', deleteError);
    return {
      success: false,
      message: `Failed to delete installation: ${deleteError.message}`,
    };
  }

  console.log(
    `Installation ${installation.id} deleted for ${installation.account.login}`
  );

  return {
    success: true,
    message: `Installation deleted successfully`,
    data: {
      installation_id: installation.id,
    },
  };
}

/**
 * Creates default repository configurations
 *
 * For each repository in the installation, creates a repo_config with:
 * - Default file patterns for common source files
 * - Default exclude patterns for tests and node_modules
 * - Advanced features (workflow, consensus, hebbian) disabled by default
 */
export async function createDefaultConfigs(
  supabase: SupabaseClient,
  installationId: number,
  repositories: GitHubRepositoryShort[]
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  // Prepare repo config records
  const configs: RepoConfigInsert[] = repositories.map((repo) => ({
    installation_id: installationId,
    repo_full_name: repo.full_name,
    enabled: true,
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    file_patterns: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.py', '*.go', '*.rs'],
    exclude_patterns: [
      '*.test.*',
      '*.spec.*',
      '__tests__/*',
      'node_modules/*',
      'dist/*',
      'build/*',
      '.git/*',
    ],
    workflow_enabled: false,
    consensus_enabled: false,
    hebbian_enabled: false,
  }));

  // Insert all configs, ignoring duplicates
  const { data, error } = await supabase
    .from('repo_configs')
    .upsert(configs, {
      onConflict: 'repo_full_name',
      ignoreDuplicates: true,
    })
    .select('id');

  if (error) {
    console.error('Failed to create repo configs:', error);
    errors.push(error.message);
  } else {
    successCount = data?.length ?? configs.length;
  }

  return {
    count: successCount,
    errors,
  };
}

/**
 * Main installation event router
 *
 * Routes installation events to appropriate handlers based on action
 */
export async function handleInstallationEvent(
  payload: InstallationEventPayload
): Promise<HandlerResult> {
  const { action } = payload;

  switch (action) {
    case 'created':
      return handleInstallationCreated(payload);

    case 'deleted':
      return handleInstallationDeleted(payload);

    case 'suspend':
      // Mark installation as suspended (could add suspended_at field later)
      console.log(`Installation ${payload.installation.id} suspended`);
      return {
        success: true,
        message: 'Installation suspended (no action taken)',
      };

    case 'unsuspend':
      // Mark installation as active again
      console.log(`Installation ${payload.installation.id} unsuspended`);
      return {
        success: true,
        message: 'Installation unsuspended (no action taken)',
      };

    case 'new_permissions_accepted':
      // Log permission changes
      console.log(
        `Installation ${payload.installation.id} accepted new permissions`
      );
      return {
        success: true,
        message: 'New permissions accepted (no action taken)',
      };

    default:
      console.warn(`Unknown installation action: ${action}`);
      return {
        success: false,
        message: `Unknown installation action: ${action}`,
      };
  }
}
