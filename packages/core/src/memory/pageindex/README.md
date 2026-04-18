# PageIndex for GHAGGA

**Paginated Project Memory for Small Context Models**

## Overview

PageIndex enables GHAGGA to work efficiently with small context models (4K-8K tokens) by dividing large project memories into navigable pages. This prevents compaction loops and enables granular access to project context.

## Features

- ✅ **Token-aware pagination**: ~1.5K tokens per page
- ✅ **Topic extraction**: Automatic topic and file reference detection
- ✅ **Relevance matching**: Find pages matching PR context
- ✅ **Context windows**: Get page with surrounding context
- ✅ **Navigation**: Prev/next/first/last page traversal
- ✅ **Compaction prevention**: Check before context overflow

## Usage

### Basic Usage

```typescript
import { SqliteMemoryStorage } from '@ghagga/core';

// Create or load memory storage
const storage = await SqliteMemoryStorage.create('./memory.db');

// Get PageIndex service
const pageIndex = storage.getPageIndex();

// Create page index for large project memory
const result = await pageIndex.createPageIndex(
  'my-project',
  largeProjectMemoryContent
);

console.log(`Created ${result.pages} pages (${result.tokens} tokens)`);
```

### Finding Relevant Pages for PR Review

```typescript
// Find pages relevant to PR context
const relevantPages = pageIndex.findRelevantPages({
  projectId: 'my-project',
  prContext: {
    title: 'Add authentication middleware',
    description: 'Implements JWT-based auth with refresh tokens',
    files: ['src/auth/middleware.ts', 'src/auth/jwt.ts']
  },
  maxPages: 3
});

// Build context from relevant pages
let context = '';
let totalTokens = 0;
const modelLimit = 4096; // Small model

for (const page of relevantPages) {
  // Stop if we'd exceed safe limit (70% of context)
  if (totalTokens + page.tokenCount > modelLimit * 0.7) {
    break;
  }
  
  context += `\n\n--- Page ${page.pageNum} ---\n`;
  context += `Topics: ${page.topics.join(', ')}\n`;
  context += page.content;
  totalTokens += page.tokenCount;
}

console.log(`Built context: ${totalTokens} tokens from ${relevantPages.length} pages`);
```

### Reading with Context Window

```typescript
// Get page 5 with 1 page before and after
const contextWindow = pageIndex.getContext({
  projectId: 'my-project',
  pageNum: 5,
  windowSize: 1
});

console.log(`Context window has ${contextWindow.totalInContext} pages`);
console.log(`Previous: ${contextWindow.previousPages.map(p => p.pageNum).join(', ')}`);
console.log(`Current: ${contextWindow.currentPage.pageNum}`);
console.log(`Next: ${contextWindow.nextPages.map(p => p.pageNum).join(', ')}`);
```

### Navigation

```typescript
import { PageDirection } from '@ghagga/core';

// Navigate to next page
const nextPage = pageIndex.navigate({
  projectId: 'my-project',
  currentPageNum: 3,
  direction: PageDirection.NEXT
});

// Navigate to first/last
const firstPage = pageIndex.navigate({
  projectId: 'my-project',
  currentPageNum: 1,
  direction: PageDirection.FIRST
});
```

### Compaction Prevention

```typescript
// Check if we need pagination for a model
const check = pageIndex.checkCompaction('my-project', 4096);

if (check.shouldCompact) {
  console.warn(`⚠️ Project memory ${check.currentTokens} tokens exceeds safe limit`);
  console.log(`💡 Suggested action: ${check.suggestedAction}`);
}
```

## Integration in Review Pipeline

```typescript
async function reviewWithSmallModel(
  storage: SqliteMemoryStorage,
  projectId: string,
  pr: { title: string; description: string; files: string[] },
  modelMaxTokens: number = 4096
) {
  const pageIndex = storage.getPageIndex();
  
  // 1. Check if we have a page index
  const stats = pageIndex.getProjectStats(projectId);
  
  if (stats.pages === 0) {
    // Build page index from project memory
    const memory = await storage.getProjectMemory(projectId);
    await pageIndex.createPageIndex(projectId, memory);
  }
  
  // 2. Check compaction
  const check = pageIndex.checkCompaction(projectId, modelMaxTokens);
  if (!check.safeToProceed) {
    console.log('Using paginated access for large project memory');
  }
  
  // 3. Get relevant pages for this PR
  const relevant = pageIndex.findRelevantPages({
    projectId,
    prContext: pr,
    maxPages: 3
  });
  
  // 4. Build context within token budget
  const context = buildContextFromPages(relevant, modelMaxTokens * 0.6);
  
  // 5. Run review
  return await runReview(context, pr);
}
```

## Architecture

```
┌─────────────────────┐
│  SqliteMemoryStorage │
│  ├─ getPageIndex()  │──▶ ProjectPageIndexService
└─────────────────────┘      ├─ createPageIndex()
                             ├─ getPage()
                             ├─ getContext()
                             ├─ navigate()
                             ├─ findRelevantPages()
                             └─ checkCompaction()
```

## Database Schema

```sql
CREATE TABLE project_page_index (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  content TEXT NOT NULL,
  topics TEXT, -- JSON array
  file_refs TEXT, -- JSON array
  token_count INTEGER,
  prev_page_id INTEGER,
  next_page_id INTEGER,
  created_at INTEGER,
  UNIQUE(project_id, page_num)
);
```

## Benefits

1. **Small Model Support**: Works with 4K-8K context models (llama-3.2, qwen, phi-4)
2. **No Compaction Loops**: Deterministic token usage prevents infinite loops
3. **Relevant Context**: Find pages matching PR topics and files
4. **Incremental Reading**: Navigate through memory page by page
5. **Zero Dependencies**: Uses existing sql.js database

## Comparison

| Without PageIndex | With PageIndex |
|-------------------|----------------|
| Truncate large memories | Paginate into chunks |
| Compaction loops | Deterministic tokens |
| All-or-nothing access | Granular page access |
| Small models struggle | Small models thrive |

## Status

✅ **Phase 2 Complete**: GHAGGA integration ready for testing

Next: Phase 3 (RepoForge) and Phase 4 (md-evals)
