/**
 * Database entity types for Supabase tables
 */

// Installation represents a GitHub App installation
export interface Installation {
  id: number;
  account_login: string;
  account_type: 'User' | 'Organization';
  account_avatar_url?: string;
  created_at: string;
  updated_at: string;
}

// Repository configuration for code review
export interface RepoConfig {
  id: string;
  installation_id: number;
  repo_full_name: string;
  enabled: boolean;
  provider: string;
  model: string;
  rules?: string;
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
  created_at?: string;
  updated_at?: string;
}

// Review status types
export type ReviewStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'in_progress';

// Review result from code analysis
export interface Review {
  id: string;
  repo_full_name: string;
  pr_number: number;
  pr_title?: string;
  status: ReviewStatus;
  result_summary: string;
  result_full?: Record<string, unknown>;
  files_reviewed: string[];
  embedding?: number[];
  thread_id?: string;
  created_at: string;
  updated_at?: string;
}

// File change in a review
export interface ReviewFile {
  id: string;
  review_id: string;
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  created_at: string;
}

// Review comment from analysis
export interface ReviewComment {
  id: string;
  review_id: string;
  file_path: string;
  line_number?: number;
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  message: string;
  suggestion?: string;
  created_at: string;
}

// Insert types (for creating new records)
export type InstallationInsert = Omit<Installation, 'created_at' | 'updated_at'>;
export type RepoConfigInsert = Omit<RepoConfig, 'id' | 'created_at' | 'updated_at'>;
export type ReviewInsert = Omit<Review, 'id' | 'created_at' | 'updated_at'>;

// Update types (for partial updates)
export type InstallationUpdate = Partial<Omit<Installation, 'id' | 'created_at'>>;
export type RepoConfigUpdate = Partial<Omit<RepoConfig, 'id' | 'created_at'>>;
export type ReviewUpdate = Partial<Omit<Review, 'id' | 'created_at'>>;
