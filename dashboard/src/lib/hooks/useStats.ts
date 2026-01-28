import { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import type { DashboardStats, Review, TimelineDataPoint } from '../types';

interface UseStatsResult {
  stats: DashboardStats | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function groupReviewsByDate(reviews: Review[]): TimelineDataPoint[] {
  const grouped = new Map<string, { reviews: number; passed: number; failed: number }>();

  reviews.forEach((review) => {
    const date = new Date(review.created_at).toISOString().split('T')[0];
    const existing = grouped.get(date) || { reviews: 0, passed: 0, failed: 0 };
    existing.reviews += 1;
    if (review.status === 'passed') existing.passed += 1;
    if (review.status === 'failed') existing.failed += 1;
    grouped.set(date, existing);
  });

  return Array.from(grouped.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);
}

export function useStats(): UseStatsResult {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);

    try {
      const { data: reviews, error: fetchError } = await supabase
        .from('reviews')
        .select('id, repo_full_name, pr_number, status, result_summary, files_reviewed, created_at')
        .order('created_at', { ascending: false });

      if (fetchError) {
        throw new Error(fetchError.message);
      }

      const reviewList = (reviews || []) as Review[];
      const totalReviews = reviewList.length;
      const passedReviews = reviewList.filter((r) => r.status === 'passed').length;
      const failedReviews = reviewList.filter((r) => r.status === 'failed').length;
      const pendingReviews = reviewList.filter((r) => r.status === 'pending' || r.status === 'in_progress').length;
      const passRate = totalReviews > 0 ? Math.round((passedReviews / totalReviews) * 100) : 0;
      const reviewsOverTime = groupReviewsByDate(reviewList);

      setStats({
        totalReviews,
        passedReviews,
        failedReviews,
        pendingReviews,
        passRate,
        reviewsOverTime,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  return { stats, loading, error, refetch: fetchStats };
}
