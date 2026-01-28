/**
 * Tests for ConsensusEngine
 *
 * Run with: deno test --allow-env supabase/functions/_shared/consensus/engine.test.ts
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';

import {
  ConsensusEngine,
  STANCE_PROMPTS,
  type AIProvider,
  type ConsensusModelConfig,
  type ConsensusResponse,
  type Stance,
} from './engine.ts';

import type { LLMRequestOptions, LLMResponse, LLMProvider } from '../types/index.ts';

/**
 * Mock AI Provider for testing
 */
function createMockProvider(
  name: LLMProvider,
  responseContent: string
): AIProvider {
  return {
    name,
    models: ['test-model'],
    async complete(_options: LLMRequestOptions): Promise<LLMResponse> {
      return {
        content: responseContent,
        model: 'test-model',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      };
    },
    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}

// ============================================================================
// STANCE_PROMPTS Tests
// ============================================================================

Deno.test('STANCE_PROMPTS should have all three stances', () => {
  const stances: Stance[] = ['for', 'against', 'neutral'];
  for (const stance of stances) {
    assertExists(STANCE_PROMPTS[stance]);
  }
});

Deno.test('STANCE_PROMPTS.for should advocate for approval', () => {
  const prompt = STANCE_PROMPTS.for;
  assertEquals(prompt.includes('IN FAVOR'), true);
  assertEquals(prompt.includes('Benefits'), true);
});

Deno.test('STANCE_PROMPTS.against should highlight concerns', () => {
  const prompt = STANCE_PROMPTS.against;
  assertEquals(prompt.includes('AGAINST'), true);
  assertEquals(prompt.includes('issues'), true);
  assertEquals(prompt.includes('risks'), true);
});

Deno.test('STANCE_PROMPTS.neutral should be balanced', () => {
  const prompt = STANCE_PROMPTS.neutral;
  assertEquals(prompt.includes('BALANCED'), true);
  assertEquals(prompt.includes('benefits'), true);
  assertEquals(prompt.includes('drawbacks'), true);
});

// ============================================================================
// ConsensusEngine Constructor Tests
// ============================================================================

Deno.test('ConsensusEngine should initialize with default config', () => {
  const engine = new ConsensusEngine();
  assertEquals(engine.getProviderNames().length, 0);
});

Deno.test('ConsensusEngine should accept custom config', () => {
  const engine = new ConsensusEngine({
    timeoutMs: 30000,
    maxRetries: 3,
  });
  assertExists(engine);
});

// ============================================================================
// Provider Registration Tests
// ============================================================================

Deno.test('ConsensusEngine should register providers', () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider('anthropic', 'test');

  engine.registerProvider(mockProvider);

  assertEquals(engine.hasProvider('anthropic'), true);
  assertEquals(engine.getProviderNames(), ['anthropic']);
});

Deno.test('ConsensusEngine should get registered provider', () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider('openai', 'test');

  engine.registerProvider(mockProvider);

  const provider = engine.getProvider('openai');
  assertExists(provider);
  assertEquals(provider.name, 'openai');
});

Deno.test('ConsensusEngine should return undefined for unregistered provider', () => {
  const engine = new ConsensusEngine();
  const provider = engine.getProvider('nonexistent');
  assertEquals(provider, undefined);
});

// ============================================================================
// getModelOpinion Tests
// ============================================================================

Deno.test('getModelOpinion should return proper response structure', async () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider(
    'anthropic',
    'DECISION: approve\nCONFIDENCE: 0.85\nREASONING: The code looks good.'
  );
  engine.registerProvider(mockProvider);

  const config: ConsensusModelConfig = {
    provider: 'anthropic',
    model: 'test-model',
    stance: 'for',
  };

  const response = await engine.getModelOpinion('Test proposal', config);

  assertEquals(response.provider, 'anthropic');
  assertEquals(response.model, 'test-model');
  assertEquals(response.stance, 'for');
  assertEquals(response.decision, 'approve');
  assertEquals(response.confidence, 0.85);
  assertEquals(response.reasoning, 'The code looks good.');
  assertExists(response.responseTimeMs);
  assertExists(response.tokenUsage);
});

Deno.test('getModelOpinion should throw for unregistered provider', async () => {
  const engine = new ConsensusEngine();

  const config: ConsensusModelConfig = {
    provider: 'nonexistent',
    model: 'test-model',
    stance: 'neutral',
  };

  await assertRejects(
    () => engine.getModelOpinion('Test proposal', config),
    Error,
    'Provider "nonexistent" is not registered'
  );
});

Deno.test('getModelOpinion should handle reject decision', async () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider(
    'anthropic',
    'DECISION: reject\nCONFIDENCE: 0.9\nREASONING: Security vulnerability found.'
  );
  engine.registerProvider(mockProvider);

  const config: ConsensusModelConfig = {
    provider: 'anthropic',
    model: 'test-model',
    stance: 'against',
  };

  const response = await engine.getModelOpinion('Test proposal', config);

  assertEquals(response.decision, 'reject');
  assertEquals(response.confidence, 0.9);
});

Deno.test('getModelOpinion should default to abstain for invalid response', async () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider('anthropic', 'Invalid response format');
  engine.registerProvider(mockProvider);

  const config: ConsensusModelConfig = {
    provider: 'anthropic',
    model: 'test-model',
    stance: 'neutral',
  };

  const response = await engine.getModelOpinion('Test proposal', config);

  assertEquals(response.decision, 'abstain');
  assertEquals(response.confidence, 0.5);
  assertEquals(response.reasoning, 'No reasoning provided');
});

Deno.test('getModelOpinion should clamp confidence to valid range', async () => {
  const engine = new ConsensusEngine();
  const mockProvider = createMockProvider(
    'anthropic',
    'DECISION: approve\nCONFIDENCE: 1.5\nREASONING: Too confident'
  );
  engine.registerProvider(mockProvider);

  const config: ConsensusModelConfig = {
    provider: 'anthropic',
    model: 'test-model',
    stance: 'for',
  };

  const response = await engine.getModelOpinion('Test proposal', config);
  assertEquals(response.confidence, 1); // Clamped to max
});

// ============================================================================
// calculateRecommendation Tests
// ============================================================================

Deno.test('calculateRecommendation should approve with strong consensus', () => {
  const engine = new ConsensusEngine();

  const responses: ConsensusResponse[] = [
    createMockResponse('approve', 0.9),
    createMockResponse('approve', 0.8),
    createMockResponse('approve', 0.7),
  ];

  const recommendation = engine.calculateRecommendation(responses);

  assertEquals(recommendation.action, 'approve');
  assertEquals(recommendation.confidence > 0.6, true);
});

Deno.test('calculateRecommendation should reject with strong rejection consensus', () => {
  const engine = new ConsensusEngine();

  const responses: ConsensusResponse[] = [
    createMockResponse('reject', 0.9),
    createMockResponse('reject', 0.8),
    createMockResponse('reject', 0.7),
  ];

  const recommendation = engine.calculateRecommendation(responses);

  assertEquals(recommendation.action, 'reject');
  assertEquals(recommendation.confidence > 0.6, true);
});

Deno.test('calculateRecommendation should suggest discuss for split votes', () => {
  const engine = new ConsensusEngine();

  const responses: ConsensusResponse[] = [
    createMockResponse('approve', 0.7),
    createMockResponse('reject', 0.7),
    createMockResponse('abstain', 0.5),
  ];

  const recommendation = engine.calculateRecommendation(responses);

  assertEquals(recommendation.action, 'discuss');
});

Deno.test('calculateRecommendation should handle all abstentions', () => {
  const engine = new ConsensusEngine();

  const responses: ConsensusResponse[] = [
    createMockResponse('abstain', 0.5),
    createMockResponse('abstain', 0.5),
  ];

  const recommendation = engine.calculateRecommendation(responses);

  assertEquals(recommendation.action, 'discuss');
  assertEquals(recommendation.confidence, 0);
});

Deno.test('calculateRecommendation should handle empty responses', () => {
  const engine = new ConsensusEngine();

  const recommendation = engine.calculateRecommendation([]);

  assertEquals(recommendation.action, 'discuss');
  assertEquals(recommendation.confidence, 0);
});

// ============================================================================
// runConsensus Tests
// ============================================================================

Deno.test('runConsensus should run all models in parallel', async () => {
  const engine = new ConsensusEngine();

  engine.registerProvider(
    createMockProvider(
      'anthropic',
      'DECISION: approve\nCONFIDENCE: 0.8\nREASONING: Looks good'
    )
  );
  engine.registerProvider(
    createMockProvider(
      'openai',
      'DECISION: approve\nCONFIDENCE: 0.7\nREASONING: Acceptable'
    )
  );

  const models: ConsensusModelConfig[] = [
    { provider: 'anthropic', model: 'test', stance: 'for' },
    { provider: 'openai', model: 'test', stance: 'neutral' },
  ];

  const result = await engine.runConsensus('Test proposal', models);

  assertEquals(result.responses.length, 2);
  assertExists(result.synthesis);
  assertExists(result.recommendation);
  assertEquals(result.totalTokens, 300); // 150 * 2
  assertExists(result.totalTimeMs);
});

Deno.test('runConsensus should throw for empty models array', async () => {
  const engine = new ConsensusEngine();

  await assertRejects(
    () => engine.runConsensus('Test proposal', []),
    Error,
    'At least one model is required for consensus'
  );
});

// ============================================================================
// synthesize Tests
// ============================================================================

Deno.test('synthesize should generate simple summary without synthesis model', async () => {
  const engine = new ConsensusEngine();

  const responses: ConsensusResponse[] = [
    createMockResponse('approve', 0.8, 'Good code quality'),
    createMockResponse('reject', 0.7, 'Security concern'),
  ];

  const synthesis = await engine.synthesize('Test proposal', responses);

  assertEquals(synthesis.includes('Consensus Summary'), true);
  assertEquals(synthesis.includes('Approvals: 1/2'), true);
  assertEquals(synthesis.includes('Rejections: 1/2'), true);
});

Deno.test('synthesize should use LLM when synthesis model is configured', async () => {
  const engine = new ConsensusEngine({
    synthesisModel: {
      provider: 'anthropic',
      model: 'claude-3',
    },
  });

  engine.registerProvider(
    createMockProvider('anthropic', 'This is an AI-generated synthesis.')
  );

  const responses: ConsensusResponse[] = [
    createMockResponse('approve', 0.8),
  ];

  const synthesis = await engine.synthesize('Test proposal', responses);

  assertEquals(synthesis, 'This is an AI-generated synthesis.');
});

// ============================================================================
// Helper Functions
// ============================================================================

function createMockResponse(
  decision: 'approve' | 'reject' | 'abstain',
  confidence: number,
  reasoning = 'Test reasoning'
): ConsensusResponse {
  return {
    provider: 'test-provider',
    model: 'test-model',
    stance: 'neutral',
    decision,
    confidence,
    reasoning,
    responseTimeMs: 100,
  };
}
