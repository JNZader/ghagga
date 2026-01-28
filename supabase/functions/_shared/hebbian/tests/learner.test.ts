/**
 * Tests for HebbianLearner class
 */

import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { HebbianLearner, type PredictionResult } from '../learner.ts';

/**
 * Mock Supabase client for testing
 */
function createMockSupabase() {
  const associations: Map<string, {
    id: string;
    repo_full_name: string;
    source_pattern: string;
    target_pattern: string;
    association_type: string;
    weight: number;
    activation_count: number;
    last_activated_at: string;
  }> = new Map();

  let idCounter = 0;

  const mockClient = {
    from: (table: string) => {
      if (table !== 'hebbian_associations') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select: (_columns: string) => ({
          eq: (col: string, val: string | number) => {
            const filter = { [col]: val };
            return createFilterChain(associations, filter);
          },
        }),
        insert: async (data: Record<string, unknown>) => {
          const id = `id-${++idCounter}`;
          const key = `${data.repo_full_name}:${data.source_pattern}:${data.target_pattern}:${data.association_type}`;
          associations.set(key, { id, ...data } as typeof associations extends Map<string, infer V> ? V : never);
          return { data: { id }, error: null };
        },
        update: (data: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            for (const [key, assoc] of associations) {
              if (assoc.id === id) {
                associations.set(key, { ...assoc, ...data });
                break;
              }
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    _getAssociations: () => associations,
    _clearAssociations: () => associations.clear(),
  };

  function createFilterChain(
    assocs: typeof associations,
    filters: Record<string, unknown>
  ) {
    return {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return createFilterChain(assocs, filters);
      },
      or: (_filter: string) => ({
        gte: (_col: string, _val: number) => ({
          order: (_col2: string, _opts: { ascending: boolean }) => ({
            limit: (_n: number) => ({
              in: (_col3: string, _vals: string[]) => {
                const results = Array.from(assocs.values()).filter((a) => {
                  return Object.entries(filters).every(
                    ([k, v]) => (a as Record<string, unknown>)[k] === v
                  );
                });
                return Promise.resolve({ data: results, error: null });
              },
              then: (resolve: (val: { data: unknown[]; error: null }) => void) => {
                const results = Array.from(assocs.values()).filter((a) => {
                  return Object.entries(filters).every(
                    ([k, v]) => (a as Record<string, unknown>)[k] === v
                  );
                });
                resolve({ data: results, error: null });
              },
            }),
          }),
        }),
      }),
      gt: (_col: string, _val: number) => ({
        then: (resolve: (val: { data: unknown[]; error: null }) => void) => {
          const results = Array.from(assocs.values()).filter((a) => {
            return Object.entries(filters).every(
              ([k, v]) => (a as Record<string, unknown>)[k] === v
            );
          });
          resolve({ data: results, error: null });
        },
      }),
      single: () => {
        const results = Array.from(assocs.values()).filter((a) => {
          return Object.entries(filters).every(
            ([k, v]) => (a as Record<string, unknown>)[k] === v
          );
        });
        return Promise.resolve({
          data: results.length > 0 ? results[0] : null,
          error: null,
        });
      },
    };
  }

  return mockClient;
}

Deno.test('HebbianLearner - constructor creates instance with default config', () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  const config = learner.getConfig();

  assertEquals(config.enabled, true);
  assertEquals(config.learning_rate, 0.1);
  assertEquals(config.decay_rate, 0.01);
  assertEquals(config.min_weight, 0.0);
  assertEquals(config.max_weight, 1.0);
});

Deno.test('HebbianLearner - constructor accepts custom config', () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(
    mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0],
    { learning_rate: 0.2, decay_rate: 0.05 }
  );

  const config = learner.getConfig();

  assertEquals(config.learning_rate, 0.2);
  assertEquals(config.decay_rate, 0.05);
});

Deno.test('HebbianLearner - setConfig updates configuration', () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  learner.setConfig({ learning_rate: 0.3 });
  const config = learner.getConfig();

  assertEquals(config.learning_rate, 0.3);
  assertEquals(config.decay_rate, 0.01); // unchanged
});

Deno.test('HebbianLearner - strengthen creates new association', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  await learner.strengthen('owner/repo', 'security', 'database');

  const assocs = mockSupabase._getAssociations();
  assertEquals(assocs.size, 1);

  const assoc = Array.from(assocs.values())[0];
  assertEquals(assoc.repo_full_name, 'owner/repo');
  assertEquals(assoc.source_pattern, 'database'); // alphabetically sorted
  assertEquals(assoc.target_pattern, 'security');
  assertEquals(assoc.weight > 0.5, true);
});

Deno.test('HebbianLearner - strengthen with consistent ordering', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  // Strengthen in different order
  await learner.strengthen('owner/repo', 'security', 'api');
  mockSupabase._clearAssociations();
  await learner.strengthen('owner/repo', 'api', 'security');

  const assocs = mockSupabase._getAssociations();
  const assoc = Array.from(assocs.values())[0];

  // Should be same ordering regardless of input order
  assertEquals(assoc.source_pattern, 'api');
  assertEquals(assoc.target_pattern, 'security');
});

Deno.test('HebbianLearner - strengthenAll creates pairwise associations', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  await learner.strengthenAll('owner/repo', ['a', 'b', 'c']);

  const assocs = mockSupabase._getAssociations();
  // 3 concepts = 3 pairs: (a,b), (a,c), (b,c)
  assertEquals(assocs.size, 3);
});

Deno.test('HebbianLearner - getNetworkStats returns correct statistics', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  // Create some associations
  await learner.strengthen('owner/repo', 'a', 'b');
  await learner.strengthen('owner/repo', 'c', 'd');

  const stats = await learner.getNetworkStats('owner/repo');

  assertEquals(stats.totalConnections, 2);
  assertEquals(stats.avgWeight > 0, true);
});

Deno.test('HebbianLearner - getNetworkStats returns zeros for empty repo', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  const stats = await learner.getNetworkStats('empty/repo');

  assertEquals(stats.totalConnections, 0);
  assertEquals(stats.avgWeight, 0);
  assertEquals(stats.strongConnections, 0);
});

Deno.test('HebbianLearner - predict returns empty array for no concepts', async () => {
  const mockSupabase = createMockSupabase();
  const learner = new HebbianLearner(mockSupabase as unknown as Parameters<typeof HebbianLearner['prototype']['constructor']>[0]);

  const predictions = await learner.predict('owner/repo', []);

  assertEquals(predictions.length, 0);
});

Deno.test('HebbianLearner - PredictionResult has correct shape', () => {
  const result: PredictionResult = {
    concept: 'security',
    weight: 0.8,
    associationType: 'code_pattern',
    activationCount: 5,
  };

  assertExists(result.concept);
  assertExists(result.weight);
  assertExists(result.associationType);
  assertExists(result.activationCount);
});
