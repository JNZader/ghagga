import { useState, useCallback, useEffect } from 'react';
import { supabase } from '../supabase';
import type { Review, ReviewStatus, PaginationState, ReviewFilters } from '../types';

interface UseReviewsReturn {
  reviews: Review[];
  loading: boolean;
  error: string | null;
  pagination: PaginationState;
  filters: ReviewFilters;
  repos: string[];
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (filters: ReviewFilters) => void;
  refresh: () => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 10;

export function useReviews(): UseReviewsReturn {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
  });
  const [filters, setFiltersState] = useState<ReviewFilters>({});

  const fetchRepos = useCallback(async () => {
    const { data } = await supabase
      .from('reviews')
      .select('repo_full_name');

    if (data) {
      const uniqueRepos = [...new Set(data.map(r => r.repo_full_name))];
      setRepos(uniqueRepos);
    }
  }, []);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let query = supabase
        .from('reviews')
        .select('*', { count: 'exact' });

      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      if (filters.repo) {
        query = query.eq('repo_full_name', filters.repo);
      }

      if (filters.search) {
        query = query.or(
          `result_summary.ilike.%${filters.search}%,pr_title.ilike.%${filters.search}%`
        );
      }

      const from = (pagination.page - 1) * pagination.pageSize;
      const to = from + pagination.pageSize - 1;

      query = query
        .order('created_at', { ascending: false })
        .range(from, to);

      const { data, error: queryError, count } = await query;

      if (queryError) {
        throw new Error(queryError.message);
      }

      setReviews(data || []);
      setPagination(prev => ({
        ...prev,
        total: count || 0,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch reviews');
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const setPage = useCallback((page: number) => {
    setPagination(prev => ({ ...prev, page }));
  }, []);

  const setPageSize = useCallback((pageSize: number) => {
    setPagination(prev => ({ ...prev, pageSize, page: 1 }));
  }, []);

  const setFilters = useCallback((newFilters: ReviewFilters) => {
    setFiltersState(newFilters);
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  return {
    reviews,
    loading,
    error,
    pagination,
    filters,
    repos,
    setPage,
    setPageSize,
    setFilters,
    refresh: fetchReviews,
  };
}
