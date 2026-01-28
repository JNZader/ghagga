/**
 * Unit tests for WorkflowEngine
 *
 * Tests cover:
 * - Parallel execution of 5 steps + synthesis
 * - Sequential execution with accumulation
 * - Step execution with prompts
 * - Error handling and retries
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
  beforeEach,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import {
  WorkflowEngine,
  type WorkflowEngineConfig,
  type LLMCaller,
} from './engine.ts';
import {
  CODE_REVIEW_WORKFLOW,
  getParallelSteps,
  getSynthesisStep,
} from './steps.ts';
import type { LLMResponse } from '../types/providers.ts';

/**
 * Creates a mock LLM caller that returns predefined responses
 */
function createMockLLMCaller(
  responses: Map<string, string> = new Map()
): LLMCaller {
  return async (options) => {
    // Extract step ID from system message
    const systemMessage = options.messages.find((m) => m.role === 'system');
    const content = systemMessage?.content || '';

    // Determine which step is being called based on prompt content
    let stepResponse = 'Default mock response';

    if (content.includes('analyze code scope')) {
      stepResponse = responses.get('scope') || 'Scope analysis: Small change, 2 files affected.';
    } else if (content.includes('enforce coding standards')) {
      stepResponse = responses.get('standards') || 'Standards: No major issues found.';
    } else if (content.includes('defensive programming')) {
      stepResponse = responses.get('errors') || 'Error handling: Proper null checks in place.';
    } else if (content.includes('security auditor')) {
      stepResponse = responses.get('security') || 'Security: No vulnerabilities detected.';
    } else if (content.includes('performance engineer')) {
      stepResponse = responses.get('performance') || 'Performance: O(n) complexity, acceptable.';
    } else if (content.includes('Synthesize all findings')) {
      stepResponse =
        responses.get('synthesis') ||
        '## Summary\nAll checks passed.\n\n## STATUS: PASSED\nNo critical issues found.';
    }

    return {
      content: stepResponse,
      model: 'mock-model',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    } satisfies LLMResponse;
  };
}

/**
 * Creates a failing mock LLM caller for error testing
 */
function createFailingLLMCaller(failCount: number = 1): {
  caller: LLMCaller;
  callCount: () => number;
} {
  let calls = 0;
  let failures = 0;

  return {
    caller: async () => {
      calls++;
      if (failures < failCount) {
        failures++;
        throw new Error('Mock LLM error');
      }
      return {
        content: 'Recovery response',
        model: 'mock-model',
      };
    },
    callCount: () => calls,
  };
}

/**
 * Creates a default test configuration
 */
function createTestConfig(): WorkflowEngineConfig {
  return {
    provider: {
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: 1000,
    },
    stepTimeout: 5000,
    maxRetries: 2,
    continueOnFailure: true,
  };
}

describe('WorkflowEngine', () => {
  describe('constructor', () => {
    it('should create engine with default config values', () => {
      const config = createTestConfig();
      const engine = new WorkflowEngine(config, createMockLLMCaller());

      const engineConfig = engine.getConfig();
      assertEquals(engineConfig.stepTimeout, 5000);
      assertEquals(engineConfig.maxRetries, 2);
      assertEquals(engineConfig.continueOnFailure, true);
    });

    it('should use workflow steps', () => {
      const engine = new WorkflowEngine(createTestConfig(), createMockLLMCaller());
      const steps = engine.getSteps();

      assertEquals(steps.length, CODE_REVIEW_WORKFLOW.length);
      assertEquals(steps[0].id, 'scope');
      assertEquals(steps[5].id, 'synthesis');
    });
  });

  describe('runParallel', () => {
    it('should execute 5 steps in parallel followed by synthesis', async () => {
      const callOrder: string[] = [];
      const mockCaller: LLMCaller = async (options) => {
        const systemMsg = options.messages.find((m) => m.role === 'system')?.content || '';

        let stepId = 'unknown';
        if (systemMsg.includes('analyze code scope')) stepId = 'scope';
        else if (systemMsg.includes('enforce coding standards')) stepId = 'standards';
        else if (systemMsg.includes('defensive programming')) stepId = 'errors';
        else if (systemMsg.includes('security auditor')) stepId = 'security';
        else if (systemMsg.includes('performance engineer')) stepId = 'performance';
        else if (systemMsg.includes('Synthesize')) stepId = 'synthesis';

        callOrder.push(stepId);

        return {
          content: `${stepId} findings`,
          model: 'mock',
        };
      };

      const engine = new WorkflowEngine(createTestConfig(), mockCaller);
      const result = await engine.runParallel('test code', 'test rules');

      // Should have 5 parallel results + synthesis
      assertEquals(result.findings.length, 5);
      assertExists(result.synthesis);
      assertEquals(result.synthesis.stepId, 'synthesis');

      // Synthesis should be called last
      assertEquals(callOrder[callOrder.length - 1], 'synthesis');
    });

    it('should pass all findings to synthesis step', async () => {
      let synthesisPreviousFindings = '';

      const mockCaller: LLMCaller = async (options) => {
        const systemMsg = options.messages.find((m) => m.role === 'system')?.content || '';

        if (systemMsg.includes('Synthesize')) {
          const prevFindings = options.messages.find((m) =>
            m.content.includes('Previous Analysis Findings')
          );
          synthesisPreviousFindings = prevFindings?.content || '';
        }

        return { content: 'mock findings', model: 'mock' };
      };

      const engine = new WorkflowEngine(createTestConfig(), mockCaller);
      await engine.runParallel('test code', 'test rules');

      // Synthesis should receive findings from all parallel steps
      assertStringIncludes(synthesisPreviousFindings, 'Scope Analysis');
      assertStringIncludes(synthesisPreviousFindings, 'Coding Standards');
      assertStringIncludes(synthesisPreviousFindings, 'Error Handling');
      assertStringIncludes(synthesisPreviousFindings, 'Security Audit');
      assertStringIncludes(synthesisPreviousFindings, 'Performance Review');
    });

    it('should return passed status when synthesis indicates PASSED', async () => {
      const responses = new Map([
        ['synthesis', '## Summary\nAll good.\n\n## STATUS: PASSED\nNo issues.'],
      ]);

      const engine = new WorkflowEngine(createTestConfig(), createMockLLMCaller(responses));
      const result = await engine.runParallel('test code', 'test rules');

      assertEquals(result.status, 'passed');
    });

    it('should return failed status when synthesis indicates FAILED', async () => {
      const responses = new Map([
        ['synthesis', '## Summary\nCritical issues.\n\n## STATUS: FAILED\nSecurity vulnerability.'],
      ]);

      const engine = new WorkflowEngine(createTestConfig(), createMockLLMCaller(responses));
      const result = await engine.runParallel('test code', 'test rules');

      assertEquals(result.status, 'failed');
    });

    it('should handle errors and return error status', async () => {
      const failingCaller: LLMCaller = async () => {
        throw new Error('LLM service unavailable');
      };

      const engine = new WorkflowEngine(
        { ...createTestConfig(), maxRetries: 0 },
        failingCaller
      );
      const result = await engine.runParallel('test code', 'test rules');

      assertEquals(result.status, 'error');
      assertExists(result.error);
      assertStringIncludes(result.error, 'LLM service unavailable');
    });

    it('should track total duration', async () => {
      const engine = new WorkflowEngine(createTestConfig(), createMockLLMCaller());
      const result = await engine.runParallel('test code', 'test rules');

      assertExists(result.totalDuration_ms);
      assertEquals(typeof result.totalDuration_ms, 'number');
    });
  });

  describe('runSequential', () => {
    it('should execute steps in order with accumulated findings', async () => {
      const callOrder: string[] = [];
      const receivedPreviousFindings: Map<string, string> = new Map();

      const mockCaller: LLMCaller = async (options) => {
        const systemMsg = options.messages.find((m) => m.role === 'system')?.content || '';
        const prevFindings =
          options.messages.find((m) => m.content.includes('Previous Analysis'))?.content || '';

        let stepId = 'unknown';
        if (systemMsg.includes('analyze code scope')) stepId = 'scope';
        else if (systemMsg.includes('enforce coding standards')) stepId = 'standards';
        else if (systemMsg.includes('defensive programming')) stepId = 'errors';
        else if (systemMsg.includes('security auditor')) stepId = 'security';
        else if (systemMsg.includes('performance engineer')) stepId = 'performance';
        else if (systemMsg.includes('Synthesize')) stepId = 'synthesis';

        callOrder.push(stepId);
        receivedPreviousFindings.set(stepId, prevFindings);

        return {
          content: `${stepId} detailed findings`,
          model: 'mock',
        };
      };

      const engine = new WorkflowEngine(createTestConfig(), mockCaller);
      const result = await engine.runSequential('test code', 'test rules');

      // Steps should be called in order
      assertEquals(callOrder, ['scope', 'standards', 'errors', 'security', 'performance', 'synthesis']);

      // First step should have no previous findings
      assertEquals(receivedPreviousFindings.get('scope'), '');

      // Later steps should have accumulated findings
      assertStringIncludes(receivedPreviousFindings.get('standards') || '', 'scope');
      assertStringIncludes(receivedPreviousFindings.get('synthesis') || '', 'performance');

      // Should have 5 findings + synthesis
      assertEquals(result.findings.length, 5);
      assertEquals(result.synthesis.stepId, 'synthesis');
    });

    it('should stop on failure when continueOnFailure is false', async () => {
      let callCount = 0;

      const mockCaller: LLMCaller = async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Step failed');
        }
        return { content: 'success', model: 'mock' };
      };

      const config = { ...createTestConfig(), continueOnFailure: false, maxRetries: 0 };
      const engine = new WorkflowEngine(config, mockCaller);
      const result = await engine.runSequential('test code', 'test rules');

      // Should stop after the failed step
      assertEquals(result.findings.length, 1);
      assertEquals(result.findings[0].status, 'success');
    });

    it('should continue on failure when configured', async () => {
      let callCount = 0;

      const mockCaller: LLMCaller = async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Step failed');
        }
        return { content: 'success', model: 'mock' };
      };

      const config = { ...createTestConfig(), continueOnFailure: true, maxRetries: 0 };
      const engine = new WorkflowEngine(config, mockCaller);
      const result = await engine.runSequential('test code', 'test rules');

      // Should continue despite failure
      assertEquals(result.findings.length, 5);
    });
  });

  describe('executeStep', () => {
    it('should build correct messages from step definition', async () => {
      let capturedMessages: unknown[] = [];

      const mockCaller: LLMCaller = async (options) => {
        capturedMessages = options.messages;
        return { content: 'findings', model: 'mock' };
      };

      const engine = new WorkflowEngine(createTestConfig(), mockCaller);
      const scopeStep = CODE_REVIEW_WORKFLOW.find((s) => s.id === 'scope')!;

      await engine.executeStep(scopeStep, {
        content: 'function test() {}',
        rules: 'Use TypeScript',
        previousFindings: '',
      });

      // Should have system message with agent prompt
      const systemMsg = capturedMessages.find(
        (m: { role: string }) => m.role === 'system'
      ) as { content: string };
      assertExists(systemMsg);
      assertStringIncludes(systemMsg.content, 'analyze code scope');

      // Should have rules message
      const rulesMsg = capturedMessages.find(
        (m: { content: string }) =>
          m.content && m.content.includes('Repository Rules')
      ) as { content: string };
      assertExists(rulesMsg);
      assertStringIncludes(rulesMsg.content, 'Use TypeScript');

      // Should have content message
      const contentMsg = capturedMessages.find(
        (m: { content: string }) =>
          m.content && m.content.includes('Code to Review')
      ) as { content: string };
      assertExists(contentMsg);
      assertStringIncludes(contentMsg.content, 'function test()');
    });

    it('should include previous findings when provided', async () => {
      let capturedMessages: unknown[] = [];

      const mockCaller: LLMCaller = async (options) => {
        capturedMessages = options.messages;
        return { content: 'findings', model: 'mock' };
      };

      const engine = new WorkflowEngine(createTestConfig(), mockCaller);
      const synthesisStep = getSynthesisStep();

      await engine.executeStep(synthesisStep, {
        content: 'code',
        rules: 'rules',
        previousFindings: 'Previous step found issues X, Y, Z',
      });

      const prevFindingsMsg = capturedMessages.find(
        (m: { content: string }) =>
          m.content && m.content.includes('Previous Analysis Findings')
      ) as { content: string };
      assertExists(prevFindingsMsg);
      assertStringIncludes(prevFindingsMsg.content, 'issues X, Y, Z');
    });

    it('should return success result on successful execution', async () => {
      const engine = new WorkflowEngine(createTestConfig(), createMockLLMCaller());
      const step = CODE_REVIEW_WORKFLOW[0];

      const result = await engine.executeStep(step, {
        content: 'code',
        rules: 'rules',
        previousFindings: '',
      });

      assertEquals(result.status, 'success');
      assertEquals(result.stepId, step.id);
      assertEquals(result.stepName, step.name);
      assertExists(result.findings);
      assertExists(result.duration_ms);
    });

    it('should return failed result on error', async () => {
      const failingCaller: LLMCaller = async () => {
        throw new Error('API error');
      };

      const config = { ...createTestConfig(), maxRetries: 0 };
      const engine = new WorkflowEngine(config, failingCaller);
      const step = CODE_REVIEW_WORKFLOW[0];

      const result = await engine.executeStep(step, {
        content: 'code',
        rules: 'rules',
        previousFindings: '',
      });

      assertEquals(result.status, 'failed');
      assertExists(result.error);
      assertStringIncludes(result.error, 'API error');
    });
  });

  describe('retry logic', () => {
    it('should retry on failure up to maxRetries', async () => {
      const { caller, callCount } = createFailingLLMCaller(2);

      const config = { ...createTestConfig(), maxRetries: 3 };
      const engine = new WorkflowEngine(config, caller);
      const step = CODE_REVIEW_WORKFLOW[0];

      const result = await engine.executeStep(step, {
        content: 'code',
        rules: 'rules',
        previousFindings: '',
      });

      // Should succeed after retries (2 failures + 1 success = 3 calls)
      assertEquals(result.status, 'success');
      assertEquals(callCount(), 3);
    });

    it('should fail after exhausting retries', async () => {
      const { caller, callCount } = createFailingLLMCaller(10); // Always fail

      const config = { ...createTestConfig(), maxRetries: 2 };
      const engine = new WorkflowEngine(config, caller);
      const step = CODE_REVIEW_WORKFLOW[0];

      const result = await engine.executeStep(step, {
        content: 'code',
        rules: 'rules',
        previousFindings: '',
      });

      // Should fail after initial + 2 retries = 3 calls
      assertEquals(result.status, 'failed');
      assertEquals(callCount(), 3);
    });
  });

  describe('step helpers', () => {
    it('getParallelSteps should return 5 steps (excluding synthesis)', () => {
      const parallelSteps = getParallelSteps();
      assertEquals(parallelSteps.length, 5);
      assertEquals(parallelSteps.every((s) => s.id !== 'synthesis'), true);
    });

    it('getSynthesisStep should return the synthesis step', () => {
      const synthesis = getSynthesisStep();
      assertEquals(synthesis.id, 'synthesis');
      assertEquals(synthesis.name, 'Final Synthesis');
    });
  });
});
