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
}
