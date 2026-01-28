/**
 * Thread types for conversation and review context management
 */

// Thread status
export type ThreadStatus = 'active' | 'resolved' | 'archived' | 'stale';

// Thread represents a conversation context
export interface Thread {
  id: string;
  repo_full_name: string;
  pr_number?: number;
  issue_number?: number;
  title?: string;
  status: ThreadStatus;
  metadata?: ThreadMetadata;
  created_at: string;
  updated_at: string;
}

// Thread metadata for additional context
export interface ThreadMetadata {
  source?: 'pr_review' | 'issue' | 'discussion' | 'manual';
  labels?: string[];
  assignees?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

// Message in a thread
export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  author?: string;
  embedding?: number[];
  tokens?: number;
  created_at: string;
}

// Thread summary for context window optimization
export interface ThreadSummary {
  id: string;
  thread_id: string;
  summary: string;
  message_count: number;
  token_count: number;
  embedding?: number[];
  from_message_id: string;
  to_message_id: string;
  created_at: string;
}

// Thread context for LLM requests
export interface ThreadContext {
  thread_id: string;
  messages: ThreadMessage[];
  summaries?: ThreadSummary[];
  total_tokens: number;
  truncated: boolean;
}

// Thread search query
export interface ThreadSearchQuery {
  repo_full_name?: string;
  pr_number?: number;
  status?: ThreadStatus;
  query?: string;
  limit?: number;
  offset?: number;
  order_by?: 'created_at' | 'updated_at';
  order_dir?: 'asc' | 'desc';
}

// Thread search result
export interface ThreadSearchResult {
  threads: Thread[];
  total: number;
  has_more: boolean;
}

// Insert and update types
export type ThreadInsert = Omit<Thread, 'id' | 'created_at' | 'updated_at'>;
export type ThreadUpdate = Partial<Omit<Thread, 'id' | 'created_at'>>;
export type ThreadMessageInsert = Omit<ThreadMessage, 'id' | 'created_at'>;
