import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';

export interface RepoConfig {
  id: string;
  installation_id: number;
  repo_full_name: string;
  enabled: boolean;
  provider: string;
  model: string;
  rules: string | null;
  file_patterns: string[];
  exclude_patterns: string[];
  workflow_enabled: boolean;
  consensus_enabled: boolean;
  hebbian_enabled: boolean;
  static_analysis_enabled: boolean;
  ai_attribution_check: boolean;
  security_patterns_check: boolean;
  semgrep_service_url: string;
  commit_message_check: boolean;
  stack_aware_prompts: boolean;
  created_at: string;
  updated_at: string;
}

export interface Installation {
  id: number;
  account_login: string;
  account_type: 'User' | 'Organization';
  account_avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

interface UseSettingsReturn {
  installations: Installation[];
  repoConfigs: RepoConfig[];
  selectedRepo: RepoConfig | null;
  loading: boolean;
  error: string | null;
  selectRepo: (repoFullName: string) => void;
  updateRepoConfig: (id: string, updates: Partial<RepoConfig>) => Promise<void>;
  refreshData: () => Promise<void>;
}

export function useSettings(): UseSettingsReturn {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [repoConfigs, setRepoConfigs] = useState<RepoConfig[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepoConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [installationsRes, repoConfigsRes] = await Promise.all([
        supabase.from('installations').select('*').order('account_login'),
        supabase.from('repo_configs').select('*').order('repo_full_name'),
      ]);

      if (installationsRes.error) {
        throw new Error(`Failed to fetch installations: ${installationsRes.error.message}`);
      }
      if (repoConfigsRes.error) {
        throw new Error(`Failed to fetch repo configs: ${repoConfigsRes.error.message}`);
      }

      setInstallations(installationsRes.data || []);
      setRepoConfigs(repoConfigsRes.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectRepo = useCallback(
    (repoFullName: string) => {
      const repo = repoConfigs.find((r) => r.repo_full_name === repoFullName);
      setSelectedRepo(repo || null);
    },
    [repoConfigs]
  );

  const updateRepoConfig = useCallback(
    async (id: string, updates: Partial<RepoConfig>) => {
      setError(null);

      const { error: updateError } = await supabase
        .from('repo_configs')
        .update(updates)
        .eq('id', id);

      if (updateError) {
        setError(`Failed to update: ${updateError.message}`);
        throw updateError;
      }

      setRepoConfigs((prev) =>
        prev.map((config) =>
          config.id === id ? { ...config, ...updates } : config
        )
      );

      if (selectedRepo?.id === id) {
        setSelectedRepo((prev) => (prev ? { ...prev, ...updates } : null));
      }
    },
    [selectedRepo]
  );

  return {
    installations,
    repoConfigs,
    selectedRepo,
    loading,
    error,
    selectRepo,
    updateRepoConfig,
    refreshData: fetchData,
  };
}
