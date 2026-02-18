import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';

export type ObservationType =
  | 'decision'
  | 'architecture'
  | 'bugfix'
  | 'pattern'
  | 'config'
  | 'discovery'
  | 'learning'
  | 'session_summary';

export interface MemorySession {
  id: string;
  installation_id: number | null;
  repo_full_name: string;
  pr_number: number;
  session_name: string;
  status: string;
  summary: string | null;
  started_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryObservation {
  id: string;
  session_id: string;
  repo_full_name: string;
  observation_type: ObservationType;
  title: string;
  content: string;
  content_stripped: string | null;
  what_happened: string | null;
  why_it_matters: string | null;
  where_in_code: string | null;
  what_was_learned: string | null;
  tags: string[];
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ObservationStats {
  totalSessions: number;
  totalObservations: number;
  typeBreakdown: Record<string, number>;
}

interface UseMemoryObservationsOptions {
  repoFullName?: string;
  limit?: number;
}

interface UseMemoryObservationsReturn {
  sessions: MemorySession[];
  observations: MemoryObservation[];
  selectedSession: string | null;
  stats: ObservationStats | null;
  loading: boolean;
  error: Error | null;
  selectSession: (sessionId: string | null) => void;
  searchMemory: (query: string) => void;
  searchQuery: string;
  refetch: () => Promise<void>;
}

export function useMemoryObservations(
  options: UseMemoryObservationsOptions = {}
): UseMemoryObservationsReturn {
  const { repoFullName, limit = 50 } = options;

  const [sessions, setSessions] = useState<MemorySession[]>([]);
  const [observations, setObservations] = useState<MemoryObservation[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [stats, setStats] = useState<ObservationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchSessions = useCallback(async () => {
    try {
      let query = supabase
        .from('memory_sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (repoFullName) {
        query = query.eq('repo_full_name', repoFullName);
      }

      const { data, error: queryError } = await query;
      if (queryError) throw new Error(queryError.message);
      setSessions(data || []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch sessions'));
    }
  }, [repoFullName, limit]);

  const fetchObservations = useCallback(
    async (sessionId?: string) => {
      try {
        let query = supabase
          .from('memory_observations')
          .select('*')
          .order('created_at', { ascending: true });

        if (sessionId) {
          query = query.eq('session_id', sessionId);
        } else if (repoFullName) {
          query = query.eq('repo_full_name', repoFullName);
        }

        query = query.limit(limit);

        const { data, error: queryError } = await query;
        if (queryError) throw new Error(queryError.message);
        setObservations(data || []);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to fetch observations'));
      }
    },
    [repoFullName, limit]
  );

  const fetchStats = useCallback(async () => {
    try {
      let sessionsQuery = supabase
        .from('memory_sessions')
        .select('id', { count: 'exact', head: true });

      let obsQuery = supabase
        .from('memory_observations')
        .select('observation_type');

      if (repoFullName) {
        sessionsQuery = sessionsQuery.eq('repo_full_name', repoFullName);
        obsQuery = obsQuery.eq('repo_full_name', repoFullName);
      }

      const [sessionsResult, obsResult] = await Promise.all([sessionsQuery, obsQuery]);

      const obsData = obsResult.data || [];
      const typeBreakdown: Record<string, number> = {};
      for (const obs of obsData) {
        typeBreakdown[obs.observation_type] = (typeBreakdown[obs.observation_type] || 0) + 1;
      }

      setStats({
        totalSessions: sessionsResult.count || 0,
        totalObservations: obsData.length,
        typeBreakdown,
      });
    } catch (err) {
      console.error('Failed to fetch observation stats:', err);
    }
  }, [repoFullName]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchSessions(), fetchStats(), fetchObservations()]).finally(() =>
      setLoading(false)
    );
  }, [fetchSessions, fetchStats, fetchObservations]);

  const selectSession = useCallback(
    (sessionId: string | null) => {
      setSelectedSession(sessionId);
      if (sessionId) {
        fetchObservations(sessionId);
      } else {
        fetchObservations();
      }
    },
    [fetchObservations]
  );

  const searchMemory = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchSessions(), fetchStats(), fetchObservations(selectedSession || undefined)]);
    setLoading(false);
  }, [fetchSessions, fetchStats, fetchObservations, selectedSession]);

  const filteredObservations = searchQuery
    ? observations.filter(
        (obs) =>
          obs.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (obs.what_happened || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (obs.what_was_learned || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          obs.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : observations;

  return {
    sessions,
    observations: filteredObservations,
    selectedSession,
    stats,
    loading,
    error,
    selectSession,
    searchMemory,
    searchQuery,
    refetch,
  };
}
