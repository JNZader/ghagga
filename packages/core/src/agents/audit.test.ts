import { describe, expect, it, vi } from 'vitest';
import type { AuditInput } from '../types.js';
import { runAuditReport } from './audit.js';
import { AUDIT_SYSTEM } from './prompts.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeAuditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    repoPath: '/repo',
    staticContext: 'Found 3 semgrep findings in src/auth.ts',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
    ...overrides,
  };
}

// ─── runAuditReport ─────────────────────────────────────────────

describe('runAuditReport', () => {
  it('returns no-findings when staticContext is empty', async () => {
    const input = makeAuditInput({ staticContext: '' });
    const generateFn = vi.fn();

    const result = await runAuditReport({ ...input, generateFn });

    expect(result.status).toBe('no-findings');
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('returns no-findings when staticContext is whitespace', async () => {
    const input = makeAuditInput({ staticContext: '   \n  ' });
    const generateFn = vi.fn();

    const result = await runAuditReport({ ...input, generateFn });

    expect(result.status).toBe('no-findings');
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('calls generateFn with AUDIT_SYSTEM prompt and staticContext', async () => {
    const context = 'Found 5 vulnerabilities in src/auth.ts';
    const generateFn = vi.fn().mockResolvedValue({
      text: 'audit report here',
      tokensUsed: 100,
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
    });

    const result = await runAuditReport(makeAuditInput({ staticContext: context, generateFn }));

    expect(generateFn).toHaveBeenCalledOnce();
    const [systemArg, userArg] = generateFn.mock.calls[0];
    expect(systemArg).toBe(AUDIT_SYSTEM);
    expect(userArg).toBe(context);
    expect(result.status).toBe('completed');
    expect(result.report).toBe('audit report here');
  });

  it('returns error status when generateFn throws', async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error('rate limit'));

    const result = await runAuditReport(makeAuditInput({ generateFn }));

    expect(result.status).toBe('error');
    expect(result.error).toContain('rate limit');
    expect(result.report).toBe('');
  });

  it('populates timestamp in result', async () => {
    const generateFn = vi.fn().mockResolvedValue({
      text: 'report',
      tokensUsed: 50,
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
    });

    const result = await runAuditReport(makeAuditInput({ generateFn }));

    expect(result.timestamp).toBeTruthy();
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('populates findings in result with StaticAnalysisResult shape', async () => {
    const generateFn = vi.fn().mockResolvedValue({
      text: 'report',
      tokensUsed: 50,
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
    });

    const result = await runAuditReport(makeAuditInput({ generateFn }));

    expect(result.findings).toBeDefined();
    expect(result.findings.semgrep).toBeDefined();
    expect(result.findings.trivy).toBeDefined();
    expect(result.findings.cpd).toBeDefined();
    expect(result.findings.semgrep.status).toBe('skipped');
    expect(result.findings.semgrep.findings).toEqual([]);
  });

  it('uses AUDIT_SYSTEM prompt constant', async () => {
    const generateFn = vi.fn().mockResolvedValue({
      text: 'report',
      tokensUsed: 50,
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
    });

    await runAuditReport(makeAuditInput({ generateFn }));

    const [systemArg] = generateFn.mock.calls[0];
    expect(systemArg).toContain('security and code quality auditor');
    expect(systemArg).toContain('executive report');
    expect(systemArg).toContain('actionable recommendations');
  });
});
