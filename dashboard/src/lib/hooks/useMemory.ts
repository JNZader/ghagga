import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type AssociationType = 'code_pattern' | 'review_pattern' | 'error_fix' | 'style_preference';

export interface HebbianAssociation {
  id: string;
  installation_id: number | null;
  repo_full_name: string;
  source_pattern: string;
  target_pattern: string;
  association_type: AssociationType;
  weight: number;
  activation_count: number;
  last_activated_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NetworkStats {
  totalConnections: number;
  avgWeight: number;
  strongConnections: number;
  recentActivations: number;
  typeBreakdown: Record<AssociationType, number>;
}

interface UseMemoryOptions {
  repoFullName?: string;
  minWeight?: number;
  associationType?: AssociationType;
  limit?: number;
}

interface UseMemoryReturn {
  associations: HebbianAssociation[];
  stats: NetworkStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  filterByPattern: (pattern: string) => void;
  filterPattern: string;
}

export function useMemory(options: UseMemoryOptions = {}): UseMemoryReturn {
  const { repoFullName, minWeight = 0, associationType, limit = 50 } = options;

  const [associations, setAssociations] = useState<HebbianAssociation[]>([]);
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [filterPattern, setFilterPattern] = useState('');

  const fetchAssociations = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let query = supabase
        .from('hebbian_associations')
        .select('*')
        .gte('weight', minWeight)
        .order('weight', { ascending: false })
        .limit(limit);

      if (repoFullName) {
        query = query.eq('repo_full_name', repoFullName);
      }

      if (associationType) {
        query = query.eq('association_type', associationType);
      }

      const { data, error: queryError } = await query;

      if (queryError) {
        throw new Error(queryError.message);
      }

      setAssociations(data || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch associations'));
    } finally {
      setLoading(false);
    }
  }, [repoFullName, minWeight, associationType, limit]);

  const fetchStats = useCallback(async () => {
    try {
      let query = supabase
        .from('hebbian_associations')
        .select('weight, association_type, last_activated_at');

      if (repoFullName) {
        query = query.eq('repo_full_name', repoFullName);
      }

      const { data, error: queryError } = await query;

      if (queryError) {
        throw new Error(queryError.message);
      }

      if (!data || data.length === 0) {
        setStats({
          totalConnections: 0,
          avgWeight: 0,
          strongConnections: 0,
          recentActivations: 0,
          typeBreakdown: {
            code_pattern: 0,
            review_pattern: 0,
            error_fix: 0,
            style_preference: 0,
          },
        });
        return;
      }

      const totalConnections = data.length;
      const avgWeight = data.reduce((sum, a) => sum + a.weight, 0) / totalConnections;
      const strongConnections = data.filter((a) => a.weight >= 0.7).length;

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentActivations = data.filter(
        (a) => a.last_activated_at && a.last_activated_at > oneDayAgo
      ).length;

      const typeBreakdown = data.reduce(
        (acc, a) => {
          const type = a.association_type as AssociationType;
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        },
        {
          code_pattern: 0,
          review_pattern: 0,
          error_fix: 0,
          style_preference: 0,
        } as Record<AssociationType, number>
      );

      setStats({
        totalConnections,
        avgWeight,
        strongConnections,
        recentActivations,
        typeBreakdown,
      });
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, [repoFullName]);

  useEffect(() => {
    fetchAssociations();
    fetchStats();
  }, [fetchAssociations, fetchStats]);

  const refetch = useCallback(async () => {
    await Promise.all([fetchAssociations(), fetchStats()]);
  }, [fetchAssociations, fetchStats]);

  const filterByPattern = useCallback((pattern: string) => {
    setFilterPattern(pattern);
  }, []);

  const filteredAssociations = filterPattern
    ? associations.filter(
        (a) =>
          a.source_pattern.toLowerCase().includes(filterPattern.toLowerCase()) ||
          a.target_pattern.toLowerCase().includes(filterPattern.toLowerCase())
      )
    : associations;

  return {
    associations: filteredAssociations,
    stats,
    loading,
    error,
    refetch,
    filterByPattern,
    filterPattern,
  };
}
