/**
 * PageIndex Usage Example for GHAGGA
 *
 * Demonstrates how to use ProjectPageIndexService in review workflows.
 */

import { PageDirection, type ProjectPageIndexService } from './index.js';

// Example: Using PageIndex in a review workflow
export async function exampleReviewWorkflow(
  pageIndex: ProjectPageIndexService,
  projectId: string,
  pr: { title: string; description: string; files: string[] },
  modelMaxTokens: number = 4096, // Small model like llama-3.2-3b
) {
  // Step 1: Check if we need pagination
  const compactionCheck = pageIndex.checkCompaction(projectId, modelMaxTokens);

  if (compactionCheck.shouldCompact) {
    console.log(
      `⚠️ Project memory ${compactionCheck.currentTokens} tokens exceeds safe limit for ${modelMaxTokens} model`,
    );
    console.log(`💡 Using PageIndex to paginate into manageable chunks`);
  }

  // Step 2: Find relevant pages based on PR context
  console.log('🔍 Finding relevant pages for PR context...');
  const relevantPages = pageIndex.findRelevantPages({
    projectId,
    prContext: {
      title: pr.title,
      description: pr.description,
      files: pr.files,
    },
    maxPages: 3, // Only get top 3 most relevant pages
  });

  console.log(`📄 Found ${relevantPages.length} relevant pages`);

  // Step 3: Build context from relevant pages
  let context = '';
  let totalTokens = 0;

  for (const page of relevantPages) {
    // Check if adding this page would exceed limit
    if (totalTokens + page.tokenCount > modelMaxTokens * 0.6) {
      console.log(`⚠️ Stopping at ${totalTokens} tokens to leave room for response`);
      break;
    }

    context += `\n\n--- Page ${page.pageNum}/${page.totalPages} ---\n`;
    context += `Topics: ${page.topics.join(', ')}\n`;
    context += page.content;
    totalTokens += page.tokenCount;
  }

  console.log(`📊 Total context: ${totalTokens} tokens from ${relevantPages.length} pages`);
  console.log(`✅ Safe to proceed: ${totalTokens < modelMaxTokens * 0.7}`);

  // Step 4: If we need more context, navigate to adjacent pages
  if (relevantPages.length > 0) {
    const lastPage = relevantPages[relevantPages.length - 1];

    if (lastPage.pageNum < lastPage.totalPages) {
      const nextPage = pageIndex.navigate({
        projectId,
        currentPageNum: lastPage.pageNum,
        direction: PageDirection.NEXT,
      });

      if (nextPage) {
        console.log(`➡️ Can navigate to page ${nextPage.pageNum} if needed`);
      }
    }
  }

  return {
    context,
    tokens: totalTokens,
    pagesUsed: relevantPages.length,
    safe: totalTokens < modelMaxTokens * 0.7,
  };
}

// Example: Creating page index for large project
export async function exampleCreatePageIndex(
  pageIndex: ProjectPageIndexService,
  projectId: string,
  projectMemory: string,
) {
  console.log('📚 Creating PageIndex for large project memory...');

  const result = await pageIndex.createPageIndex(projectId, projectMemory);

  console.log(`✅ Created ${result.pages} pages (${result.tokens} tokens total)`);
  console.log(`📄 Average ${Math.round(result.tokens / result.pages)} tokens per page`);

  return result;
}

// Example: Reading with context window
export function exampleContextWindow(
  pageIndex: ProjectPageIndexService,
  projectId: string,
  targetPage: number,
) {
  console.log(`📖 Reading page ${targetPage} with context window...`);

  const context = pageIndex.getContext({
    projectId,
    pageNum: targetPage,
    windowSize: 1, // Get previous, current, and next page
  });

  console.log(
    `📄 Context window: ${context.previousPages.length} before, ${context.nextPages.length} after`,
  );
  console.log(
    `📊 Total in window: ${context.totalInContext} pages (${context.totalTokens} tokens)`,
  );

  // Build full context text
  let fullContext = '';

  for (const page of context.previousPages) {
    fullContext += `\n[Prev Page ${page.pageNum}]\n${page.content.substring(0, 200)}...\n`;
  }

  fullContext += `\n[CURRENT PAGE ${context.currentPage.pageNum}]\n${context.currentPage.content}\n`;

  for (const page of context.nextPages) {
    fullContext += `\n[Next Page ${page.pageNum}]\n${page.content.substring(0, 200)}...\n`;
  }

  return fullContext;
}
