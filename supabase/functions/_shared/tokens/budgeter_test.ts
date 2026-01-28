/**
 * Token Budgeter Tests
 *
 * Tests for model capabilities, token allocation, and budget fitting.
 */

import {
  assertEquals,
  assertGreater,
  assertLessOrEqual,
  assert,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';

import {
  TokenBudgeter,
  type TokenAllocation,
  type PrioritizedContent,
} from './budgeter.ts';

// ============================================================================
// Model Capabilities Tests
// ============================================================================

Deno.test('getCapabilities - returns known model capabilities', () => {
  const caps = TokenBudgeter.getCapabilities('claude-opus-4-5-20251101');
  assertEquals(caps.contextWindow, 200000);
  assertEquals(caps.maxOutput, 32000);
});

Deno.test('getCapabilities - returns gpt-4o capabilities', () => {
  const caps = TokenBudgeter.getCapabilities('gpt-4o');
  assertEquals(caps.contextWindow, 128000);
  assertEquals(caps.maxOutput, 16384);
});

Deno.test('getCapabilities - returns gemini capabilities', () => {
  const caps = TokenBudgeter.getCapabilities('gemini-2.0-flash');
  assertEquals(caps.contextWindow, 1000000);
  assertEquals(caps.maxOutput, 8192);
});

Deno.test('getCapabilities - returns default for unknown model', () => {
  const caps = TokenBudgeter.getCapabilities('unknown-model-xyz');
  assertEquals(caps.contextWindow, 100000);
  assertEquals(caps.maxOutput, 4096);
});

Deno.test('isKnownModel - returns true for known models', () => {
  assert(TokenBudgeter.isKnownModel('claude-opus-4-5-20251101'));
  assert(TokenBudgeter.isKnownModel('gpt-4o'));
  assert(TokenBudgeter.isKnownModel('gemini-2.0-flash'));
});

Deno.test('isKnownModel - returns false for unknown models', () => {
  assertEquals(TokenBudgeter.isKnownModel('unknown-model'), false);
  assertEquals(TokenBudgeter.isKnownModel(''), false);
});

Deno.test('getKnownModels - returns array of model IDs', () => {
  const models = TokenBudgeter.getKnownModels();
  assert(Array.isArray(models));
  assertGreater(models.length, 0);
  assert(models.includes('claude-opus-4-5-20251101'));
  assert(models.includes('gpt-4o'));
});

// ============================================================================
// Token Allocation Tests
// ============================================================================

Deno.test('allocate - small model allocation (< 50k)', () => {
  const allocation = TokenBudgeter.allocate('gpt-4');
  assertEquals(allocation.total, 8192);
  // Small model: 50% content ratio
  assertEquals(allocation.content, Math.floor(8192 * 0.5));
  assertEquals(allocation.response, Math.floor(8192 * 0.5));
});

Deno.test('allocate - medium model allocation (50k-300k)', () => {
  const allocation = TokenBudgeter.allocate('claude-opus-4-5-20251101');
  assertEquals(allocation.total, 200000);
  // Medium model: 60% content ratio
  assertEquals(allocation.content, Math.floor(200000 * 0.6));
  assertEquals(allocation.response, Math.floor(200000 * 0.4));
});

Deno.test('allocate - large model allocation (> 300k)', () => {
  const allocation = TokenBudgeter.allocate('gemini-2.0-flash');
  assertEquals(allocation.total, 1000000);
  // Large model: 80% content ratio
  assertEquals(allocation.content, Math.floor(1000000 * 0.8));
  assertEquals(allocation.response, Math.floor(1000000 * 0.2));
});

Deno.test('allocate - content subdivisions are correct', () => {
  const allocation = TokenBudgeter.allocate('claude-opus-4-5-20251101');
  const content = allocation.content;

  // Content subdivisions: 50% files, 30% history, 20% rules
  assertEquals(allocation.files, Math.floor(content * 0.5));
  assertEquals(allocation.history, Math.floor(content * 0.3));
  assertEquals(allocation.rules, Math.floor(content * 0.2));
});

Deno.test('allocate - subdivisions sum approximately to content', () => {
  const allocation = TokenBudgeter.allocate('gpt-4o');
  const subdivisionSum = allocation.files + allocation.history + allocation.rules;
  // Due to floor operations, sum should be close to but not exceed content
  assertLessOrEqual(subdivisionSum, allocation.content);
  // Should be within 3 tokens of content (due to rounding)
  assertGreater(subdivisionSum, allocation.content - 3);
});

// ============================================================================
// Token Estimation Tests
// ============================================================================

Deno.test('estimateTokens - estimates correctly', () => {
  // 4 characters ≈ 1 token
  assertEquals(TokenBudgeter.estimateTokens('test'), 1);
  assertEquals(TokenBudgeter.estimateTokens('testing'), 2);
  assertEquals(TokenBudgeter.estimateTokens('a'.repeat(100)), 25);
});

Deno.test('estimateTokens - handles empty string', () => {
  assertEquals(TokenBudgeter.estimateTokens(''), 0);
});

Deno.test('estimateTokens - rounds up partial tokens', () => {
  // 5 characters should round up to 2 tokens
  assertEquals(TokenBudgeter.estimateTokens('hello'), 2);
});

// ============================================================================
// Truncate to Fit Tests
// ============================================================================

Deno.test('truncateToFit - returns content if within budget', () => {
  const content = 'Short content';
  const result = TokenBudgeter.truncateToFit(content, 100);
  assertEquals(result, content);
});

Deno.test('truncateToFit - truncates content exceeding budget', () => {
  const content = 'a'.repeat(1000);
  const result = TokenBudgeter.truncateToFit(content, 50);
  // 50 tokens * 4 chars = 200 chars max
  assertLessOrEqual(result.length, 200);
  assert(result.endsWith('... [TRUNCATED] ...'));
});

Deno.test('truncateToFit - handles very small budget', () => {
  const content = 'a'.repeat(1000);
  const result = TokenBudgeter.truncateToFit(content, 5);
  assert(result.includes('[TRUNCATED]'));
});

Deno.test('truncateToFit - preserves truncation marker space', () => {
  const content = 'a'.repeat(500);
  const maxTokens = 50;
  const result = TokenBudgeter.truncateToFit(content, maxTokens);
  // Result should fit within budget
  assertLessOrEqual(result.length, maxTokens * 4);
});

// ============================================================================
// Fit to Budget Tests
// ============================================================================

Deno.test('fitToBudget - fits all items when within budget', () => {
  const items: PrioritizedContent[] = [
    { content: 'Item 1', priority: 1, type: 'files' },
    { content: 'Item 2', priority: 2, type: 'history' },
  ];

  const result = TokenBudgeter.fitToBudget(items, 1000);
  assertEquals(result.items.length, 2);
  assertEquals(result.truncatedCount, 0);
  assertEquals(result.droppedCount, 0);
});

Deno.test('fitToBudget - respects priority order', () => {
  const items: PrioritizedContent[] = [
    { content: 'Low priority', priority: 1, type: 'files' },
    { content: 'High priority', priority: 10, type: 'rules' },
    { content: 'Medium priority', priority: 5, type: 'history' },
  ];

  const result = TokenBudgeter.fitToBudget(items, 1000);
  // Items should be sorted by priority (highest first)
  assertEquals(result.items[0].content, 'High priority');
  assertEquals(result.items[1].content, 'Medium priority');
  assertEquals(result.items[2].content, 'Low priority');
});

Deno.test('fitToBudget - drops low priority items when over budget', () => {
  const items: PrioritizedContent[] = [
    { content: 'a'.repeat(400), priority: 1, type: 'files' }, // 100 tokens
    { content: 'b'.repeat(400), priority: 2, type: 'history' }, // 100 tokens
  ];

  // Only 120 tokens available - should keep high priority, drop low
  const result = TokenBudgeter.fitToBudget(items, 120);
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0].priority, 2); // Higher priority kept
  assertEquals(result.droppedCount, 1);
});

Deno.test('fitToBudget - truncates partial fit items', () => {
  const items: PrioritizedContent[] = [
    { content: 'a'.repeat(200), priority: 2, type: 'files' }, // 50 tokens
    { content: 'b'.repeat(400), priority: 1, type: 'history' }, // 100 tokens
  ];

  // 120 tokens: first item fits (50), second needs truncation (70 remaining)
  const result = TokenBudgeter.fitToBudget(items, 120);
  assertEquals(result.items.length, 2);
  assertEquals(result.truncatedCount, 1);
  assert(result.items[1].content.includes('[TRUNCATED]'));
});

Deno.test('fitToBudget - handles empty input', () => {
  const result = TokenBudgeter.fitToBudget([], 1000);
  assertEquals(result.items.length, 0);
  assertEquals(result.totalTokens, 0);
  assertEquals(result.truncatedCount, 0);
  assertEquals(result.droppedCount, 0);
});

Deno.test('fitToBudget - handles zero budget', () => {
  const items: PrioritizedContent[] = [
    { content: 'Test', priority: 1, type: 'files' },
  ];

  const result = TokenBudgeter.fitToBudget(items, 0);
  assertEquals(result.items.length, 0);
  assertEquals(result.droppedCount, 1);
});

// ============================================================================
// Fits in Budget Tests
// ============================================================================

Deno.test('fitsInBudget - returns true when within budget', () => {
  assert(TokenBudgeter.fitsInBudget('test', 10));
});

Deno.test('fitsInBudget - returns false when over budget', () => {
  assertEquals(TokenBudgeter.fitsInBudget('a'.repeat(100), 10), false);
});

Deno.test('fitsInBudget - returns true at exact budget', () => {
  // 40 chars = 10 tokens exactly
  assert(TokenBudgeter.fitsInBudget('a'.repeat(40), 10));
});

// ============================================================================
// Remaining Budget Tests
// ============================================================================

Deno.test('remainingBudget - calculates remaining tokens correctly', () => {
  const allocation: TokenAllocation = {
    total: 100000,
    content: 60000,
    response: 40000,
    files: 30000,
    history: 18000,
    rules: 12000,
  };

  const remaining = TokenBudgeter.remainingBudget(allocation, {
    files: 10000,
    history: 5000,
    rules: 2000,
  });

  assertEquals(remaining.files, 20000);
  assertEquals(remaining.history, 13000);
  assertEquals(remaining.rules, 10000);
  assertEquals(remaining.content, 60000 - 10000 - 5000 - 2000);
  // Response should remain unchanged
  assertEquals(remaining.response, 40000);
});

Deno.test('remainingBudget - handles partial usage', () => {
  const allocation: TokenAllocation = {
    total: 100000,
    content: 60000,
    response: 40000,
    files: 30000,
    history: 18000,
    rules: 12000,
  };

  const remaining = TokenBudgeter.remainingBudget(allocation, {
    files: 5000,
  });

  assertEquals(remaining.files, 25000);
  assertEquals(remaining.history, 18000); // Unchanged
  assertEquals(remaining.rules, 12000); // Unchanged
});

Deno.test('remainingBudget - handles empty usage', () => {
  const allocation: TokenAllocation = {
    total: 100000,
    content: 60000,
    response: 40000,
    files: 30000,
    history: 18000,
    rules: 12000,
  };

  const remaining = TokenBudgeter.remainingBudget(allocation, {});

  assertEquals(remaining.files, allocation.files);
  assertEquals(remaining.history, allocation.history);
  assertEquals(remaining.rules, allocation.rules);
  assertEquals(remaining.content, allocation.content);
});
