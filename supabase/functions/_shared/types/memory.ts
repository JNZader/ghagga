/**
 * Memory types for Engram-style persistent review memory
 *
 * Structured observations from code reviews, organized into sessions.
 */

// Observation type categories
export type ObservationType =
  | 'decision'
  | 'architecture'
  | 'bugfix'
  | 'pattern'
  | 'config'
  | 'discovery'
  | 'learning'
  | 'session_summary';

// Session lifecycle status
export type MemorySessionStatus = 'active' | 'closed' | 'archived';

// Memory session (1 PR review = 1 session)
export interface MemorySession {
  id: string;
  installation_id: number | null;
  repo_full_name: string;
  pr_number: number;
  session_name: string;
  status: MemorySessionStatus;
  summary: string | null;
  summary_embedding: number[] | null;
  metadata: Record<string, unknown>;
  started_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Structured observation from a review
export interface MemoryObservation {
  id: string;
  session_id: string;
  installation_id: number | null;
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
  embedding: number[] | null;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Result from hybrid memory search
export interface MemorySearchResult {
  id: string;
  combined_score: number;
  vector_score: number;
  text_score: number;
}

// Pre-review memory context
export interface MemoryContext {
  observations: MemoryObservation[];
  sessionCount: number;
  query: string;
}

// Parameters for adding an observation
export interface AddObservationParams {
  sessionId: string;
  installationId: number;
  repoFullName: string;
  observationType: ObservationType;
  title: string;
  content: string;
  whatHappened?: string;
  whyItMatters?: string;
  whereInCode?: string;
  whatWasLearned?: string;
  tags?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// Memory stats for a repository
export interface MemoryStats {
  totalSessions: number;
  totalObservations: number;
  typeBreakdown: Record<ObservationType, number>;
}

// Insert types
export type MemorySessionInsert = Omit<MemorySession, 'id' | 'created_at' | 'updated_at'>;
export type MemorySessionUpdate = Partial<Omit<MemorySession, 'id' | 'created_at'>>;
export type MemoryObservationInsert = Omit<MemoryObservation, 'id' | 'created_at' | 'updated_at'>;
export type MemoryObservationUpdate = Partial<Omit<MemoryObservation, 'id' | 'created_at'>>;
