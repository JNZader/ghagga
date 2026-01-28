/**
 * Unit tests for ThreadManager
 *
 * Run with: deno test --allow-net supabase/functions/_shared/threads/manager_test.ts
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ThreadManager, type ThreadContext } from './manager.ts';

// Mock Supabase client builder
function createMockSupabase(mockData: {
  selectData?: ThreadContext | null;
  selectError?: Error | null;
  insertError?: Error | null;
  updateError?: Error | null;
  deleteError?: Error | null;
  deleteData?: { thread_id: string }[];
}) {
  const mockFrom = {
    insert: (_data: unknown) => ({
      error: mockData.insertError || null,
    }),
    select: (_cols: string) => ({
      eq: (_col: string, _val: string) => ({
        single: () => ({
          data: mockData.selectData,
          error: mockData.selectError || null,
        }),
      }),
      gt: (_col: string, _val: string) => ({
        order: (_orderCol: string, _opts: unknown) => ({
          limit: (_n: number) => ({
            data: mockData.selectData ? [mockData.selectData] : [],
            error: null,
          }),
        }),
      }),
    }),
    update: (_data: unknown) => ({
      eq: (_col: string, _val: string) => ({
        error: mockData.updateError || null,
      }),
    }),
    delete: () => ({
      eq: (_col: string, _val: string) => ({
        error: mockData.deleteError || null,
        select: (_cols: string) => ({
          data: mockData.deleteData || [],
          error: null,
        }),
      }),
      lt: (_col: string, _val: string) => ({
        select: (_cols: string) => ({
          data: mockData.deleteData || [],
          error: null,
        }),
      }),
    }),
  };

  return {
    from: (_table: string) => mockFrom,
  };
}

// Sample thread data for tests
function createSampleThread(overrides: Partial<ThreadContext> = {}): ThreadContext {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000); // 3 hours from now

  return {
    thread_id: 'test-thread-123',
    tool_name: 'code-review',
    turns: [],
    initial_context: { repo: 'test/repo', pr: 42 },
    files: [],
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    metadata: {},
    ...overrides,
  };
}

Deno.test('ThreadManager - constructor sets default TTL', () => {
  const mockSupabase = createMockSupabase({});
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  // We can't directly check private ttlHours, but we verify constructor works
  assertExists(manager);
});

Deno.test('ThreadManager - constructor accepts custom TTL', () => {
  const mockSupabase = createMockSupabase({});
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase, 6);

  assertExists(manager);
});

Deno.test('ThreadManager - createThread returns UUID', async () => {
  const mockSupabase = createMockSupabase({});
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const threadId = await manager.createThread({
    toolName: 'code-review',
    initialContext: { repo: 'test/repo' },
  });

  assertExists(threadId);
  // UUID format check
  assertEquals(threadId.split('-').length, 5);
});

Deno.test('ThreadManager - createThread throws on error', async () => {
  const mockSupabase = createMockSupabase({
    insertError: new Error('Insert failed'),
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  await assertRejects(
    () =>
      manager.createThread({
        toolName: 'code-review',
        initialContext: {},
      }),
    Error,
    'Failed to create thread'
  );
});

Deno.test('ThreadManager - getThread returns thread data', async () => {
  const sampleThread = createSampleThread();
  const mockSupabase = createMockSupabase({
    selectData: sampleThread,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const thread = await manager.getThread('test-thread-123');

  assertExists(thread);
  assertEquals(thread?.thread_id, 'test-thread-123');
  assertEquals(thread?.tool_name, 'code-review');
});

Deno.test('ThreadManager - getThread returns null for non-existent thread', async () => {
  const mockSupabase = createMockSupabase({
    selectData: null,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const thread = await manager.getThread('non-existent');

  assertEquals(thread, null);
});

Deno.test('ThreadManager - getThread returns null and deletes expired thread', async () => {
  const expiredThread = createSampleThread({
    expires_at: new Date(Date.now() - 1000).toISOString(), // Expired
  });

  let deleteCalled = false;
  const mockFrom = {
    select: () => ({
      eq: () => ({
        single: () => ({
          data: expiredThread,
          error: null,
        }),
      }),
    }),
    delete: () => {
      deleteCalled = true;
      return {
        eq: () => ({ error: null }),
      };
    },
  };

  const mockSupabase = {
    from: () => mockFrom,
  };

  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const thread = await manager.getThread('test-thread-123');

  assertEquals(thread, null);
  assertEquals(deleteCalled, true);
});

Deno.test('ThreadManager - addTurn appends turn and extends TTL', async () => {
  const sampleThread = createSampleThread({
    turns: [{ role: 'user', content: 'Hello', timestamp: new Date().toISOString() }],
  });

  let updateData: unknown = null;
  const mockFrom = {
    select: () => ({
      eq: () => ({
        single: () => ({
          data: sampleThread,
          error: null,
        }),
      }),
    }),
    update: (data: unknown) => {
      updateData = data;
      return {
        eq: () => ({ error: null }),
      };
    },
    delete: () => ({
      eq: () => ({ error: null }),
    }),
  };

  const mockSupabase = {
    from: () => mockFrom,
  };

  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const result = await manager.addTurn('test-thread-123', 'assistant', 'Hi there!');

  assertEquals(result, true);
  assertExists(updateData);
  // @ts-ignore - checking mock data
  assertEquals(updateData.turns.length, 2);
  // @ts-ignore - checking mock data
  assertEquals(updateData.turns[1].role, 'assistant');
  // @ts-ignore - checking mock data
  assertEquals(updateData.turns[1].content, 'Hi there!');
});

Deno.test('ThreadManager - addTurn returns false for non-existent thread', async () => {
  const mockSupabase = createMockSupabase({
    selectData: null,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const result = await manager.addTurn('non-existent', 'user', 'Hello');

  assertEquals(result, false);
});

Deno.test('ThreadManager - reconstructContext builds history string', async () => {
  const sampleThread = createSampleThread({
    turns: [
      { role: 'user', content: 'What is this file?', timestamp: '2024-01-01T10:00:00Z' },
      { role: 'assistant', content: 'This is a config file.', timestamp: '2024-01-01T10:01:00Z' },
    ],
    files: ['config.ts', 'utils.ts'],
    initial_context: { repo: 'test/repo', pr: 42 },
  });
  const mockSupabase = createMockSupabase({
    selectData: sampleThread,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const context = await manager.reconstructContext('test-thread-123');

  assertExists(context);
  assertEquals(context.turnCount, 2);
  assertEquals(context.files, ['config.ts', 'utils.ts']);
  assertEquals(context.initialContext.repo, 'test/repo');
  assertEquals(context.history.includes('USER'), true);
  assertEquals(context.history.includes('ASSISTANT'), true);
  assertEquals(context.history.includes('What is this file?'), true);
  assertEquals(context.history.includes('This is a config file.'), true);
});

Deno.test('ThreadManager - reconstructContext throws for non-existent thread', async () => {
  const mockSupabase = createMockSupabase({
    selectData: null,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  await assertRejects(
    () => manager.reconstructContext('non-existent'),
    Error,
    'not found or expired'
  );
});

Deno.test('ThreadManager - extractFiles deduplicates files from content', async () => {
  const sampleThread = createSampleThread({
    turns: [
      {
        role: 'user',
        content: 'Check `config.ts` and `utils.ts` please',
        timestamp: '2024-01-01T10:00:00Z',
      },
      {
        role: 'assistant',
        content: 'I see issues in config.ts and also in "helper.js"',
        timestamp: '2024-01-01T10:01:00Z',
      },
      {
        role: 'user',
        content: 'What about `config.ts` again?',
        timestamp: '2024-01-01T10:02:00Z',
      },
    ],
    files: ['existing.ts'],
  });
  const mockSupabase = createMockSupabase({
    selectData: sampleThread,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const files = await manager.extractFiles('test-thread-123');

  // Should include deduplicated files, sorted
  assertEquals(files.includes('config.ts'), true);
  assertEquals(files.includes('utils.ts'), true);
  assertEquals(files.includes('helper.js'), true);
  assertEquals(files.includes('existing.ts'), true);

  // Should be deduplicated - config.ts mentioned twice but should appear once
  const configCount = files.filter((f) => f === 'config.ts').length;
  assertEquals(configCount, 1);
});

Deno.test('ThreadManager - extractFiles excludes URLs and npm imports', async () => {
  const sampleThread = createSampleThread({
    turns: [
      {
        role: 'user',
        content: 'Check https://example.com/file.ts and npm:package@1.0.0 and node:fs',
        timestamp: '2024-01-01T10:00:00Z',
      },
    ],
    files: [],
  });
  const mockSupabase = createMockSupabase({
    selectData: sampleThread,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const files = await manager.extractFiles('test-thread-123');

  // Should not include URLs or npm/node imports
  assertEquals(files.includes('https://example.com/file.ts'), false);
  assertEquals(files.filter((f) => f.includes('npm:')).length, 0);
  assertEquals(files.filter((f) => f.includes('node:')).length, 0);
});

Deno.test('ThreadManager - addFiles deduplicates and updates', async () => {
  const sampleThread = createSampleThread({
    files: ['existing.ts', 'config.ts'],
  });

  let updateData: unknown = null;
  const mockFrom = {
    select: () => ({
      eq: () => ({
        single: () => ({
          data: sampleThread,
          error: null,
        }),
      }),
    }),
    update: (data: unknown) => {
      updateData = data;
      return {
        eq: () => ({ error: null }),
      };
    },
    delete: () => ({
      eq: () => ({ error: null }),
    }),
  };

  const mockSupabase = {
    from: () => mockFrom,
  };

  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const result = await manager.addFiles('test-thread-123', ['config.ts', 'new.ts', 'another.ts']);

  assertEquals(result, true);
  assertExists(updateData);
  // @ts-ignore - checking mock data
  const uniqueFiles = new Set(updateData.files);
  assertEquals(uniqueFiles.size, 4); // existing, config, new, another (config deduplicated)
  // @ts-ignore - checking mock data
  assertEquals(updateData.files.includes('existing.ts'), true);
  // @ts-ignore - checking mock data
  assertEquals(updateData.files.includes('new.ts'), true);
});

Deno.test('ThreadManager - updateMetadata merges metadata', async () => {
  const sampleThread = createSampleThread({
    metadata: { key1: 'value1', key2: 'value2' },
  });

  let updateData: unknown = null;
  const mockFrom = {
    select: () => ({
      eq: () => ({
        single: () => ({
          data: sampleThread,
          error: null,
        }),
      }),
    }),
    update: (data: unknown) => {
      updateData = data;
      return {
        eq: () => ({ error: null }),
      };
    },
    delete: () => ({
      eq: () => ({ error: null }),
    }),
  };

  const mockSupabase = {
    from: () => mockFrom,
  };

  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const result = await manager.updateMetadata('test-thread-123', { key2: 'updated', key3: 'new' });

  assertEquals(result, true);
  assertExists(updateData);
  // @ts-ignore - checking mock data
  assertEquals(updateData.metadata.key1, 'value1');
  // @ts-ignore - checking mock data
  assertEquals(updateData.metadata.key2, 'updated');
  // @ts-ignore - checking mock data
  assertEquals(updateData.metadata.key3, 'new');
});

Deno.test('ThreadManager - cleanupExpired returns count', async () => {
  const mockSupabase = createMockSupabase({
    deleteData: [{ thread_id: 'expired-1' }, { thread_id: 'expired-2' }],
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const count = await manager.cleanupExpired();

  assertEquals(count, 2);
});

Deno.test('ThreadManager - getThreadStats returns statistics', async () => {
  const createdAt = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
  const sampleThread = createSampleThread({
    turns: [
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hi', timestamp: new Date().toISOString() },
    ],
    files: ['file1.ts', 'file2.ts', 'file3.ts'],
    created_at: createdAt.toISOString(),
  });
  const mockSupabase = createMockSupabase({
    selectData: sampleThread,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const stats = await manager.getThreadStats('test-thread-123');

  assertExists(stats);
  assertEquals(stats?.turnCount, 2);
  assertEquals(stats?.fileCount, 3);
  // Age should be approximately 30 minutes (allow some tolerance)
  assertEquals(stats?.ageMinutes >= 29 && stats?.ageMinutes <= 31, true);
});

Deno.test('ThreadManager - getThreadStats returns null for non-existent', async () => {
  const mockSupabase = createMockSupabase({
    selectData: null,
  });
  // @ts-ignore - mock type
  const manager = new ThreadManager(mockSupabase);

  const stats = await manager.getThreadStats('non-existent');

  assertEquals(stats, null);
});
