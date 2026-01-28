import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  InstallationEventPayload,
  InstallationRepositoriesEventPayload,
  GitHubRepositoryShort,
} from '../../_shared/types/github.ts';
import type {
  InstallationInsert,
  RepoConfigInsert,
} from '../../_shared/types/database.ts';

export interface HandlerResult {
  success: boolean;
  message: string;
  action?: string;
  installationId?: number;
  accountLogin?: string;
  repositoriesAffected?: number;
  data?: {
    repos_configured?: number;
  };
}

function getSupabaseClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing Supabase configuration');
  return createClient(url, key);
}

export async function handleInstallationEvent(
  payload: InstallationEventPayload,
  deliveryId: string
): Promise<HandlerResult> {
  const { action, installation, repositories } = payload;
  const accountLogin = installation.account.login;
  const supabase = getSupabaseClient();

  switch (action) {
    case 'created': {
      // Insert installation record
      const installationData: InstallationInsert = {
        id: installation.id,
        account_login: accountLogin,
        account_type: installation.target_type,
        account_avatar_url: installation.account.avatar_url,
      };
      await supabase.from('installations').upsert(installationData, { onConflict: 'id' });

      // Create default repo configs
      let reposConfigured = 0;
      if (repositories?.length) {
        const configResult = await createDefaultConfigs(supabase, installation.id, repositories);
        reposConfigured = configResult.count;
      }

      return {
        success: true,
        message: 'Installation created successfully',
        action,
        installationId: installation.id,
        accountLogin,
        repositoriesAffected: repositories?.length || 0,
        data: { repos_configured: reposConfigured },
      };
    }

    case 'deleted': {
      await supabase.from('installations').delete().eq('id', installation.id);
      return {
        success: true,
        message: 'Installation deleted',
        action,
        installationId: installation.id,
        accountLogin,
      };
    }

    case 'suspend':
      return { success: true, message: 'Installation suspended', action };

    case 'unsuspend':
      return { success: true, message: 'Installation unsuspended', action };

    case 'new_permissions_accepted':
      return { success: true, message: 'Permissions updated', action };

    default:
      return { success: false, message: `Unknown action: ${action}`, action };
  }
}

export async function handleInstallationRepositories(
  payload: InstallationRepositoriesEventPayload,
  deliveryId: string
): Promise<HandlerResult> {
  const { action, installation, repositories_added, repositories_removed } = payload;
  const supabase = getSupabaseClient();

  // Add repos
  if (repositories_added.length) {
    await createDefaultConfigs(supabase, installation.id, repositories_added);
  }

  // Remove repos
  if (repositories_removed.length) {
    await supabase
      .from('repo_configs')
      .update({ enabled: false })
      .in('repo_full_name', repositories_removed.map((r) => r.full_name));
  }

  return {
    success: true,
    message: `Repositories updated: ${repositories_added.length} added, ${repositories_removed.length} removed`,
    action,
    installationId: installation.id,
    accountLogin: installation.account.login,
    repositoriesAffected: repositories_added.length + repositories_removed.length,
  };
}

async function createDefaultConfigs(
  supabase: SupabaseClient,
  installationId: number,
  repositories: GitHubRepositoryShort[]
): Promise<{ count: number; errors: string[] }> {
  const configs: RepoConfigInsert[] = repositories.map((repo) => ({
    installation_id: installationId,
    repo_full_name: repo.full_name,
    enabled: true,
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    file_patterns: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.py', '*.go', '*.rs'],
    exclude_patterns: ['*.test.*', '*.spec.*', '__tests__/*', 'node_modules/*', 'dist/*'],
    workflow_enabled: false,
    consensus_enabled: false,
    hebbian_enabled: false,
  }));

  const { data, error } = await supabase.from('repo_configs').upsert(configs, {
    onConflict: 'repo_full_name',
    ignoreDuplicates: true,
  }).select('id');

  return { count: data?.length ?? configs.length, errors: error ? [error.message] : [] };
}
