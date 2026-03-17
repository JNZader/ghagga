import { describe, expect, it } from 'vitest';
import type { ReviewFinding, StaticAnalysisResult } from '../types.js';
import {
  buildProgressiveContext,
  chooseContextLevel,
  collectAllFindings,
  collectToolNames,
  estimateTokens,
  formatMemoryContextL0,
  formatMemoryContextL1,
  formatStaticContextL0,
  formatStaticContextL1,
} from './context-levels.js';

// ─── Helpers ────────────────────────────────────────────────────

function emptyToolResult() {
  return { status: 'success' as const, findings: [] as ReviewFinding[], executionTimeMs: 0 };
}

function skippedToolResult() {
  return { status: 'skipped' as const, findings: [] as ReviewFinding[], executionTimeMs: 0 };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'medium',
    category: 'security',
    file: 'src/index.ts',
    line: 10,
    message: 'Potential issue found',
    source: 'semgrep',
    ...overrides,
  };
}

function makeStaticResult(findings: ReviewFinding[] = []): StaticAnalysisResult {
  return {
    semgrep: { status: 'success', findings, executionTimeMs: 100 },
    trivy: emptyToolResult(),
    cpd: emptyToolResult(),
  };
}

/** Sample memory context matching the formatMemoryContext() output format. */
const SAMPLE_MEMORY = `## Past Review Memory

The following observations were learned from previous reviews of this project:

### [DECISION] Switched from sessions to JWT

**What**: Replaced express-session with JWT
**Why**: Sessions don't scale

### [BUGFIX] Fixed N+1 in user list

**What**: Added eager loading for user associations
**Why**: Performance regression in user list endpoint

### [PATTERN] Always validate webhook signatures

**What**: All webhook handlers must verify HMAC signatures
**Why**: Prevent replay attacks

> Use these past observations to give more informed, context-aware reviews.
> Do not repeat findings that match these known patterns unless the issue persists.`;

// ─── estimateTokens ─────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates 1 token for 1-4 chars', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('estimates 2 tokens for 5-8 chars', () => {
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up fractional tokens', () => {
    expect(estimateTokens('a')).toBe(1); // 1/4 = 0.25 → ceil = 1
  });
});

// ─── chooseContextLevel ─────────────────────────────────────────

describe('chooseContextLevel', () => {
  it('returns L2 when full context fits within budget', () => {
    expect(chooseContextLevel(500, 400)).toBe('L2');
  });

  it('returns L2 when full context exactly equals budget', () => {
    expect(chooseContextLevel(500, 500)).toBe('L2');
  });

  it('returns L1 when full context exceeds budget but budget >= 150', () => {
    expect(chooseContextLevel(200, 1000)).toBe('L1');
    expect(chooseContextLevel(150, 300)).toBe('L1');
  });

  it('returns L0 when budget is below 150 tokens', () => {
    expect(chooseContextLevel(100, 500)).toBe('L0');
    expect(chooseContextLevel(50, 200)).toBe('L0');
  });

  it('returns L0 when budget is 0', () => {
    expect(chooseContextLevel(0, 100)).toBe('L0');
  });

  it('returns L2 when estimatedFullTokens is 0 (no context)', () => {
    expect(chooseContextLevel(500, 0)).toBe('L2');
  });

  it('handles the boundary at exactly 150 tokens budget', () => {
    // Budget = 150, full = 200 → can't fit L2, but budget >= 150 → L1
    expect(chooseContextLevel(150, 200)).toBe('L1');
  });

  it('handles boundary at 149 tokens budget', () => {
    // Budget = 149, full = 200 → L0
    expect(chooseContextLevel(149, 200)).toBe('L0');
  });
});

// ─── formatStaticContextL0 ──────────────────────────────────────

describe('formatStaticContextL0', () => {
  it('returns no-findings message when findings array is empty', () => {
    const result = formatStaticContextL0([], ['semgrep', 'trivy']);
    expect(result).toBe('Static analysis (semgrep, trivy): no findings');
  });

  it('returns summary with severity counts', () => {
    const findings = [
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'medium' }),
    ];
    const result = formatStaticContextL0(findings, ['semgrep']);
    expect(result).toBe('Static analysis (semgrep): 3 finding(s) (2 high, 1 medium)');
  });

  it('includes all severity levels in order', () => {
    const findings = [
      makeFinding({ severity: 'info' }),
      makeFinding({ severity: 'critical' }),
      makeFinding({ severity: 'low' }),
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'medium' }),
    ];
    const result = formatStaticContextL0(findings, ['semgrep']);
    expect(result).toContain('1 critical, 1 high, 1 medium, 1 low, 1 info');
  });

  it('works with empty tool names array', () => {
    const findings = [makeFinding({ severity: 'medium' })];
    const result = formatStaticContextL0(findings, []);
    expect(result).toBe('Static analysis: 1 finding(s) (1 medium)');
  });

  it('produces a short string (under ~50 tokens)', () => {
    const findings = [
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'medium' }),
      makeFinding({ severity: 'medium' }),
    ];
    const result = formatStaticContextL0(findings, ['semgrep', 'trivy']);
    // ~50 tokens = ~200 chars
    expect(result.length).toBeLessThan(200);
  });
});

// ─── formatStaticContextL1 ──────────────────────────────────────

describe('formatStaticContextL1', () => {
  it('returns empty string when no findings', () => {
    expect(formatStaticContextL1([])).toBe('');
  });

  it('formats findings as bullet list with severity, location, message, and source', () => {
    const findings = [
      makeFinding({
        severity: 'high',
        file: 'auth.ts',
        line: 45,
        message: 'SQL injection',
        source: 'semgrep',
      }),
    ];
    const result = formatStaticContextL1(findings);
    expect(result).toContain('## Static Analysis Summary');
    expect(result).toContain('- [high] auth.ts:45 — SQL injection (semgrep)');
  });

  it('sorts findings by severity (most severe first)', () => {
    const findings = [
      makeFinding({ severity: 'low', message: 'low issue' }),
      makeFinding({ severity: 'critical', message: 'critical issue' }),
      makeFinding({ severity: 'medium', message: 'medium issue' }),
    ];
    const result = formatStaticContextL1(findings);
    const lines = result.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('[critical]');
    expect(lines[1]).toContain('[medium]');
    expect(lines[2]).toContain('[low]');
  });

  it('caps at 15 findings with overflow message', () => {
    const findings = Array.from({ length: 20 }, (_, i) =>
      makeFinding({ message: `issue ${i}`, severity: 'medium' }),
    );
    const result = formatStaticContextL1(findings);
    const bulletLines = result.split('\n').filter((l) => l.startsWith('- '));
    // 15 findings + 1 overflow message
    expect(bulletLines.length).toBe(16);
    expect(result).toContain('... and 5 more');
  });

  it('handles findings without line numbers', () => {
    const findings = [makeFinding({ file: 'Dockerfile', line: undefined, message: 'No line' })];
    const result = formatStaticContextL1(findings);
    expect(result).toContain('- [medium] Dockerfile — No line (semgrep)');
  });

  it('does not include overflow message when exactly 15 findings', () => {
    const findings = Array.from({ length: 15 }, (_, i) => makeFinding({ message: `issue ${i}` }));
    const result = formatStaticContextL1(findings);
    expect(result).not.toContain('... and');
  });
});

// ─── formatMemoryContextL0 ──────────────────────────────────────

describe('formatMemoryContextL0', () => {
  it('returns empty string for null memory', () => {
    expect(formatMemoryContextL0(null)).toBe('');
  });

  it('returns empty string for memory with no observation headers', () => {
    expect(formatMemoryContextL0('Some random text without observation headers')).toBe('');
  });

  it('counts observations and returns summary', () => {
    const result = formatMemoryContextL0(SAMPLE_MEMORY);
    expect(result).toBe('Memory: 3 past observation(s) about this codebase available');
  });

  it('produces a short string (under ~50 tokens)', () => {
    const result = formatMemoryContextL0(SAMPLE_MEMORY);
    expect(result.length).toBeLessThan(200);
  });
});

// ─── formatMemoryContextL1 ──────────────────────────────────────

describe('formatMemoryContextL1', () => {
  it('returns empty string for null memory', () => {
    expect(formatMemoryContextL1(null)).toBe('');
  });

  it('returns empty string for memory with no observation headers', () => {
    expect(formatMemoryContextL1('Some random text')).toBe('');
  });

  it('extracts observation titles as bullet list', () => {
    const result = formatMemoryContextL1(SAMPLE_MEMORY);
    expect(result).toContain('## Past Review Memory (summary)');
    expect(result).toContain('- [DECISION] Switched from sessions to JWT');
    expect(result).toContain('- [BUGFIX] Fixed N+1 in user list');
    expect(result).toContain('- [PATTERN] Always validate webhook signatures');
  });

  it('does not include observation content', () => {
    const result = formatMemoryContextL1(SAMPLE_MEMORY);
    expect(result).not.toContain('Replaced express-session');
    expect(result).not.toContain('eager loading');
  });
});

// ─── collectAllFindings ─────────────────────────────────────────

describe('collectAllFindings', () => {
  it('returns empty array when all tools have no findings', () => {
    const result: StaticAnalysisResult = {
      semgrep: emptyToolResult(),
      trivy: emptyToolResult(),
      cpd: emptyToolResult(),
    };
    expect(collectAllFindings(result)).toEqual([]);
  });

  it('collects findings from multiple tools', () => {
    const f1 = makeFinding({ source: 'semgrep' });
    const f2 = makeFinding({ source: 'trivy' });
    const result: StaticAnalysisResult = {
      semgrep: { ...emptyToolResult(), findings: [f1] },
      trivy: { ...emptyToolResult(), findings: [f2] },
      cpd: emptyToolResult(),
    };
    expect(collectAllFindings(result)).toEqual([f1, f2]);
  });
});

// ─── collectToolNames ───────────────────────────────────────────

describe('collectToolNames', () => {
  it('returns only tools with success status', () => {
    const result: StaticAnalysisResult = {
      semgrep: { status: 'success', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'error', findings: [], executionTimeMs: 0 },
    };
    expect(collectToolNames(result)).toEqual(['semgrep']);
  });

  it('returns empty array when no tools succeeded', () => {
    const result: StaticAnalysisResult = {
      semgrep: skippedToolResult(),
      trivy: skippedToolResult(),
      cpd: skippedToolResult(),
    };
    expect(collectToolNames(result)).toEqual([]);
  });
});

// ─── buildProgressiveContext ─────────────────────────────────────

describe('buildProgressiveContext', () => {
  it('returns L2 for everything when budget is large', () => {
    const fullStaticContext = '## Pre-Review Static Analysis\n- [SEMGREP] medium issue';
    const result = buildProgressiveContext({
      staticResult: makeStaticResult([makeFinding()]),
      memoryContext: SAMPLE_MEMORY,
      stackHints: '',
      contextBudget: 10_000,
      fullStaticContext,
    });

    expect(result.staticLevel).toBe('L2');
    expect(result.memoryLevel).toBe('L2');
    expect(result.staticContext).toBe(fullStaticContext);
    expect(result.memoryContext).toBe(SAMPLE_MEMORY);
  });

  it('degrades to L1/L0 when budget is tight', () => {
    // Create a large full context (~2000 tokens = ~8000 chars)
    const bigStaticContext = 'x'.repeat(8000);
    const result = buildProgressiveContext({
      staticResult: makeStaticResult([makeFinding({ severity: 'high', message: 'SQL injection' })]),
      memoryContext: SAMPLE_MEMORY,
      stackHints: '',
      contextBudget: 300, // tight budget
      fullStaticContext: bigStaticContext,
    });

    // Full static is ~2000 tokens, budget is 300 → can't fit L2
    // 300 * 0.6 = 180 for static (>= 150) → L1
    expect(result.staticLevel).toBe('L1');
    // 300 * 0.4 = 120 for memory → memory full is ~200 tokens → L0
    expect(result.memoryLevel).toBe('L0');
  });

  it('returns L0 for both when budget is extremely tight', () => {
    const bigStaticContext = 'x'.repeat(4000);
    const result = buildProgressiveContext({
      staticResult: makeStaticResult([makeFinding()]),
      memoryContext: SAMPLE_MEMORY,
      stackHints: '',
      contextBudget: 100, // very tight
      fullStaticContext: bigStaticContext,
    });

    // 100 * 0.6 = 60 for static (< 150) → L0
    expect(result.staticLevel).toBe('L0');
    // 100 * 0.4 = 40 for memory → L0
    expect(result.memoryLevel).toBe('L0');
  });

  it('passes stack hints through unchanged', () => {
    const hints = '\n\n## Stack-Specific Review Hints\n\n- Check error handling patterns.\n';
    const result = buildProgressiveContext({
      staticResult: makeStaticResult(),
      memoryContext: null,
      stackHints: hints,
      contextBudget: 10_000,
      fullStaticContext: '',
    });
    expect(result.stackHints).toBe(hints);
  });

  it('handles null memory context', () => {
    const result = buildProgressiveContext({
      staticResult: makeStaticResult(),
      memoryContext: null,
      stackHints: '',
      contextBudget: 10_000,
      fullStaticContext: '',
    });
    expect(result.memoryContext).toBeNull();
    expect(result.memoryLevel).toBe('L2');
  });

  it('handles empty static context (no findings)', () => {
    const result = buildProgressiveContext({
      staticResult: makeStaticResult(),
      memoryContext: null,
      stackHints: '',
      contextBudget: 100,
      fullStaticContext: '',
    });
    expect(result.staticLevel).toBe('L2'); // empty fits in any budget
    expect(result.staticContext).toBe('');
  });

  it('accounts for stack hint tokens in remaining budget', () => {
    // Stack hints take ~50 tokens → reduces remaining budget
    const longHints = 'x'.repeat(200); // ~50 tokens
    const bigStaticContext = 'x'.repeat(4000); // ~1000 tokens

    const withHints = buildProgressiveContext({
      staticResult: makeStaticResult([makeFinding()]),
      memoryContext: null,
      stackHints: longHints,
      contextBudget: 200,
      fullStaticContext: bigStaticContext,
    });

    const withoutHints = buildProgressiveContext({
      staticResult: makeStaticResult([makeFinding()]),
      memoryContext: null,
      stackHints: '',
      contextBudget: 200,
      fullStaticContext: bigStaticContext,
    });

    // With hints, remaining budget is 200 - 50 = 150, static gets 90 → L0
    // Without hints, remaining budget is 200, static gets 120 → L0
    // Both should be L0 here, but the budget available differs
    expect(withHints.staticLevel).toBe('L0');
  });

  it('L1 static context is shorter than L2', () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({
        severity: 'medium',
        file: `src/file${i}.ts`,
        line: i * 10,
        message: `Issue number ${i} with a fairly descriptive message`,
        source: 'semgrep',
      }),
    );

    // Build a large L2 context
    const lines = ['## Pre-Review Static Analysis', ''];
    for (const f of findings) {
      lines.push(
        `- **[${f.source.toUpperCase()}]** [${f.severity}] ${f.file}:${f.line}: ${f.message}`,
      );
    }
    lines.push('', '> These issues were detected by automated tools.');
    const fullStaticContext = lines.join('\n');

    // Budget must give static at least 150 tokens (L1 threshold).
    // With 0.6 ratio: 300 * 0.6 = 180 >= 150 → L1.
    // Full context is ~183 tokens → exceeds 180 → can't fit L2 → L1.
    const result = buildProgressiveContext({
      staticResult: {
        semgrep: { status: 'success', findings, executionTimeMs: 100 },
        trivy: emptyToolResult(),
        cpd: emptyToolResult(),
      },
      memoryContext: null,
      stackHints: '',
      contextBudget: 300, // gives 180 to static (>= 150 threshold)
      fullStaticContext,
    });

    expect(result.staticLevel).toBe('L1');
    expect(result.staticContext.length).toBeLessThan(fullStaticContext.length);
  });

  it('L0 static context is shorter than L1', () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({ severity: 'medium', message: `Issue ${i}` }),
    );

    const l0 = formatStaticContextL0(findings, ['semgrep']);
    const l1 = formatStaticContextL1(findings);

    expect(l0.length).toBeLessThan(l1.length);
  });
});
