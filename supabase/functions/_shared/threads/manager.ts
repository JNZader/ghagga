/**
 * Thread Manager for conversation context management with TTL support
 *
 * Provides persistence, TTL management, and context reconstruction
 * for multi-turn conversations.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** Turn in a conversation */
export interface Turn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/** Thread context stored in database */
export interface ThreadContext {
  thread_id: string;
  tool_name: string;
  turns: Turn[];
  initial_context: Record<string, unknown>;
  files?: string[];
  created_at: string;
  expires_at: string;
  metadata?: Record<string, unknown>;
}

/** Options for creating a thread */
export interface CreateThreadOptions {
  toolName: string;
  initialContext: Record<string, unknown>;
  files?: string[];
  metadata?: Record<string, unknown>;
}

/** Result of context reconstruction */
export interface ReconstructedContext {
  history: string;
  files: string[];
  initialContext: Record<string, unknown>;
  turnCount: number;
}

/**
 * ThreadManager handles conversation thread persistence with TTL.
 *
 * Features:
 * - Create and manage conversation threads
 * - Automatic TTL expiration and cleanup
 * - Turn management with TTL extension
 * - Context reconstruction for LLM prompts
 * - File extraction with deduplication
 */
export class ThreadManager {
  private supabase: SupabaseClient;
  private ttlHours: number;

  /**
   * Create a ThreadManager instance
   * @param supabase - Supabase client instance
   * @param ttlHours - Time-to-live in hours for threads (default: 3)
   */
  constructor(supabase: SupabaseClient, ttlHours: number = 3) {
    this.supabase = supabase;
    this.ttlHours = ttlHours;
  }

  /**
   * Calculate expiration timestamp from now
   */
  private calculateExpiry(): string {
    const now = new Date();
    return new Date(now.getTime() + this.ttlHours * 60 * 60 * 1000).toISOString();
  }

  /**
   * Check if a thread has expired
   */
  private isExpired(expiresAt: string): boolean {
    return new Date(expiresAt) < new Date();
  }

  /**
   * Create a new conversation thread
   * @param options - Thread creation options
   * @returns The new thread ID
   */
  async createThread(options: CreateThreadOptions): Promise<string> {
    const { toolName, initialContext, files = [], metadata = {} } = options;

    const threadId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = this.calculateExpiry();

    const { error } = await this.supabase.from('conversation_threads').insert({
      thread_id: threadId,
      tool_name: toolName,
      turns: [],
      initial_context: initialContext,
      files,
      metadata,
      created_at: now,
      expires_at: expiresAt,
    });

    if (error) {
      throw new Error(`Failed to create thread: ${error.message}`);
    }

    return threadId;
  }

  /**
   * Get a thread by ID with TTL verification
   * Returns null if thread doesn't exist or has expired
   * @param threadId - Thread ID to retrieve
   * @returns Thread context or null
   */
  async getThread(threadId: string): Promise<ThreadContext | null> {
    const { data, error } = await this.supabase
      .from('conversation_threads')
      .select('*')
      .eq('thread_id', threadId)
      .single();

    if (error || !data) {
      return null;
    }

    // Check TTL - delete and return null if expired
    if (this.isExpired(data.expires_at)) {
      await this.deleteThread(threadId);
      return null;
    }

    return data as ThreadContext;
  }

  /**
   * Delete a thread
   * @param threadId - Thread ID to delete
   */
  async deleteThread(threadId: string): Promise<void> {
    const { error } = await this.supabase
      .from('conversation_threads')
      .delete()
      .eq('thread_id', threadId);

    if (error) {
      throw new Error(`Failed to delete thread: ${error.message}`);
    }
  }
}
