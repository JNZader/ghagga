/**
 * Smart Chunker for intelligent text chunking with overlap
 *
 * Provides chunking capabilities that respect line boundaries and maintain
 * context through overlap. Optimized for diff processing and deduplication.
 */

export interface ChunkConfig {
  /** Maximum tokens per chunk (default: 400) */
  maxTokens: number;
  /** Overlap tokens between chunks for context (default: 80) */
  overlapTokens: number;
  /** Estimated characters per token (default: 4) */
  charsPerToken: number;
}

export interface Chunk {
  /** The text content of this chunk */
  text: string;
  /** Starting line number (1-indexed) */
  startLine: number;
  /** Ending line number (1-indexed) */
  endLine: number;
  /** Hash for deduplication */
  hash: string;
  /** Estimated token count */
  tokenEstimate: number;
}

const DEFAULT_CONFIG: ChunkConfig = {
  maxTokens: 400,
  overlapTokens: 80,
  charsPerToken: 4,
};

export class SmartChunker {
  private config: ChunkConfig;

  constructor(config: Partial<ChunkConfig> = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? DEFAULT_CONFIG.maxTokens,
      overlapTokens: config.overlapTokens ?? DEFAULT_CONFIG.overlapTokens,
      charsPerToken: config.charsPerToken ?? DEFAULT_CONFIG.charsPerToken,
    };
  }

  /**
   * Chunk text content while respecting line boundaries
   *
   * @param content - The text content to chunk
   * @returns Array of chunks with metadata
   */
  chunk(content: string): Chunk[] {
    if (!content || content.trim().length === 0) {
      return [];
    }

    const maxChars = this.config.maxTokens * this.config.charsPerToken;
    const overlapChars = this.config.overlapTokens * this.config.charsPerToken;
    const lines = content.split('\n');
    const chunks: Chunk[] = [];

    let currentChunkLines: string[] = [];
    let currentChunkStart = 1;
    let currentChunkChars = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineChars = line.length + 1; // +1 for newline

      // Handle very long lines by splitting them
      if (lineChars > maxChars) {
        // First, flush any accumulated lines
        if (currentChunkLines.length > 0) {
          chunks.push(this.createChunk(currentChunkLines, currentChunkStart));
        }

        // Split the long line into multiple chunks
        const longLineChunks = this.splitLongLine(line, i + 1, maxChars);
        chunks.push(...longLineChunks);

        // Reset for next chunk - no overlap from long lines
        currentChunkLines = [];
        currentChunkStart = i + 2;
        currentChunkChars = 0;
        continue;
      }

      // Check if adding this line would exceed the limit
      if (currentChunkChars + lineChars > maxChars && currentChunkLines.length > 0) {
        // Create chunk from accumulated lines
        chunks.push(this.createChunk(currentChunkLines, currentChunkStart));

        // Calculate overlap lines
        const overlapLines = this.getOverlapLines(currentChunkLines, overlapChars);
        const overlapLineCount = overlapLines.length;

        // Start new chunk with overlap
        currentChunkStart = i + 1 - overlapLineCount;
        currentChunkLines = [...overlapLines];
        currentChunkChars = overlapLines.reduce((sum, l) => sum + l.length + 1, 0);
      }

      currentChunkLines.push(line);
      currentChunkChars += lineChars;
    }

    // Don't forget the last chunk
    if (currentChunkLines.length > 0) {
      chunks.push(this.createChunk(currentChunkLines, currentChunkStart));
    }

    return chunks;
  }

  /**
   * Chunk a diff, splitting by file first for better context
   *
   * @param diff - The diff content to chunk
   * @returns Array of chunks with metadata
   */
  chunkDiff(diff: string): Chunk[] {
    if (!diff || diff.trim().length === 0) {
      return [];
    }

    // Split by file diffs
    const filePattern = /^diff --git/gm;
    const parts = diff.split(filePattern);
    const allChunks: Chunk[] = [];

    // Track line offset for accurate line numbers
    let lineOffset = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.trim()) {
        lineOffset += part.split('\n').length - 1;
        continue;
      }

      // Reconstruct the file diff header if not the first empty part
      const fileDiff = i > 0 ? `diff --git${part}` : part;

      // Chunk this file's diff
      const fileChunks = this.chunk(fileDiff);

      // Adjust line numbers based on offset
      for (const chunk of fileChunks) {
        allChunks.push({
          ...chunk,
          startLine: chunk.startLine + lineOffset,
          endLine: chunk.endLine + lineOffset,
        });
      }

      lineOffset += fileDiff.split('\n').length;
    }

    return allChunks;
  }

  /**
   * Generate a hash for text content (for deduplication)
   *
   * @param text - The text to hash
   * @returns Hexadecimal hash string
   */
  hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Estimate token count for text
   *
   * @param text - The text to estimate
   * @returns Estimated token count
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.config.charsPerToken);
  }

  /**
   * Get the current configuration
   */
  getConfig(): ChunkConfig {
    return { ...this.config };
  }

  /**
   * Create a Chunk object from lines
   */
  private createChunk(lines: string[], startLine: number): Chunk {
    const text = lines.join('\n');
    return {
      text,
      startLine,
      endLine: startLine + lines.length - 1,
      hash: this.hashText(text),
      tokenEstimate: this.estimateTokens(text),
    };
  }

  /**
   * Get lines for overlap from the end of current chunk
   */
  private getOverlapLines(lines: string[], overlapChars: number): string[] {
    const overlapLines: string[] = [];
    let overlapSize = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
      const lineSize = lines[i].length + 1;
      if (overlapSize + lineSize > overlapChars && overlapLines.length > 0) {
        break;
      }
      overlapLines.unshift(lines[i]);
      overlapSize += lineSize;
    }

    return overlapLines;
  }

  /**
   * Split a very long line into multiple chunks
   */
  private splitLongLine(line: string, lineNumber: number, maxChars: number): Chunk[] {
    const chunks: Chunk[] = [];
    let position = 0;

    while (position < line.length) {
      // Try to find a good break point (space, punctuation)
      let endPosition = Math.min(position + maxChars, line.length);

      if (endPosition < line.length) {
        // Look for a good break point
        const searchStart = Math.max(position, endPosition - 50);
        const breakMatch = line.substring(searchStart, endPosition).match(/[\s.,;:!?)\]}>]+/g);
        if (breakMatch) {
          const lastBreak = line.substring(searchStart, endPosition).lastIndexOf(breakMatch[breakMatch.length - 1]);
          if (lastBreak > 0) {
            endPosition = searchStart + lastBreak + breakMatch[breakMatch.length - 1].length;
          }
        }
      }

      const chunkText = line.substring(position, endPosition);
      chunks.push({
        text: chunkText,
        startLine: lineNumber,
        endLine: lineNumber,
        hash: this.hashText(chunkText),
        tokenEstimate: this.estimateTokens(chunkText),
      });

      position = endPosition;
    }

    return chunks;
  }
}
