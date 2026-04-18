/**
 * PageIndex Tests for GHAGGA
 * 
 * TDD: Tests for ProjectPageIndexService
 * Run: pnpm test test/pageindex.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs from 'fts5-sql-bundle';
import { ProjectPageIndexService, PageDirection } from '../src/memory/pageindex/index.js';

// CJS/ESM interop
const initSqlJsFn = typeof initSqlJs === 'function' 
  ? initSqlJs 
  : (initSqlJs as unknown as { initSqlJs: typeof initSqlJs }).initSqlJs;

describe('ProjectPageIndexService', () => {
  let db: any;
  let service: ProjectPageIndexService;

  beforeEach(async () => {
    const SQL = await initSqlJsFn();
    db = new SQL.Database();
    service = new ProjectPageIndexService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Schema Initialization', () => {
    it('should create project_page_index table', () => {
      const result = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_page_index'"
      );
      expect(result[0].values.length).toBe(1);
    });

    it('should create indexes', () => {
      const result = db.exec(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_project_pages%'"
      );
      expect(result[0].values.length).toBe(2);
    });
  });

  describe('createPageIndex', () => {
    it('should paginate large project memory', async () => {
      const content = `
        # Architecture
        System design and patterns.
        
        ## Authentication
        JWT implementation with refresh tokens.
        ${'auth '.repeat(500)}
        
        ## Database
        PostgreSQL schema design.
        ${'database '.repeat(500)}
        
        ## API
        REST endpoints and GraphQL.
        ${'api '.repeat(500)}
      `;

      const result = await service.createPageIndex('test-project', content);

      expect(result.pages).toBeGreaterThan(1);
      expect(result.tokens).toBeGreaterThan(0);
      // Total tokens should be roughly proportional to content size
      expect(result.tokens / result.pages).toBeGreaterThan(100); // Reasonable per page
    });

    it('should extract topics from content', async () => {
      const content = `
        ### Authentication Module
        JWT-based auth implementation.
        
        ### Database Schema  
        User and session tables.
      `;

      await service.createPageIndex('topic-project', content);
      const page = service.getPage('topic-project', 1);

      expect(page?.topics.length).toBeGreaterThan(0);
      expect(page?.topics.some(t => t.includes('Authentication'))).toBe(true);
    });

    it('should extract file references', async () => {
      const content = `
        Implementation in src/auth/middleware.ts
        and src/database/schema.ts.
        Also handles **/*.test.ts files.
      `;

      await service.createPageIndex('files-project', content);
      const page = service.getPage('files-project', 1);

      expect(page?.fileRefs.length).toBeGreaterThan(0);
      expect(page?.fileRefs.some(f => f.includes('src/auth/middleware.ts'))).toBe(true);
    });

    it('should link pages with prev/next', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Section ${i}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('linked-project', content);

      const page1 = service.getPage('linked-project', 1);
      const page2 = service.getPage('linked-project', 2);
      const page3 = service.getPage('linked-project', 3);

      expect(page1?.nextPageId).toBeDefined();
      expect(page2?.prevPageId).toBeDefined();
      expect(page2?.nextPageId).toBeDefined();
      expect(page3?.prevPageId).toBeDefined();
    });

    it('should return existing index if already created', async () => {
      const content = 'Test '.repeat(1000);

      const result1 = await service.createPageIndex('duplicate-project', content);
      const result2 = await service.createPageIndex('duplicate-project', content);

      expect(result1.pages).toBe(result2.pages);
      expect(result1.tokens).toBe(result2.tokens);
    });
  });

  describe('getPage', () => {
    it('should retrieve specific page', async () => {
      // Use large enough content to ensure we get multiple pages
      const content = Array(10).fill(0).map((_, i) => 
        `===Section${i + 1}===\n${'Text '.repeat(500)}`
      ).join('\n\n');

      await service.createPageIndex('get-page-project', content);
      const stats = service.getProjectStats('get-page-project');
      
      // Verify we have multiple pages
      expect(stats.pages).toBeGreaterThan(1);

      // Get middle page
      const middlePage = service.getPage('get-page-project', Math.floor(stats.pages / 2));

      expect(middlePage).toBeDefined();
      expect(middlePage?.pageNum).toBe(Math.floor(stats.pages / 2));
      expect(middlePage?.content.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent page', async () => {
      const page = service.getPage('non-existent', 1);
      expect(page).toBeNull();
    });

    it('should return null for non-existent project', () => {
      const page = service.getPage('unknown-project', 1);
      expect(page).toBeNull();
    });
  });

  describe('getContext', () => {
    it('should get context window with surrounding pages', async () => {
      const content = Array(7).fill(0).map((_, i) => 
        `Section ${i + 1}\n${'Content '.repeat(400)}`
      ).join('\n\n');

      await service.createPageIndex('context-project', content);

      const context = service.getContext({
        projectId: 'context-project',
        pageNum: 4,
        windowSize: 1
      });

      expect(context.totalInContext).toBe(3); // prev + current + next
      expect(context.currentPage.pageNum).toBe(4);
      expect(context.previousPages.length).toBe(1);
      expect(context.previousPages[0].pageNum).toBe(3);
      expect(context.nextPages.length).toBe(1);
      expect(context.nextPages[0].pageNum).toBe(5);
    });

    it('should handle boundaries (first page)', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Section ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('boundary-project', content);

      const context = service.getContext({
        projectId: 'boundary-project',
        pageNum: 1,
        windowSize: 1
      });

      expect(context.previousPages.length).toBe(0);
      expect(context.currentPage.pageNum).toBe(1);
      expect(context.nextPages.length).toBe(1);
    });

    it('should handle boundaries (last page)', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Section ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('last-page-project', content);
      const stats = service.getProjectStats('last-page-project');

      const context = service.getContext({
        projectId: 'last-page-project',
        pageNum: stats.pages,
        windowSize: 1
      });

      expect(context.previousPages.length).toBe(1);
      expect(context.currentPage.pageNum).toBe(stats.pages);
      expect(context.nextPages.length).toBe(0);
    });

    it('should calculate total tokens correctly', async () => {
      const content = Array(3).fill(0).map((_, i) => 
        `Section ${i + 1}\n${'Content '.repeat(300)}`
      ).join('\n\n');

      await service.createPageIndex('tokens-project', content);

      const context = service.getContext({
        projectId: 'tokens-project',
        pageNum: 2,
        windowSize: 1
      });

      expect(context.totalTokens).toBeGreaterThan(0);
      expect(context.totalInContext).toBe(3);
    });
  });

  describe('navigate', () => {
    it('should navigate to next page', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-project', content);

      const next = service.navigate({
        projectId: 'nav-project',
        currentPageNum: 2,
        direction: PageDirection.NEXT
      });

      expect(next?.pageNum).toBe(3);
    });

    it('should navigate to previous page', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-prev-project', content);

      const prev = service.navigate({
        projectId: 'nav-prev-project',
        currentPageNum: 3,
        direction: PageDirection.PREV
      });

      expect(prev?.pageNum).toBe(2);
    });

    it('should navigate to first page', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-first-project', content);

      const first = service.navigate({
        projectId: 'nav-first-project',
        currentPageNum: 4,
        direction: PageDirection.FIRST
      });

      expect(first?.pageNum).toBe(1);
    });

    it('should navigate to last page', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-last-project', content);
      const stats = service.getProjectStats('nav-last-project');

      const last = service.navigate({
        projectId: 'nav-last-project',
        currentPageNum: 2,
        direction: PageDirection.LAST
      });

      expect(last?.pageNum).toBe(stats.pages);
    });

    it('should return null when navigating prev from first', async () => {
      const content = Array(3).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-boundary-project', content);

      const prev = service.navigate({
        projectId: 'nav-boundary-project',
        currentPageNum: 1,
        direction: PageDirection.PREV
      });

      expect(prev).toBeNull();
    });

    it('should return null when navigating next from last', async () => {
      const content = Array(3).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('nav-last-boundary-project', content);
      const stats = service.getProjectStats('nav-last-boundary-project');

      const next = service.navigate({
        projectId: 'nav-last-boundary-project',
        currentPageNum: stats.pages,
        direction: PageDirection.NEXT
      });

      expect(next).toBeNull();
    });
  });

  describe('findRelevantPages', () => {
    it('should find pages matching PR title keywords', async () => {
      const content = `
        ### Authentication System
        JWT implementation details.
        ${'auth jwt token '.repeat(100)}
        
        ### Database Layer
        PostgreSQL connection pooling.
        ${'database postgres sql '.repeat(100)}
        
        ### API Routes
        REST endpoint definitions.
        ${'api rest endpoint '.repeat(100)}
      `;

      await service.createPageIndex('relevance-project', content);

      const relevant = service.findRelevantPages({
        projectId: 'relevance-project',
        prContext: {
          title: 'Add JWT authentication',
          description: 'Implement auth system',
          files: []
        },
        maxPages: 2
      });

      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant[0].topics.some(t => t.includes('Authentication'))).toBe(true);
    });

    it('should find pages matching file references', async () => {
      const content = `
        ### Middleware Implementation
        src/auth/middleware.ts handles JWT validation.
        ${'middleware auth '.repeat(100)}
        
        ### Database Schema
        src/database/schema.ts defines tables.
        ${'schema tables '.repeat(100)}
      `;

      await service.createPageIndex('files-relevance-project', content);

      const relevant = service.findRelevantPages({
        projectId: 'files-relevance-project',
        prContext: {
          title: 'Fix auth bug',
          description: 'Update middleware',
          files: ['src/auth/middleware.ts']
        },
        maxPages: 2
      });

      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant[0].fileRefs.some(f => f.includes('middleware.ts'))).toBe(true);
    });

    it('should respect maxPages limit', async () => {
      const content = Array(10).fill(0).map((_, i) => 
        `Topic ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('max-pages-project', content);

      const relevant = service.findRelevantPages({
        projectId: 'max-pages-project',
        prContext: {
          title: 'Topic 1 Topic 3 Topic 5',
          description: 'Multiple topics',
          files: []
        },
        maxPages: 2
      });

      expect(relevant.length).toBeLessThanOrEqual(2);
    });

    it('should return empty array for no matches', async () => {
      const content = `
        ### Authentication
        JWT and auth details.
      `;

      await service.createPageIndex('no-match-project', content);

      const relevant = service.findRelevantPages({
        projectId: 'no-match-project',
        prContext: {
          title: 'Database migration',
          description: 'PostgreSQL updates',
          files: ['src/database/migrate.ts']
        },
        maxPages: 3
      });

      expect(relevant.length).toBe(0);
    });
  });

  describe('checkCompaction', () => {
    it('should not recommend compaction for small projects', async () => {
      const content = 'Small project memory.';

      await service.createPageIndex('small-project', content);

      const check = service.checkCompaction('small-project', 4096);

      expect(check.shouldCompact).toBe(false);
      expect(check.safeToProceed).toBe(true);
    });

    it('should recommend compaction for large projects with small models', async () => {
      const content = 'Word '.repeat(10000); // ~40K chars = ~10K tokens

      await service.createPageIndex('large-project', content);

      const check = service.checkCompaction('large-project', 4096);

      expect(check.currentTokens).toBeGreaterThan(7000); // > 70% of 4K
      expect(check.shouldCompact).toBe(true);
      expect(check.suggestedAction).toBe('paginate');
    });

    it('should calculate correct threshold', async () => {
      const content = 'Word '.repeat(8000); // ~32K chars = ~8K tokens

      await service.createPageIndex('threshold-project', content);

      const check = service.checkCompaction('threshold-project', 4096);

      expect(check.maxTokens).toBe(4096);
      expect(check.currentTokens).toBeGreaterThan(0);
    });
  });

  describe('getProjectStats', () => {
    it('should return correct page count', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Section ${i + 1}\n${'Content '.repeat(300)}`
      ).join('\n\n');

      await service.createPageIndex('stats-count-project', content);
      const stats = service.getProjectStats('stats-count-project');

      expect(stats.pages).toBeGreaterThan(0);
    });

    it('should return correct token count', async () => {
      const content = 'Test '.repeat(2000);

      await service.createPageIndex('stats-tokens-project', content);
      const stats = service.getProjectStats('stats-tokens-project');

      expect(stats.tokens).toBeGreaterThan(0);
      // Each page should have some tokens (estimation is chars / 4)
      expect(stats.tokens / stats.pages).toBeGreaterThan(100); // At least 100 per page on average
    });

    it('should return zero for non-existent project', () => {
      const stats = service.getProjectStats('non-existent-project');

      expect(stats.pages).toBe(0);
      expect(stats.tokens).toBe(0);
    });
  });

  describe('deletePageIndex', () => {
    it('should delete all pages for project', async () => {
      const content = Array(5).fill(0).map((_, i) => 
        `Page ${i + 1}\n${'Content '.repeat(200)}`
      ).join('\n\n');

      await service.createPageIndex('delete-project', content);
      
      const beforeStats = service.getProjectStats('delete-project');
      expect(beforeStats.pages).toBeGreaterThan(0);

      service.deletePageIndex('delete-project');

      const afterStats = service.getProjectStats('delete-project');
      expect(afterStats.pages).toBe(0);
      expect(afterStats.tokens).toBe(0);
    });
  });

  describe('Integration: Review Workflow', () => {
    it('should support full review workflow with small model', async () => {
      // Setup: Large project memory
      const projectMemory = `
        # Project Architecture
        
        ## Authentication System
        JWT-based auth with refresh tokens.
        ${'auth jwt security '.repeat(400)}
        
        ## Database Schema  
        PostgreSQL with connection pooling.
        ${'database postgres schema '.repeat(400)}
        
        ## API Layer
        REST and GraphQL endpoints.
        ${'api rest graphql endpoint '.repeat(400)}
        
        ## Testing Strategy
        Unit, integration, and E2E tests.
        ${'test jest playwright '.repeat(400)}
        
        ## Deployment
        Docker and Kubernetes setup.
        ${'docker k8s deployment '.repeat(400)}
      `;

      await service.createPageIndex('integration-project', projectMemory);

      // Step 1: Check compaction for 4K model
      const compactionCheck = service.checkCompaction('integration-project', 4096);
      expect(compactionCheck.shouldCompact).toBe(true);

      // Step 2: Find relevant pages for auth-related PR
      const relevantPages = service.findRelevantPages({
        projectId: 'integration-project',
        prContext: {
          title: 'Fix JWT token expiration',
          description: 'Update auth middleware',
          files: ['src/auth/middleware.ts']
        },
        maxPages: 2
      });

      expect(relevantPages.length).toBeGreaterThan(0);
      // Check that relevant page has content or topics related to auth
      const hasAuthContent = relevantPages[0].content.toLowerCase().includes('auth') ||
                            relevantPages[0].topics.some(t => 
                              t.toLowerCase().includes('authentication') || 
                              t.toLowerCase().includes('auth')
                            );
      expect(hasAuthContent).toBe(true);

      // Step 3: Build context within token budget
      let context = '';
      let totalTokens = 0;
      const modelLimit = 4096;
      const safeLimit = modelLimit * 0.6; // 60% for input

      for (const page of relevantPages) {
        if (totalTokens + page.tokenCount > safeLimit) {
          break;
        }
        context += `\n\n--- Page ${page.pageNum} ---\n`;
        context += page.content;
        totalTokens += page.tokenCount;
      }

      expect(totalTokens).toBeLessThan(safeLimit);
      expect(context.length).toBeGreaterThan(0);

      // Step 4: Can navigate for more context if needed
      if (relevantPages.length > 0) {
        const lastPage = relevantPages[relevantPages.length - 1];
        const nextPage = service.navigate({
          projectId: 'integration-project',
          currentPageNum: lastPage.pageNum,
          direction: PageDirection.NEXT
        });
        
        if (nextPage) {
          expect(nextPage.pageNum).toBe(lastPage.pageNum + 1);
        }
      }
    });
  });
});
