/**
 * Tests for MemoryService
 */

import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { MemoryService } from '../service.ts';

// --- Mock Supabase Client ---

function createMockSupabase(options?: {
  rpcResults?: Record<string, unknown[]>;
  sessionCount?: number;
}) {
  const sessions: Record<string, Record<string, unknown>> = {};
  const observations: Record<string, Record<string, unknown>> = {};
  let idCounter = 0;

  return {
    from: (table: string) => {
      const store = table === 'memory_sessions' ? sessions : observations;

      return {
        insert: (data: Record<string, unknown>) => ({
          select: (_cols: string) => ({
            single: () => {
              const id = `mock-id-${++idCounter}`;
              store[id] = { id, ...data };
              return Promise.resolve({ data: { id }, error: null });
            },
          }),
        }),
        update: (data: Record<string, unknown>) => ({
          eq: (_col: string, _val: string) => {
            return Promise.resolve({ error: null });
          },
        }),
        select: (cols: string, opts?: { count?: string; head?: boolean }) => {
          const chainable = {
            eq: (_col: string, _val: unknown) => chainable,
            in: (_col: string, _vals: unknown[]) => chainable,
            order: (_col: string, _opts?: Record<string, unknown>) => chainable,
            limit: (_n: number) => chainable,
            then: (resolve: (val: unknown) => void) => {
              if (opts?.head) {
                resolve({ count: options?.sessionCount ?? 0, error: null });
              } else {
                resolve({ data: Object.values(store), error: null });
              }
            },
          };
          // Make it thenable for await
          // deno-lint-ignore no-explicit-any
          (chainable as any)[Symbol.toStringTag] = 'Promise';
          Object.defineProperty(chainable, 'then', {
            value: (resolve: (val: unknown) => void) => {
              if (opts?.head) {
                resolve({ count: options?.sessionCount ?? 0, error: null });
              } else {
                resolve({ data: Object.values(store), error: null });
              }
              return chainable;
            },
          });
          return chainable;
        },
      };
    },
    rpc: (fn: string, _params: Record<string, unknown>) => {
      const results = options?.rpcResults?.[fn] || [];
      return Promise.resolve({ data: results, error: null });
    },
    _sessions: sessions,
    _observations: observations,
  };
}

// --- Mock Embedding Service ---

function createMockEmbeddingService() {
  return {
    embed: async (text: string) => ({
      embedding: new Array(1536).fill(0.1),
      model: 'mock',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
    embedBatch: async (texts: string[]) =>
      texts.map(() => ({
        embedding: new Array(1536).fill(0.1),
        model: 'mock',
        usage: { prompt_tokens: 10, total_tokens: 10 },
      })),
  };
}

// --- Tests ---

describe('MemoryService.extractObservationsFromFindings', () => {
  it('should convert error findings to bugfix observations', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      {
        severity: 'error' as const,
        category: 'security',
        message: 'SQL injection vulnerability in user input',
        file: 'src/api/users.ts',
        line: 42,
        suggestion: 'Use parameterized queries',
      },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [{ filename: 'src/api/users.ts' }],
      1,
      'session-1',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 1);
    assertEquals(observations[0].observationType, 'bugfix');
    assertEquals(observations[0].sessionId, 'session-1');
    assertEquals(observations[0].installationId, 100);
    assertEquals(observations[0].repoFullName, 'owner/repo');
    assertEquals(observations[0].whereInCode, 'src/api/users.ts:42');
    assertEquals(observations[0].whatWasLearned, 'Use parameterized queries');
    assertExists(observations[0].tags);
    assertEquals(observations[0].tags!.includes('security'), true);
    assertEquals(observations[0].confidence, 0.9);
  });

  it('should convert warning findings to learning observations', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      {
        severity: 'warning' as const,
        category: 'complexity',
        message: 'Function too complex',
        file: 'src/utils.ts',
      },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [{ filename: 'src/utils.ts' }],
      2,
      'session-2',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 1);
    assertEquals(observations[0].observationType, 'learning');
    assertEquals(observations[0].confidence, 0.7);
  });

  it('should convert style findings to pattern observations', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      {
        severity: 'info' as const,
        category: 'style',
        message: 'Use camelCase for variables',
      },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [],
      3,
      'session-3',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 1);
    assertEquals(observations[0].observationType, 'pattern');
  });

  it('should convert performance findings to discovery observations', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      {
        severity: 'suggestion' as const,
        category: 'performance',
        message: 'Consider using memoization',
      },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [],
      4,
      'session-4',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 1);
    assertEquals(observations[0].observationType, 'discovery');
    assertEquals(observations[0].confidence, 0.4);
  });

  it('should handle multiple findings from same file', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      { severity: 'error' as const, category: 'bug', message: 'Null pointer', file: 'a.ts', line: 10 },
      { severity: 'warning' as const, category: 'style', message: 'Naming', file: 'a.ts', line: 20 },
      { severity: 'info' as const, category: 'docs', message: 'Missing docs', file: 'b.ts' },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [{ filename: 'a.ts' }, { filename: 'b.ts' }],
      5,
      'session-5',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 3);
  });

  it('should handle findings without file (global)', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      { severity: 'info' as const, category: 'review', message: 'Overall good' },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [],
      6,
      'session-6',
      100,
      'owner/repo'
    );

    assertEquals(observations.length, 1);
    assertEquals(observations[0].whereInCode, undefined);
  });

  it('should include file extension in tags', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const findings = [
      { severity: 'error' as const, category: 'bug', message: 'Issue', file: 'src/main.py' },
    ];

    const observations = service.extractObservationsFromFindings(
      findings,
      [{ filename: 'src/main.py' }],
      7,
      'session-7',
      100,
      'owner/repo'
    );

    assertEquals(observations[0].tags!.includes('py'), true);
  });
});

describe('MemoryService.formatContextForLLM', () => {
  it('should return empty string for no observations', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const result = service.formatContextForLLM({
      observations: [],
      sessionCount: 0,
      query: 'test',
    });

    assertEquals(result, '');
  });

  it('should format observations as markdown', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const result = service.formatContextForLLM({
      observations: [
        {
          id: '1',
          session_id: 's1',
          installation_id: 100,
          repo_full_name: 'owner/repo',
          observation_type: 'bugfix',
          title: 'Auth token race condition',
          content: 'Details...',
          content_stripped: 'Details...',
          what_happened: 'Race condition found',
          why_it_matters: 'Security issue',
          where_in_code: 'src/auth.ts',
          what_was_learned: 'Always check token expiry before refresh',
          tags: ['security'],
          embedding: null,
          confidence: 0.9,
          metadata: {},
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      sessionCount: 1,
      query: 'test',
    });

    assertEquals(result.includes('## Past Review Memory'), true);
    assertEquals(result.includes('[bugfix]'), true);
    assertEquals(result.includes('Auth token race condition'), true);
    assertEquals(result.includes('src/auth.ts'), true);
    assertEquals(result.includes('Always check token expiry before refresh'), true);
  });

  it('should truncate when maxTokens is specified', () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const result = service.formatContextForLLM(
      {
        observations: [
          {
            id: '1',
            session_id: 's1',
            installation_id: 100,
            repo_full_name: 'owner/repo',
            observation_type: 'bugfix',
            title: 'A'.repeat(500),
            content: 'Long content',
            content_stripped: 'Long content',
            what_happened: 'B'.repeat(500),
            why_it_matters: null,
            where_in_code: null,
            what_was_learned: 'C'.repeat(500),
            tags: [],
            embedding: null,
            confidence: 0.5,
            metadata: {},
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        sessionCount: 1,
        query: 'test',
      },
      10 // very small token limit
    );

    assertEquals(result.includes('truncated'), true);
  });
});

describe('MemoryService.startSession', () => {
  it('should create a session and return an id', async () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const sessionId = await service.startSession('owner/repo', 100, 42, 'Fix auth bug');

    assertExists(sessionId);
    assertEquals(typeof sessionId, 'string');

    // Verify session was stored
    const storedSessions = Object.values(supabase._sessions);
    assertEquals(storedSessions.length, 1);
    assertEquals(storedSessions[0].repo_full_name, 'owner/repo');
    assertEquals(storedSessions[0].pr_number, 42);
    assertEquals(storedSessions[0].session_name, 'PR #42: Fix auth bug');
    assertEquals(storedSessions[0].status, 'active');
  });
});

describe('MemoryService.addObservation', () => {
  it('should create an observation with stripped privacy', async () => {
    const supabase = createMockSupabase();
    const embeddingService = createMockEmbeddingService();
    const service = new MemoryService(supabase as never, embeddingService as never);

    const obsId = await service.addObservation({
      sessionId: 'session-1',
      installationId: 100,
      repoFullName: 'owner/repo',
      observationType: 'bugfix',
      title: 'SQL injection found',
      content: 'Found issue with API key sk-abcdefghijklmnopqrstuvwxyz1234 exposed',
      whatHappened: 'SQL injection in user handler',
      whyItMatters: 'Security vulnerability',
      whereInCode: 'src/api/users.ts:42',
      whatWasLearned: 'Use parameterized queries',
      tags: ['security', 'sql'],
      confidence: 0.9,
    });

    assertExists(obsId);

    // Verify observation was stored with stripped content
    const stored = Object.values(supabase._observations);
    assertEquals(stored.length, 1);
    assertEquals(stored[0].observation_type, 'bugfix');
    // Content_stripped should have redacted the API key
    assertEquals(
      (stored[0].content_stripped as string).includes('sk-'),
      false
    );
    assertEquals(
      (stored[0].content_stripped as string).includes('[REDACTED_KEY]'),
      true
    );
  });
});
