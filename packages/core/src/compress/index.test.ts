import { describe, expect, it } from 'vitest';
import { compressStaticAnalysisBlock, compressToolFindings, type ToolFinding } from './index.js';

// ─── Fixtures ────────────────────────────────────────────────────

function makeFinding(
  tool: string,
  file: string,
  message: string,
  severity = 'medium',
  line?: number,
): ToolFinding {
  return { tool, file, message, severity, line };
}

// ─── compressToolFindings ─────────────────────────────────────────

describe('compressToolFindings — deduplication', () => {
  it('removes findings with identical 60-char message prefixes', () => {
    // Dedup keys on the first 60 chars of the message. The first two findings
    // share an identical 60-char prefix and only diverge afterwards, so they
    // collapse to one; the third has a distinct prefix and survives.
    const sharedPrefix = 'no-unused-vars: this rule reports a variable that is never';
    const findings: ToolFinding[] = [
      makeFinding('eslint', 'a.ts', `${sharedPrefix} read — variable 'x'`),
      makeFinding('eslint', 'b.ts', `${sharedPrefix} read — variable 'y'`),
      makeFinding('eslint', 'c.ts', 'no-console: unexpected console statement'),
    ];
    const { findings: out } = compressToolFindings(findings, { deduplicateMessages: true });
    // First two share same 60-char prefix → deduplicated to one
    expect(out.length).toBe(2);
  });

  it('keeps all findings when deduplicateMessages is false', () => {
    const findings: ToolFinding[] = [
      makeFinding('eslint', 'a.ts', "no-unused-vars: variable 'x' is defined but never used"),
      makeFinding('eslint', 'b.ts', "no-unused-vars: variable 'y' is defined but never used"),
    ];
    const { findings: out } = compressToolFindings(findings, { deduplicateMessages: false });
    expect(out.length).toBe(2);
  });
});

describe('compressToolFindings — per-tool cap', () => {
  it('caps at maxPerTool findings per tool', () => {
    const findings: ToolFinding[] = Array.from({ length: 30 }, (_, i) =>
      makeFinding('ruff', 'src/main.py', `unique message #${i} — a very long description`),
    );
    const { findings: out } = compressToolFindings(findings, {
      maxPerTool: 10,
      deduplicateMessages: false,
    });
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it('retains highest severity findings when capping', () => {
    const findings: ToolFinding[] = [
      makeFinding('semgrep', 'a.ts', 'info msg a', 'info'),
      makeFinding('semgrep', 'a.ts', 'critical msg b', 'critical'),
      makeFinding('semgrep', 'a.ts', 'high msg c', 'high'),
    ];
    const { findings: out } = compressToolFindings(findings, {
      maxPerTool: 1,
      deduplicateMessages: false,
      maxPerFile: 10,
    });
    // Only one finding per tool. Severity: critical=0 wins.
    expect(out[0]?.severity).toBe('critical');
  });
});

describe('compressToolFindings — per-file cap', () => {
  it('caps findings per file to maxPerFile', () => {
    const findings: ToolFinding[] = Array.from({ length: 20 }, (_, i) =>
      makeFinding('ruff', 'heavy-file.py', `issue #${i} — unique text here`),
    );
    const { findings: out } = compressToolFindings(findings, {
      maxPerFile: 3,
      deduplicateMessages: false,
    });
    const inFile = out.filter((f) => f.file === 'heavy-file.py');
    expect(inFile.length).toBeLessThanOrEqual(3);
  });
});

describe('compressToolFindings — token budget', () => {
  it('truncates output to fit token budget', () => {
    // Each finding is ~100 chars. 100 findings * 100 chars = 10 000 chars ≈ 2500 tokens
    const findings: ToolFinding[] = Array.from({ length: 100 }, (_, i) =>
      makeFinding(
        'lint',
        `file${i}.ts`,
        `This is a unique and rather long message number ${i} that consumes tokens`,
      ),
    );
    const { findings: out } = compressToolFindings(findings, {
      maxPerFile: 10,
      maxPerTool: 100,
      deduplicateMessages: false,
      maxTotalTokens: 50, // very small budget
    });
    expect(out.length).toBeLessThan(100);
  });
});

describe('compressToolFindings — stats', () => {
  it('returns droppedCount equal to original minus compressed', () => {
    const findings: ToolFinding[] = Array.from({ length: 10 }, (_, i) =>
      makeFinding('tool', 'f.ts', `unique msg ${i}`),
    );
    const { findings: out, stats } = compressToolFindings(findings, {
      maxPerTool: 5,
      deduplicateMessages: false,
    });
    expect(stats.droppedCount).toBe(10 - out.length);
  });

  it('reductionPercent is 0 when nothing was compressed', () => {
    const { stats } = compressToolFindings([], {});
    expect(stats.reductionPercent).toBe(0);
    expect(stats.droppedCount).toBe(0);
  });
});

// ─── compressStaticAnalysisBlock ──────────────────────────────────

describe('compressStaticAnalysisBlock — similar line collapsing', () => {
  it('collapses consecutive lines differing only by number', () => {
    // Lines that are identical once line numbers are normalized away collapse
    // into one canonical line plus a "... and N similar issue(s)" marker.
    // (The fixture must differ ONLY by numbers — letters survive normalization.)
    const raw = [
      'src/foo.ts:10: maximum line length exceeded',
      'src/foo.ts:20: maximum line length exceeded',
      'src/foo.ts:30: maximum line length exceeded',
      'src/bar.ts:5: missing semicolon',
    ].join('\n');

    const { compressed } = compressStaticAnalysisBlock(raw);
    expect(compressed).toContain('... and 2 similar issue(s)');
    expect(compressed).toContain('src/bar.ts');
  });

  it('does not collapse structurally different lines', () => {
    const raw = ['src/a.ts:1: error A', 'src/b.ts:2: warning B', 'src/c.ts:3: note C'].join('\n');

    const { compressed } = compressStaticAnalysisBlock(raw);
    // All different — no collapsing
    expect(compressed).not.toContain('similar issue');
    expect(compressed.split('\n').length).toBe(3);
  });

  it('returns reduction stats', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `src/x.ts:${i}: same message here`).join('\n');
    const result = compressStaticAnalysisBlock(raw);
    expect(result.reductionPercent).toBeGreaterThan(0);
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});

describe('compressStaticAnalysisBlock — token budget', () => {
  it('truncates output when over maxTokens', () => {
    const raw = Array.from({ length: 1000 }, (_, i) => `line ${i}: some analysis output`).join(
      '\n',
    );
    const { compressed } = compressStaticAnalysisBlock(raw, 10);
    expect(compressed.length).toBeLessThan(raw.length);
    expect(compressed).toContain('[... output truncated');
  });

  it('does not truncate when within budget', () => {
    const raw = 'one line only';
    const { compressed } = compressStaticAnalysisBlock(raw, 4000);
    expect(compressed).toBe(raw);
  });
});

describe('compressStaticAnalysisBlock — edge cases', () => {
  it('handles empty string', () => {
    const result = compressStaticAnalysisBlock('');
    expect(result.reductionPercent).toBe(0);
    expect(result.droppedCount).toBeLessThanOrEqual(0);
  });

  it('preserves original field unchanged', () => {
    const raw = 'src/a.ts:1: error';
    const result = compressStaticAnalysisBlock(raw);
    expect(result.original).toBe(raw);
  });
});
