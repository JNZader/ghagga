/**
 * Tests for workflow step definitions and helper functions
 */

import {
  assertEquals,
  assertExists,
  assertThrows,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import {
  CODE_REVIEW_WORKFLOW,
  getStepById,
  getParallelSteps,
  getSynthesisStep,
  type WorkflowStepDefinition,
} from './steps.ts';

describe('CODE_REVIEW_WORKFLOW', () => {
  it('should have 6 steps total', () => {
    assertEquals(CODE_REVIEW_WORKFLOW.length, 6);
  });

  it('should have unique step IDs', () => {
    const ids = CODE_REVIEW_WORKFLOW.map((s) => s.id);
    const unique = new Set(ids);
    assertEquals(unique.size, ids.length);
  });

  it('should have the expected step IDs', () => {
    const ids = CODE_REVIEW_WORKFLOW.map((s) => s.id);
    assertEquals(ids.includes('scope'), true);
    assertEquals(ids.includes('standards'), true);
    assertEquals(ids.includes('errors'), true);
    assertEquals(ids.includes('security'), true);
    assertEquals(ids.includes('performance'), true);
    assertEquals(ids.includes('synthesis'), true);
  });

  it('should have synthesis as the last step', () => {
    const last = CODE_REVIEW_WORKFLOW[CODE_REVIEW_WORKFLOW.length - 1];
    assertEquals(last.id, 'synthesis');
  });

  it('every step should have a non-empty agentPrompt', () => {
    for (const step of CODE_REVIEW_WORKFLOW) {
      assertEquals(step.agentPrompt.length > 0, true, `Step ${step.id} has empty prompt`);
    }
  });

  it('every step should have requiredActions', () => {
    for (const step of CODE_REVIEW_WORKFLOW) {
      assertEquals(step.requiredActions.length > 0, true, `Step ${step.id} has no actions`);
    }
  });
});

describe('getStepById', () => {
  it('should return step by valid ID', () => {
    const step = getStepById('scope');
    assertExists(step);
    assertEquals(step.id, 'scope');
    assertEquals(step.name, 'Scope Analysis');
  });

  it('should return step for each known ID', () => {
    const ids = ['scope', 'standards', 'errors', 'security', 'performance', 'synthesis'];
    for (const id of ids) {
      const step = getStepById(id);
      assertExists(step, `Step ${id} not found`);
      assertEquals(step.id, id);
    }
  });

  it('should return undefined for unknown ID', () => {
    const step = getStepById('nonexistent');
    assertEquals(step, undefined);
  });

  it('should return undefined for empty string', () => {
    const step = getStepById('');
    assertEquals(step, undefined);
  });
});

describe('getParallelSteps', () => {
  it('should return 5 steps (all except synthesis)', () => {
    const steps = getParallelSteps();
    assertEquals(steps.length, 5);
  });

  it('should not include synthesis', () => {
    const steps = getParallelSteps();
    const ids = steps.map((s) => s.id);
    assertEquals(ids.includes('synthesis'), false);
  });

  it('should include all analysis steps', () => {
    const steps = getParallelSteps();
    const ids = steps.map((s) => s.id);
    assertEquals(ids.includes('scope'), true);
    assertEquals(ids.includes('standards'), true);
    assertEquals(ids.includes('errors'), true);
    assertEquals(ids.includes('security'), true);
    assertEquals(ids.includes('performance'), true);
  });

  it('should return new array each time (not a reference)', () => {
    const steps1 = getParallelSteps();
    const steps2 = getParallelSteps();
    assertEquals(steps1 !== steps2, true);
    assertEquals(steps1.length, steps2.length);
  });
});

describe('getSynthesisStep', () => {
  it('should return the synthesis step', () => {
    const step = getSynthesisStep();
    assertEquals(step.id, 'synthesis');
    assertEquals(step.name, 'Final Synthesis');
  });

  it('should have synthesis-specific prompt content', () => {
    const step = getSynthesisStep();
    assertEquals(step.agentPrompt.includes('Synthesize'), true);
    assertEquals(step.agentPrompt.includes('PASSED'), true);
    assertEquals(step.agentPrompt.includes('FAILED'), true);
  });

  it('should have deduplicate and prioritize in required actions', () => {
    const step = getSynthesisStep();
    assertEquals(step.requiredActions.includes('deduplicate'), true);
    assertEquals(step.requiredActions.includes('prioritize'), true);
    assertEquals(step.requiredActions.includes('determine_status'), true);
  });
});
