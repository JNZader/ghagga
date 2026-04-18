/**
 * PageIndex for GHAGGA Project Memory
 *
 * Enables navigable access to large project memories for small context models.
 * Adapts MCP-LLM-Bridge PageIndex pattern for GHAGGA's sql.js architecture.
 */

export interface ProjectPageChunk {
  id?: number;
  projectId: string;
  pageNum: number;
  totalPages: number;
  content: string;
  topics: string[]; // Extracted topics for relevance matching
  fileRefs: string[]; // Referenced files in this page
  tokenCount: number;
  prevPageId?: number;
  nextPageId?: number;
  createdAt: number;
}

export interface ProjectPageIndex {
  projectId: string;
  totalPages: number;
  totalTokens: number;
  createdAt: number;
  lastAccessed: number;
}

export interface PageContextRequest {
  projectId: string;
  pageNum: number;
  windowSize: number;
}

export interface PageContextResponse {
  currentPage: ProjectPageChunk;
  previousPages: ProjectPageChunk[];
  nextPages: ProjectPageChunk[];
  totalInContext: number;
  totalTokens: number;
}

export enum PageDirection {
  NEXT = 'next',
  PREV = 'prev',
  FIRST = 'first',
  LAST = 'last',
}

export interface PageNavigationRequest {
  projectId: string;
  currentPageNum: number;
  direction: PageDirection;
}

export interface CompactionCheck {
  currentTokens: number;
  maxTokens: number;
  projectId: string;
  shouldCompact: boolean;
  safeToProceed: boolean;
  suggestedAction: 'compact' | 'paginate' | 'none';
}

export interface RelevantPageRequest {
  projectId: string;
  prContext: {
    title: string;
    description: string;
    files: string[];
  };
  maxPages: number;
}
