export type ReviewStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'in_progress';

export interface Review {
  id: string;
  repo_full_name: string;
  pr_number: number;
  pr_title?: string;
  status: ReviewStatus;
  result_summary: string;
  files_reviewed: string[];
  created_at: string;
  updated_at?: string;
}

export interface DashboardStats {
  totalReviews: number;
  passedReviews: number;
  failedReviews: number;
  pendingReviews: number;
  passRate: number;
  reviewsOverTime: TimelineDataPoint[];
}

export interface TimelineDataPoint {
  date: string;
  reviews: number;
  passed: number;
  failed: number;
}
