export type ReviewStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'in_progress';

export interface Review {
  id: string;
  repo_full_name: string;
  pr_number: number;
  pr_title?: string;
  status: ReviewStatus;
  result_summary: string;
  result_full?: Record<string, unknown>;
  files_reviewed: string[];
  created_at: string;
  updated_at?: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

export interface ReviewFilters {
  status?: ReviewStatus;
  repo?: string;
  search?: string;
}
