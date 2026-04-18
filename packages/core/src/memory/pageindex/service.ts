/**
 * PageIndex Service for GHAGGA
 * 
 * Manages paginated project memory using GHAGGA's sql.js database.
 */

import type { Database } from 'fts5-sql-bundle';
import type { 
  ProjectPageChunk, 
  PageContextRequest, 
  PageContextResponse,
  PageNavigationRequest,
  CompactionCheck,
  RelevantPageRequest
} from './types.js';
import { PageDirection } from './types.js';

/**
 * Extended Database interface matching GHAGGA's sqlite.ts
 */
interface DatabaseWithParams extends Database {
  exec(
    sql: string,
    params?: (string | number | Buffer | null)[],
  ): Array<{ columns: string[]; values: unknown[][] }>;
}
import { chunkProjectMemory, shouldCompact, extractTopics } from './chunker.js';

export class ProjectPageIndexService {
  private db: DatabaseWithParams;

  constructor(db: Database) {
    this.db = db as DatabaseWithParams;
    this.initSchema();
  }

  private initSchema(): void {
    // Page index table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_page_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        page_num INTEGER NOT NULL,
        total_pages INTEGER NOT NULL,
        content TEXT NOT NULL,
        topics TEXT, -- JSON array
        file_refs TEXT, -- JSON array
        token_count INTEGER NOT NULL,
        prev_page_id INTEGER,
        next_page_id INTEGER,
        created_at INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        FOREIGN KEY (prev_page_id) REFERENCES project_page_index(id),
        FOREIGN KEY (next_page_id) REFERENCES project_page_index(id),
        UNIQUE(project_id, page_num)
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_pages_project ON project_page_index(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_pages_number ON project_page_index(project_id, page_num);
    `);
  }

  /**
   * Create page index for project memory
   */
  async createPageIndex(projectId: string, content: string): Promise<{ pages: number; tokens: number }> {
    // Check if already exists
    const existing = this.db.exec(
      `SELECT COUNT(*) as count FROM project_page_index WHERE project_id = ?`,
      [projectId]
    );
    
    if ((existing[0]?.values[0][0] as number) > 0) {
      // Return existing stats
      const stats = this.getProjectStats(projectId);
      return { pages: stats.pages, tokens: stats.tokens };
    }

    // Chunk content
    const chunks = chunkProjectMemory(projectId, content);
    
    // Insert pages
    const insertSql = `
      INSERT INTO project_page_index 
      (project_id, page_num, total_pages, content, topics, file_refs, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const pageIds: number[] = [];
    
    for (const chunk of chunks) {
      const result = this.db.exec(insertSql, [
        chunk.projectId,
        chunk.pageNum,
        chunk.totalPages,
        chunk.content,
        JSON.stringify(chunk.topics),
        JSON.stringify(chunk.fileRefs),
        chunk.tokenCount,
      ]);
      
      // Get last insert ID
      const lastId = this.db.exec('SELECT last_insert_rowid() as id');
      pageIds.push(lastId[0].values[0][0] as number);
    }

    // Link pages
    for (let i = 0; i < pageIds.length; i++) {
      const prevId = i > 0 ? pageIds[i - 1] : null;
      const nextId = i < pageIds.length - 1 ? pageIds[i + 1] : null;
      
      this.db.exec(
        `UPDATE project_page_index SET prev_page_id = ?, next_page_id = ? WHERE id = ?`,
        [prevId, nextId, pageIds[i]]
      );
    }

    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    return { pages: chunks.length, tokens: totalTokens };
  }

  /**
   * Get a specific page
   */
  getPage(projectId: string, pageNum: number): ProjectPageChunk | null {
    const result = this.db.exec(
      `SELECT * FROM project_page_index WHERE project_id = ? AND page_num = ?`,
      [projectId, pageNum]
    );

    if (!result[0] || result[0].values.length === 0) {
      return null;
    }

    return this.rowToPageChunk(result[0]);
  }

  /**
   * Get context window around a page
   */
  getContext(request: PageContextRequest): PageContextResponse {
    const { projectId, pageNum, windowSize } = request;
    
    const current = this.getPage(projectId, pageNum);
    if (!current) {
      throw new Error(`Page ${pageNum} not found in project ${projectId}`);
    }

    const startPage = Math.max(1, pageNum - windowSize);
    const endPage = pageNum + windowSize;

    const result = this.db.exec(
      `SELECT * FROM project_page_index 
       WHERE project_id = ? AND page_num BETWEEN ? AND ?
       ORDER BY page_num`,
      [projectId, startPage, endPage]
    );

    const pages = result[0] ? this.rowsToPageChunks(result[0]) : [];
    
    const previousPages = pages.filter(p => p.pageNum < pageNum);
    const nextPages = pages.filter(p => p.pageNum > pageNum);
    const totalTokens = pages.reduce((sum, p) => sum + p.tokenCount, 0);

    return {
      currentPage: current,
      previousPages,
      nextPages,
      totalInContext: pages.length,
      totalTokens,
    };
  }

  /**
   * Navigate to adjacent page
   */
  navigate(request: PageNavigationRequest): ProjectPageChunk | null {
    const { projectId, currentPageNum, direction } = request;

    switch (direction) {
      case PageDirection.NEXT:
        return this.getPage(projectId, currentPageNum + 1);
      case PageDirection.PREV:
        return this.getPage(projectId, currentPageNum - 1);
      case PageDirection.FIRST:
        return this.getPage(projectId, 1);
      case PageDirection.LAST:
        const stats = this.getProjectStats(projectId);
        return stats.pages > 0 ? this.getPage(projectId, stats.pages) : null;
      default:
        return null;
    }
  }

  /**
   * Find pages relevant to PR context
   */
  findRelevantPages(request: RelevantPageRequest): ProjectPageChunk[] {
    const { projectId, prContext, maxPages } = request;
    
    // Build keywords from PR context
    const keywords = [
      ...prContext.title.toLowerCase().split(/\s+/),
      ...prContext.description.toLowerCase().split(/\s+/),
      ...prContext.files.map(f => f.toLowerCase()),
    ].filter(k => k.length > 2);

    // Get all pages for project
    const result = this.db.exec(
      `SELECT * FROM project_page_index WHERE project_id = ? ORDER BY page_num`,
      [projectId]
    );

    if (!result[0]) return [];

    const pages = this.rowsToPageChunks(result[0]);
    
    // Score pages by keyword matches
    const scored = pages.map(page => {
      const content = (page.content + ' ' + page.topics.join(' ')).toLowerCase();
      const score = keywords.reduce((sum, kw) => {
        const matches = (content.match(new RegExp(kw, 'g')) || []).length;
        return sum + matches;
      }, 0);
      
      // Bonus for file ref matches
      const fileMatches = page.fileRefs.filter(ref => 
        prContext.files.some(f => f.includes(ref) || ref.includes(f))
      ).length;
      
      return { page, score: score + fileMatches * 3 };
    });

    // Sort by score and return top N
    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPages)
      .map(s => s.page);
  }

  /**
   * Check if compaction is needed
   */
  checkCompaction(projectId: string, modelMaxTokens: number): CompactionCheck {
    const stats = this.getProjectStats(projectId);
    const check = shouldCompact(stats.tokens, modelMaxTokens);
    check.projectId = projectId;
    return check;
  }

  /**
   * Get project stats
   */
  getProjectStats(projectId: string): { pages: number; tokens: number } {
    const result = this.db.exec(
      `SELECT 
        COUNT(*) as pages, 
        COALESCE(SUM(token_count), 0) as tokens 
       FROM project_page_index 
       WHERE project_id = ?`,
      [projectId]
    );

    if (!result[0] || result[0].values.length === 0) {
      return { pages: 0, tokens: 0 };
    }

    return {
      pages: result[0].values[0][0] as number,
      tokens: result[0].values[0][1] as number,
    };
  }

  /**
   * Delete project page index
   */
  deletePageIndex(projectId: string): void {
    this.db.exec(
      `DELETE FROM project_page_index WHERE project_id = ?`,
      [projectId]
    );
  }

  private rowToPageChunk(row: { columns: string[]; values: unknown[][] }): ProjectPageChunk {
    const values = row.values[0];
    const columns = row.columns;
    
    const get = (name: string) => values[columns.indexOf(name)];
    
    return {
      id: get('id') as number,
      projectId: get('project_id') as string,
      pageNum: get('page_num') as number,
      totalPages: get('total_pages') as number,
      content: get('content') as string,
      topics: JSON.parse((get('topics') as string) || '[]'),
      fileRefs: JSON.parse((get('file_refs') as string) || '[]'),
      tokenCount: get('token_count') as number,
      prevPageId: get('prev_page_id') as number | undefined,
      nextPageId: get('next_page_id') as number | undefined,
      createdAt: get('created_at') as number,
    };
  }

  private rowsToPageChunks(rows: { columns: string[]; values: unknown[][] }): ProjectPageChunk[] {
    return rows.values.map((_, idx) => {
      const singleRow = { columns: rows.columns, values: [rows.values[idx]] };
      return this.rowToPageChunk(singleRow);
    });
  }
}
