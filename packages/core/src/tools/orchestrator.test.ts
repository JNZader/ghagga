/**
 * Unit tests for the tool orchestrator.
 *
 * Uses MockExecutionContext to test:
 * - Success path
 * - One tool crash
 * - Tool timeout
 * - Parse failure
 * - Install failure isolation
 * - Legacy keys always present
 * - Total budget exhaustion
 * - Result aggregation
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../types.js';
import { runTools } from './orchestrator.js';
import type { ActivatedTool } from './resolve.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition } from './types.js';

// ─── Mock Execution Context ─────────────────────────────────────

function createMockContext(): ExecutionContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    async exec(): Promise<RawToolOutput> {
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    },
    async cacheRestore(): Promise<boolean> {
      return false;
    },
    async cacheSave(): Promise<void> {},
    log(level: string, message: string) {
      logs.push(`[${level}] ${message}`);
    },
  };
}

// ─── Test Tool Helpers ──────────────────────────────────────────

function makeToolDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-tool' as ToolDefinition['name'],
    displayName: 'Test Tool',
    category: 'quality',
    tier: 'always-on',
    version: '1.0.0',
    outputFormat: 'json',
    install: async () => {},
    run: async () => ({ stdout: '[]', stderr: '', exitCode: 0, timedOut: false }),
    parse: () => [],
    ...overrides,
  };
}

function makeActivated(
  overrides: Partial<ToolDefinition> = {},
  reason: ActivatedTool['reason'] = 'always-on',
): ActivatedTool {
  return {
    definition: makeToolDef(overrides),
    reason,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'medium',
    category: 'quality',
    file: 'src/app.ts',
    line: 10,
    message: 'Test finding',
    source: 'semgrep',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runTools', () => {
  let ctx: ExecutionContext & { logs: string[] };

  beforeEach(() => {
    ctx = createMockContext();
  });

  // ── Success path ──

  describe('success path', () => {
    it('runs tools and returns results for each', async () => {
      const findings = [makeFinding({ source: 'semgrep' })];
      const tools = [
        makeActivated({
          name: 'semgrep',
          parse: () => findings,
        }),
        makeActivated({
          name: 'trivy',
          parse: () => [],
        }),
      ];

      const results = await runTools(ctx, tools, '/repo', ['src/app.ts'], 600_000);

      expect(results.semgrep).toBeDefined();
      expect(results.semgrep?.status).toBe('success');
      expect(results.semgrep?.findings).toEqual(findings);

      expect(results.trivy).toBeDefined();
      expect(results.trivy?.status).toBe('success');
      expect(results.trivy?.findings).toEqual([]);
    });

    it('records execution time', async () => {
      const tools = [makeActivated({ name: 'semgrep' })];
      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      expect(results.semgrep?.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Tool crash ──

  describe('failure isolation', () => {
    it('one tool crash does not prevent others from running', async () => {
      const tools = [
        makeActivated({
          name: 'semgrep',
          run: async () => {
            throw new Error('Segmentation fault');
          },
        }),
        makeActivated({
          name: 'trivy',
          parse: () => [makeFinding({ source: 'trivy' })],
        }),
        makeActivated({ name: 'cpd' }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      expect(results.semgrep?.status).toBe('error');
      expect(results.semgrep?.error).toContain('Segmentation fault');
      expect(results.trivy?.status).toBe('success');
      expect(results.trivy?.findings).toHaveLength(1);
      expect(results.cpd?.status).toBe('success');
    });

    it('install failure produces error status but others run', async () => {
      const tools = [
        makeActivated({
          name: 'semgrep',
          install: async () => {
            throw new Error('Network timeout');
          },
        }),
        makeActivated({ name: 'trivy' }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      expect(results.semgrep?.status).toBe('error');
      expect(results.semgrep?.error).toContain('Network timeout');
      expect(results.trivy?.status).toBe('success');
    });
  });

  // ── Timeout ──

  describe('timeout handling', () => {
    it('marks tool as error on timeout', async () => {
      const tools = [
        makeActivated({
          name: 'semgrep',
          run: async () => ({
            stdout: '',
            stderr: '',
            exitCode: -1,
            timedOut: true,
          }),
        }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      expect(results.semgrep?.status).toBe('error');
      expect(results.semgrep?.error).toBe('timeout');
      expect(results.semgrep?.findings).toEqual([]);
    });
  });

  // ── Parse failure ──

  describe('parse failure', () => {
    it('returns success with empty findings when parse throws', async () => {
      const tools = [
        makeActivated({
          name: 'semgrep',
          parse: () => {
            throw new Error('Invalid JSON');
          },
        }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      // Parse error is caught internally — tool still reports "success" because run succeeded
      expect(results.semgrep?.status).toBe('success');
      expect(results.semgrep?.findings).toEqual([]);
    });
  });

  // ── Legacy keys ──

  describe('legacy keys', () => {
    it('ensures semgrep, trivy, cpd keys always present even when not activated', async () => {
      const tools = [
        makeActivated({
          name: 'gitleaks' as ToolDefinition['name'],
          category: 'secrets',
        }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      // gitleaks ran
      expect(results.gitleaks?.status).toBe('success');

      // Legacy keys always present as skipped
      expect(results.semgrep).toBeDefined();
      expect(results.semgrep?.status).toBe('skipped');
      expect(results.trivy).toBeDefined();
      expect(results.trivy?.status).toBe('skipped');
      expect(results.cpd).toBeDefined();
      expect(results.cpd?.status).toBe('skipped');
    });

    it('does not overwrite legacy keys if they already ran', async () => {
      const findings = [makeFinding({ source: 'semgrep' })];
      const tools = [
        makeActivated({
          name: 'semgrep',
          parse: () => findings,
        }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      expect(results.semgrep?.status).toBe('success');
      expect(results.semgrep?.findings).toEqual(findings);
    });
  });

  // ── Total budget exhaustion ──

  describe('total budget exhaustion', () => {
    it('skips remaining tools when total budget is exhausted', async () => {
      // Use a very small budget
      const tools = [
        makeActivated({
          name: 'semgrep',
          run: async () => {
            // Simulate a tool that takes time — use the real clock
            return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
          },
        }),
        makeActivated({ name: 'trivy' }),
        makeActivated({ name: 'cpd' }),
      ];

      // Budget of 0 means everything after first check is exhausted
      const results = await runTools(ctx, tools, '/repo', [], 0);

      // All should be skipped with total-budget-exhausted
      for (const tool of tools) {
        expect(results[tool.definition.name]?.status).toBe('skipped');
        expect(results[tool.definition.name]?.error).toBe('total-budget-exhausted');
      }
    });
  });

  // ── Result aggregation ──

  describe('result aggregation', () => {
    it('aggregates findings from all tools', async () => {
      const tools = [
        makeActivated({
          name: 'semgrep',
          parse: () => [makeFinding({ source: 'semgrep', message: 'Security issue' })],
        }),
        makeActivated({
          name: 'trivy',
          parse: () => [
            makeFinding({ source: 'trivy', message: 'CVE-1' }),
            makeFinding({ source: 'trivy', message: 'CVE-2' }),
          ],
        }),
        makeActivated({ name: 'cpd', parse: () => [] }),
      ];

      const results = await runTools(ctx, tools, '/repo', [], 600_000);

      const totalFindings = Object.values(results).reduce((sum, r) => sum + r.findings.length, 0);
      expect(totalFindings).toBe(3);
    });

    it('logs execution summary', async () => {
      const tools = [makeActivated({ name: 'semgrep' })];
      await runTools(ctx, tools, '/repo', [], 600_000);

      const summaryLog = ctx.logs.find((l) => l.includes('Complete:'));
      expect(summaryLog).toBeDefined();
      expect(summaryLog).toContain('1 tools');
    });
  });

  // ── Empty tool list ──

  describe('edge cases', () => {
    it('handles empty tool list', async () => {
      const results = await runTools(ctx, [], '/repo', [], 600_000);

      // Legacy keys still present
      expect(results.semgrep?.status).toBe('skipped');
      expect(results.trivy?.status).toBe('skipped');
      expect(results.cpd?.status).toBe('skipped');
    });
  });
});
