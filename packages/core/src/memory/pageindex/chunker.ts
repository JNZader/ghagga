/**
 * PageIndex Chunker for GHAGGA
 * 
 * Chunks project memory by topics and extracts file references.
 */

import type { ProjectPageChunk, CompactionCheck } from './types.js';

export const GHAGGA_CHUNK_CONFIG = {
  maxTokensPerPage: 1500,
  overlapTokens: 200,
  maxTopicLength: 50,
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract topics from content (headers, emphasized text, file refs)
 */
export function extractTopics(content: string): string[] {
  const topics: string[] = [];
  
  // Headers (### Topic)
  const headers = content.match(/^#{1,3}\s+(.+)$/gm);
  if (headers) {
    headers.slice(0, 5).forEach(h => {
      topics.push(h.replace(/^#+\s+/, '').slice(0, 50));
    });
  }
  
  // Bold text (**topic**)
  const bold = content.match(/\*\*(.+?)\*\*/g);
  if (bold && topics.length < 10) {
    bold.slice(0, 3).forEach(b => {
      const topic = b.replace(/\*\*/g, '').slice(0, 50);
      if (!topics.includes(topic)) topics.push(topic);
    });
  }
  
  return topics.slice(0, 8);
}

/**
 * Extract file references from content
 */
export function extractFileRefs(content: string): string[] {
  const refs: string[] = [];
  
  // File paths (src/... or **/*.ts)
  const paths = content.match(/(?:src\/|apps\/|packages\/)[\w\/\-]+\.\w+/g);
  if (paths) {
    paths.slice(0, 10).forEach(p => {
      if (!refs.includes(p)) refs.push(p);
    });
  }
  
  // Glob patterns
  const globs = content.match(/\*\*\/\*\.\w+/g);
  if (globs) {
    globs.slice(0, 5).forEach(g => {
      if (!refs.includes(g)) refs.push(g);
    });
  }
  
  return refs.slice(0, 15);
}

/**
 * Chunk project memory into pages
 */
export function chunkProjectMemory(
  projectId: string,
  content: string,
  config = GHAGGA_CHUNK_CONFIG
): Omit<ProjectPageChunk, 'id' | 'createdAt'>[] {
  const maxChars = config.maxTokensPerPage * 4;
  const overlapChars = config.overlapTokens * 4;
  
  const chunks: string[] = [];
  let pos = 0;
  
  while (pos < content.length) {
    let end = Math.min(pos + maxChars, content.length);
    
    if (end < content.length) {
      // Try to break at section boundary
      const sectionBreak = content.lastIndexOf('\n\n## ', end);
      if (sectionBreak > pos + maxChars * 0.5) {
        end = sectionBreak + 1;
      } else {
        // Try paragraph
        const para = content.lastIndexOf('\n\n', end);
        if (para > pos + maxChars * 0.7) end = para + 2;
      }
    }
    
    chunks.push(content.slice(pos, end).trim());
    pos = Math.max(pos + 1, end - overlapChars);
  }
  
  // Create page chunks with metadata
  return chunks.map((chunk, idx) => ({
    projectId,
    pageNum: idx + 1,
    totalPages: chunks.length,
    content: chunk,
    topics: extractTopics(chunk),
    fileRefs: extractFileRefs(chunk),
    tokenCount: estimateTokens(chunk),
  }));
}

/**
 * Check if compaction is needed
 */
export function shouldCompact(
  currentTokens: number,
  modelMaxTokens: number,
  safetyMargin = 0.3
): CompactionCheck {
  const threshold = modelMaxTokens * (1 - safetyMargin);
  
  const shouldCompact = currentTokens > threshold;
  
  return {
    currentTokens,
    maxTokens: modelMaxTokens,
    projectId: '',
    shouldCompact,
    safeToProceed: !shouldCompact,
    suggestedAction: shouldCompact ? 'paginate' : 'none',
  };
}
