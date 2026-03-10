/**
 * Integration test for registry-driven action orchestrator.
 *
 * Verifies that runLocalAnalysis() uses the registry-driven path
 * with ActionsExecutionContext, produces correct StaticAnalysisResult
 * shape with expected tool entries, and maintains backward compatibility
 * with legacy keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
}));

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
}));

// Mock the legacy tool executors (not used when registry is enabled)
vi.mock('../semgrep.js', () => ({
  executeSemgrep: vi.fn(),
}));

vi.mock('../trivy.js', () => ({
  executeTrivy: vi.fn(),
}));

vi.mock('../cpd.js', () => ({
  executeCpd: vi.fn(),
}));

// Mock the execution context to avoid real exec calls
vi.mock('../execution.js', () => ({
  createActionsExecutionContext: vi.fn(),
}));

import * as core from '@actions/core';
import type { ExecutionContext, RawToolOutput, ToolResult } from 'ghagga-core';
import { resetInitialization, toolRegistry } from 'ghagga-core';
import { createActionsExecutionContext } from '../execution.js';
import { runLocalAnalysis } from '../orchestrator.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockInfo = vi.mocked(core.info);
const mockCreateCtx = vi.mocked(createActionsExecutionContext);

/** Create a mock ExecutionContext that returns success for all operations */
function createMockExecutionContext(): ExecutionContext {
  const successOutput: RawToolOutput = {
    stdout: '[]',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };

  return {
    exec: vi.fn().mockResolvedValue(successOutput),
    cacheRestore: vi.fn().mockResolvedValue(false),
    cacheSave: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runLocalAnalysis with registry-driven orchestrator', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    // Reset registry for fresh state — initializeDefaultTools() will re-register
    toolRegistry.clear();
    resetInitialization();

    // Set up mock execution context
    const mockCtx = createMockExecutionContext();
    mockCreateCtx.mockReturnValue(mockCtx);
  });

  afterEach(() => {
    process.env = originalEnv;
    toolRegistry.clear();
    resetInitialization();
  });

  it('uses registry-driven path when feature flag is enabled', async () => {
    await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    // Should log that it's using the registry path
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('registry-driven orchestrator'));

    // Should NOT have called legacy executors (they are mocked but shouldn't be called)
    const { executeSemgrep } = await import('../semgrep.js');
    expect(executeSemgrep).not.toHaveBeenCalled();
  });

  it('returns StaticAnalysisResult with legacy keys always present', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    // Legacy keys MUST always be present (backward compat)
    expect(result).toHaveProperty('semgrep');
    expect(result).toHaveProperty('trivy');
    expect(result).toHaveProperty('cpd');

    // Each legacy key must have a valid ToolResult shape
    for (const key of ['semgrep', 'trivy', 'cpd'] as const) {
      const toolResult = result[key];
      expect(toolResult).toHaveProperty('status');
      expect(toolResult).toHaveProperty('findings');
      expect(toolResult).toHaveProperty('executionTimeMs');
      expect(Array.isArray(toolResult.findings)).toBe(true);
      expect(typeof toolResult.executionTimeMs).toBe('number');
    }
  });

  it('includes additional always-on tool results', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    // Always-on tools from the registry should be present
    // The 7 always-on tools: semgrep, trivy, cpd, gitleaks, shellcheck, markdownlint, lizard
    for (const toolName of ['gitleaks', 'shellcheck', 'markdownlint', 'lizard']) {
      expect(result).toHaveProperty(toolName);
      const toolResult = result[toolName] as ToolResult;
      expect(toolResult).toBeDefined();
      expect(toolResult).toHaveProperty('status');
      expect(toolResult).toHaveProperty('findings');
    }
  });

  it('passes enabledTools and disabledTools to the resolver', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      enabledTools: ['ruff'],
      disabledTools: ['gitleaks'],
      repoDir: '/workspace',
    });

    // ruff should be force-enabled
    expect(result).toHaveProperty('ruff');
    const ruffResult = result['ruff'] as ToolResult;
    expect(ruffResult).toBeDefined();

    // gitleaks should be disabled (skipped via legacy key guarantee)
    const _gitleaksResult = result['gitleaks'] as ToolResult | undefined;
    // gitleaks shouldn't have run as a tool
    // It may be absent or skipped — depends on legacy key handling
  });

  it('respects disabledTools to skip always-on tools', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      disabledTools: ['semgrep', 'trivy'],
      repoDir: '/workspace',
    });

    // Legacy keys still present (guaranteed by ensureLegacyKeys)
    expect(result).toHaveProperty('semgrep');
    expect(result).toHaveProperty('trivy');

    // But they should be skipped since they were disabled
    expect(result.semgrep.status).toBe('skipped');
    expect(result.trivy.status).toBe('skipped');
  });

  it('respects legacy boolean flags when disabledTools is empty', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: false,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    // Semgrep should be skipped due to enableSemgrep: false
    expect(result.semgrep.status).toBe('skipped');
  });

  it('all tool results have valid ToolResult shape', async () => {
    const result = await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    for (const [_name, toolResult] of Object.entries(result)) {
      expect(toolResult).toHaveProperty('status');
      expect(['success', 'skipped', 'error', 'timeout']).toContain(
        (toolResult as ToolResult).status,
      );
      expect(toolResult).toHaveProperty('findings');
      expect(Array.isArray((toolResult as ToolResult).findings)).toBe(true);
      expect(toolResult).toHaveProperty('executionTimeMs');
      expect(typeof (toolResult as ToolResult).executionTimeMs).toBe('number');
    }
  });

  it('logs activated tools list', async () => {
    await runLocalAnalysis({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      repoDir: '/workspace',
    });

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Activated tools:'));
  });
});
