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

  /**
   * Add a turn to an existing thread
   * Extends the TTL on each turn addition
   * @param threadId - Thread ID
   * @param role - Role of the turn (user, assistant, system)
   * @param content - Content of the turn
   * @returns true if successful, false if thread not found
   */
  async addTurn(
    threadId: string,
    role: 'user' | 'assistant' | 'system',
    content: string
  ): Promise<boolean> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      return false;
    }

    const newTurn: Turn = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };

    const newExpiry = this.calculateExpiry();

    const { error } = await this.supabase
      .from('conversation_threads')
      .update({
        turns: [...thread.turns, newTurn],
        expires_at: newExpiry,
      })
      .eq('thread_id', threadId);

    if (error) {
      throw new Error(`Failed to add turn: ${error.message}`);
    }

    return true;
  }

  /**
   * Add files to a thread with deduplication
   * @param threadId - Thread ID
   * @param files - Array of file paths to add
   * @returns true if successful, false if thread not found
   */
  async addFiles(threadId: string, files: string[]): Promise<boolean> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      return false;
    }

    // Deduplicate files
    const existingFiles = thread.files || [];
    const uniqueFiles = [...new Set([...existingFiles, ...files])];

    const { error } = await this.supabase
      .from('conversation_threads')
      .update({
        files: uniqueFiles,
        expires_at: this.calculateExpiry(),
      })
      .eq('thread_id', threadId);

    if (error) {
      throw new Error(`Failed to add files: ${error.message}`);
    }

    return true;
  }

  /**
   * Update thread metadata
   * @param threadId - Thread ID
   * @param metadata - Metadata to merge
   * @returns true if successful, false if thread not found
   */
  async updateMetadata(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      return false;
    }

    const mergedMetadata = {
      ...(thread.metadata || {}),
      ...metadata,
    };

    const { error } = await this.supabase
      .from('conversation_threads')
      .update({ metadata: mergedMetadata })
      .eq('thread_id', threadId);

    if (error) {
      throw new Error(`Failed to update metadata: ${error.message}`);
    }

    return true;
  }

  /**
   * List all active (non-expired) threads for a tool
   * @param toolName - Tool name to filter by
   * @param limit - Maximum number of threads to return
   * @returns Array of thread contexts
   */
  async listThreads(toolName?: string, limit: number = 100): Promise<ThreadContext[]> {
    let query = this.supabase
      .from('conversation_threads')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(limit);

    if (toolName) {
      query = query.eq('tool_name', toolName);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list threads: ${error.message}`);
    }

    return (data || []) as ThreadContext[];
  }

  /**
   * Clean up expired threads
   * @returns Number of threads deleted
   */
  async cleanupExpired(): Promise<number> {
    const { data, error } = await this.supabase
      .from('conversation_threads')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .select('thread_id');

    if (error) {
      throw new Error(`Failed to cleanup expired threads: ${error.message}`);
    }

    return data?.length || 0;
  }

  /**
   * Get thread statistics
   * @param threadId - Thread ID
   * @returns Statistics about the thread
   */
  async getThreadStats(
    threadId: string
  ): Promise<{ turnCount: number; fileCount: number; ageMinutes: number } | null> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      return null;
    }

    const createdAt = new Date(thread.created_at);
    const now = new Date();
    const ageMinutes = Math.floor((now.getTime() - createdAt.getTime()) / 60000);

    return {
      turnCount: thread.turns.length,
      fileCount: (thread.files || []).length,
      ageMinutes,
    };
  }

  /**
   * Reconstruct context from a thread for LLM consumption
   * @param threadId - Thread ID
   * @returns Reconstructed context with history string and metadata
   * @throws Error if thread not found
   */
  async reconstructContext(threadId: string): Promise<ReconstructedContext> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found or expired`);
    }

    const parts: string[] = ['=== CONVERSATION HISTORY ==='];

    for (const turn of thread.turns) {
      parts.push(`--- ${turn.role.toUpperCase()} [${turn.timestamp}] ---`);
      parts.push(turn.content);
      parts.push('');
    }

    parts.push('=== END HISTORY ===');

    return {
      history: parts.join('\n'),
      files: thread.files || [],
      initialContext: thread.initial_context,
      turnCount: thread.turns.length,
    };
  }

  /**
   * Extract unique files from thread turns
   * Parses content for file references and deduplicates
   * @param threadId - Thread ID
   * @returns Array of unique file paths
   * @throws Error if thread not found
   */
  async extractFiles(threadId: string): Promise<string[]> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found or expired`);
    }

    const fileSet = new Set<string>(thread.files || []);

    // Extract file references from turn content
    // Matches patterns like: `file.ts`, file.ts:123, "path/to/file.js"
    const filePatterns = [
      /`([^`]+\.[a-zA-Z]{1,10})`/g, // Backtick wrapped files
      /["']([^"']+\.[a-zA-Z]{1,10})["']/g, // Quoted files
      /(?:^|\s)(\S+\.[a-zA-Z]{2,10})(?::\d+)?(?:\s|$)/gm, // Plain file references
    ];

    for (const turn of thread.turns) {
      for (const pattern of filePatterns) {
        let match;
        while ((match = pattern.exec(turn.content)) !== null) {
          const file = match[1];
          // Filter out URLs and common false positives
          if (
            file &&
            !file.startsWith('http') &&
            !file.includes('://') &&
            !file.startsWith('npm:') &&
            !file.startsWith('node:')
          ) {
            fileSet.add(file);
          }
        }
        // Reset regex lastIndex for next iteration
        pattern.lastIndex = 0;
      }
    }

    return Array.from(fileSet).sort();
  }
}
