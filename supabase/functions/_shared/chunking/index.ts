/**
 * Chunking module for intelligent text processing
 *
 * This module provides smart chunking capabilities for text and diffs,
 * with support for overlap, line boundary respect, and deduplication.
 */

export {
  SmartChunker,
  type ChunkConfig,
  type Chunk,
} from './chunker.ts';
