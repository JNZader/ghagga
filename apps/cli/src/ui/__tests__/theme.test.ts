/**
 * Unit tests for theme constants and resolveStepIcon function.
 *
 * Pure constants — no mocking needed.
 */

import { describe, expect, it } from 'vitest';
import {
  BRAND,
  resolveStepIcon,
  SEVERITY_EMOJI,
  SOURCE_LABELS,
  STATUS_EMOJI,
  STEP_ICON,
} from '../theme.js';

// ─── Constants ──────────────────────────────────────────────────

describe('BRAND', () => {
  it('should have name and tagline strings', () => {
    expect(BRAND).toHaveProperty('name');
    expect(BRAND).toHaveProperty('tagline');
    expect(typeof BRAND.name).toBe('string');
    expect(typeof BRAND.tagline).toBe('string');
    expect(BRAND.name).toBe('GHAGGA');
  });
});

describe('STATUS_EMOJI', () => {
  it('should have all 5 ReviewStatus keys', () => {
    expect(STATUS_EMOJI).toHaveProperty('PASSED');
    expect(STATUS_EMOJI).toHaveProperty('FAILED');
    expect(STATUS_EMOJI).toHaveProperty('NEEDS_HUMAN_REVIEW');
    expect(STATUS_EMOJI).toHaveProperty('SKIPPED');
    expect(STATUS_EMOJI).toHaveProperty('PARTIAL');
    expect(Object.keys(STATUS_EMOJI)).toHaveLength(5);
  });
});

describe('SEVERITY_EMOJI', () => {
  it('should have all 5 FindingSeverity keys', () => {
    expect(SEVERITY_EMOJI).toHaveProperty('critical');
    expect(SEVERITY_EMOJI).toHaveProperty('high');
    expect(SEVERITY_EMOJI).toHaveProperty('medium');
    expect(SEVERITY_EMOJI).toHaveProperty('low');
    expect(SEVERITY_EMOJI).toHaveProperty('info');
    expect(Object.keys(SEVERITY_EMOJI)).toHaveLength(5);
  });
});

describe('STEP_ICON', () => {
  it('should have all 13 known step keys', () => {
    const expectedKeys = [
      'validate',
      'parse-diff',
      'detect-stacks',
      'token-budget',
      'static-analysis',
      'static-results',
      'agent-start',
      'simple-call',
      'simple-done',
      'workflow-start',
      'workflow-synthesis',
      'consensus-start',
      'consensus-voting',
    ];
    for (const key of expectedKeys) {
      expect(STEP_ICON).toHaveProperty(key);
    }
    expect(Object.keys(STEP_ICON)).toHaveLength(13);
  });
});

describe('SOURCE_LABELS', () => {
  it('should have all 4 source keys', () => {
    expect(SOURCE_LABELS).toHaveProperty('semgrep');
    expect(SOURCE_LABELS).toHaveProperty('trivy');
    expect(SOURCE_LABELS).toHaveProperty('cpd');
    expect(SOURCE_LABELS).toHaveProperty('ai');
    expect(Object.keys(SOURCE_LABELS)).toHaveLength(4);
  });
});

// ─── resolveStepIcon ────────────────────────────────────────────

describe('resolveStepIcon', () => {
  it('should return the STEP_ICON value for a known step', () => {
    expect(resolveStepIcon('validate')).toBe(STEP_ICON.validate);
    expect(resolveStepIcon('agent-start')).toBe(STEP_ICON['agent-start']);
  });

  it('should return specialist icon for "specialist-*" steps', () => {
    expect(resolveStepIcon('specialist-security')).toBe('👤');
    expect(resolveStepIcon('specialist-performance')).toBe('👤');
  });

  it('should return vote icon for "vote-*" steps', () => {
    expect(resolveStepIcon('vote-1')).toBe('🗳️');
    expect(resolveStepIcon('vote-final')).toBe('🗳️');
  });

  it('should return fallback icon for unknown steps', () => {
    expect(resolveStepIcon('unknown-step')).toBe('▸');
    expect(resolveStepIcon('')).toBe('▸');
  });
});
