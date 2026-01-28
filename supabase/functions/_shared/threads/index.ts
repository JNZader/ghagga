/**
 * Thread management module
 *
 * Exports the ThreadManager class and related types for conversation
 * context management with TTL support.
 */

export {
  ThreadManager,
  type Turn,
  type ThreadContext,
  type CreateThreadOptions,
  type ReconstructedContext,
} from './manager.ts';
