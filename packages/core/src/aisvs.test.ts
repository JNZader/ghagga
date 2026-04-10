import { describe, expect, it } from 'vitest';
import { AISVS_CHECKS, buildAISVSReport, formatAISVSReport, scanContentForAISVS } from './aisvs.js';

describe('AISVS_CHECKS', () => {
  it('has at least 10 checks', () => {
    expect(AISVS_CHECKS.length).toBeGreaterThanOrEqual(10);
  });

  it('every check has required fields', () => {
    for (const c of AISVS_CHECKS) {
      expect(c.id).toBeTruthy();
      expect(c.category).toBeTruthy();
      expect(c.severity).toBeTruthy();
      expect(c.pattern).toBeInstanceOf(RegExp);
      expect(c.recommendation).toBeTruthy();
    }
  });

  it('covers all categories', () => {
    const cats = new Set(AISVS_CHECKS.map((c) => c.category));
    expect(cats).toContain('prompt-injection');
    expect(cats).toContain('output-validation');
    expect(cats).toContain('mcp-security');
    expect(cats).toContain('agentic-action');
  });
});

describe('scanContentForAISVS', () => {
  it('detects user input in system prompt', () => {
    const code = 'const systemPrompt = `You are helpful. User said: ${req.body.message}`';
    const findings = scanContentForAISVS(code, 'api.ts');
    expect(findings.some((f) => f.category === 'prompt-injection')).toBe(true);
  });

  it('detects eval with LLM output', () => {
    const code = 'eval(result.text)';
    const findings = scanContentForAISVS(code, 'handler.ts');
    expect(findings.some((f) => f.checkId === 'AISVS-12.1')).toBe(true);
  });

  it('detects dangerouslySetInnerHTML with generated content', () => {
    const code = 'dangerouslySetInnerHTML={{ __html: response.generated }}';
    const findings = scanContentForAISVS(code, 'component.tsx');
    expect(findings.some((f) => f.checkId === 'AISVS-12.2')).toBe(true);
  });

  it('detects MCP tool with shell execution', () => {
    const code = "const tool = { handler: async () => exec('ls -la') }";
    const findings = scanContentForAISVS(code, 'mcp-server.ts');
    expect(findings.some((f) => f.category === 'mcp-security')).toBe(true);
  });

  it('does NOT flag normal query/result usage', () => {
    const code = [
      "const result = await query('SELECT 1');",
      'const findings = results.filter(f => f.severity);',
      'expect(result).toBeDefined();',
      "const executed = toolsRun.includes('semgrep');",
    ].join('\n');
    const findings = scanContentForAISVS(code, 'normal.ts');
    expect(findings.filter((f) => f.checkId === 'AISVS-12.3')).toHaveLength(0);
  });

  it('detects API key in prompt context', () => {
    const code = 'const prompt = `System context: api_key = ${process.env.KEY}`';
    const findings = scanContentForAISVS(code, 'llm.ts');
    expect(findings.some((f) => f.category === 'credential-handling')).toBe(true);
  });

  it('returns empty for clean code', () => {
    const code = [
      'const x = "hello";',
      'function add(a: number, b: number) { return a + b; }',
      'export default add;',
    ].join('\n');
    const findings = scanContentForAISVS(code, 'clean.ts');
    expect(findings).toHaveLength(0);
  });

  it('reports correct line numbers', () => {
    const code = 'line1\nline2\neval(result.text)\nline4';
    const findings = scanContentForAISVS(code, 'test.ts');
    const evalFinding = findings.find((f) => f.checkId === 'AISVS-12.1');
    expect(evalFinding?.line).toBe(3);
  });

  it('truncates long match strings', () => {
    const longLine = `eval(${'x'.repeat(200)})`;
    const findings = scanContentForAISVS(longLine, 'test.ts');
    if (findings.length > 0) {
      expect(findings[0]?.match.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('buildAISVSReport', () => {
  it('calculates pass rate', () => {
    const findings = scanContentForAISVS('eval(result.text)', 't.ts');
    const report = buildAISVSReport(findings, 1);
    expect(report.passRate).toBeGreaterThan(0);
    expect(report.passRate).toBeLessThan(100);
    expect(report.checksRun).toBe(AISVS_CHECKS.length);
  });

  it('100% pass rate for clean code', () => {
    const report = buildAISVSReport([], 5);
    expect(report.passRate).toBe(100);
  });
});

describe('formatAISVSReport', () => {
  it('shows all clear for no findings', () => {
    const report = buildAISVSReport([], 10);
    const text = formatAISVSReport(report);
    expect(text).toContain('No AISVS violations');
    expect(text).toContain('100%');
  });

  it('groups findings by category', () => {
    const findings = [
      ...scanContentForAISVS('eval(result.text)', 'a.ts'),
      ...scanContentForAISVS('const systemPrompt = `User: ${req.body.message}`', 'b.ts'),
    ];
    const report = buildAISVSReport(findings, 2);
    const text = formatAISVSReport(report);
    expect(text).toContain('AISVS Security Report');
    expect(text).toContain('output-validation');
  });

  it('includes recommendations', () => {
    const findings = scanContentForAISVS('eval(result.text)', 't.ts');
    const report = buildAISVSReport(findings, 1);
    const text = formatAISVSReport(report);
    expect(text).toContain('Never execute LLM output');
  });
});
