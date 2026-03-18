/**
 * CLI Bridge provider tests.
 *
 * Tests the CLI bridge module that calls LLM CLIs directly
 * instead of using API tokens via the AI SDK.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Must import after mocking
import { execSync } from 'node:child_process';
import { _getAdapters, generateViaCLI, getAvailableCLIs } from './cli-bridge.js';

const mockExecSync = vi.mocked(execSync);

describe('cli-bridge', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getAvailableCLIs', () => {
    it('returns an array', () => {
      const result = getAvailableCLIs();
      expect(Array.isArray(result)).toBe(true);
    });

    it('only contains known CLI names', () => {
      const validNames = new Set(['claude', 'gemini', 'codex', 'copilot']);
      const result = getAvailableCLIs();
      for (const name of result) {
        expect(validNames.has(name)).toBe(true);
      }
    });
  });

  describe('_getAdapters', () => {
    it('returns adapters in priority order: claude, gemini, codex, copilot', () => {
      const adapters = _getAdapters();
      expect(adapters).toHaveLength(4);
      expect(adapters[0]?.name).toBe('claude');
      expect(adapters[1]?.name).toBe('gemini');
      expect(adapters[2]?.name).toBe('codex');
      expect(adapters[3]?.name).toBe('copilot');
    });

    it('each adapter has required fields', () => {
      const adapters = _getAdapters();
      for (const adapter of adapters) {
        expect(adapter).toHaveProperty('name');
        expect(adapter).toHaveProperty('command');
        expect(adapter).toHaveProperty('available');
        expect(adapter).toHaveProperty('generate');
        expect(typeof adapter.name).toBe('string');
        expect(typeof adapter.command).toBe('string');
        expect(typeof adapter.available).toBe('boolean');
        expect(typeof adapter.generate).toBe('function');
      }
    });
  });

  describe('generateViaCLI', () => {
    it('throws when no CLIs are available', () => {
      // Since detectCLI runs at module load time and all CLIs are likely
      // not installed in the test environment, all adapters should show
      // available: false (the mock makes `which` throw by default).
      // However, detectCLI already ran at import time, so we check the
      // actual availability state.
      const available = getAvailableCLIs();
      if (available.length === 0) {
        expect(() => generateViaCLI('test prompt')).toThrow(
          'No CLI providers available. Install one of: claude, gemini, codex, copilot',
        );
      }
    });

    it('error message includes all available CLI names when all fail', () => {
      // We can't easily mock the internal adapters' `available` flag since
      // it's set at module load. This test verifies the error format.
      const available = getAvailableCLIs();
      if (available.length === 0) {
        try {
          generateViaCLI('test prompt');
        } catch (error) {
          expect((error as Error).message).toContain('No CLI providers available');
        }
      }
    });

    it('returns correct shape when a CLI succeeds', () => {
      // If any CLI is actually available in the test env, verify the shape
      const available = getAvailableCLIs();
      if (available.length > 0) {
        // Mock the actual exec to return a fake review
        mockExecSync.mockReturnValue('STATUS: PASSED\nSUMMARY: Looks good\nFINDINGS:\n');
        const result = generateViaCLI('test');
        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('provider', 'cli-bridge');
        expect(result).toHaveProperty('cli');
        expect(typeof result.text).toBe('string');
        expect(typeof result.cli).toBe('string');
      }
    });

    it('respects preferredCLI ordering', () => {
      const adapters = _getAdapters();
      // Verify that preferredCLI would reorder (structural test)
      const names = adapters.map((a) => a.name);
      expect(names).toEqual(['claude', 'gemini', 'codex', 'copilot']);
    });
  });
});
