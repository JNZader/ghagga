/**
 * Unit tests for formatReviewComment.
 *
 * Tests the PR comment formatting function in isolation,
 * covering all spec scenarios from the deduplicate-format-review-comment change.
 */

import { describe, expect, it } from 'vitest';
import {
  buildStatsBar,
  categorizeFiles,
  formatFileCategorySummary,
  formatReviewComment,
  SEVERITY_EMOJI,
  STATUS_EMOJI,
} from './format.js';
import type { FindingSeverity, ReviewFinding, ReviewResult } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'All good.',
    findings: [],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 1000,
      executionTimeMs: 2000,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'medium',
    category: 'style',
    file: 'src/index.ts',
    message: 'Test finding',
    source: 'ai',
    ...overrides,
  };
}

// ─── Exported Constants ─────────────────────────────────────────

describe('STATUS_EMOJI', () => {
  it('maps all four ReviewStatus values', () => {
    expect(STATUS_EMOJI.PASSED).toContain('PASSED');
    expect(STATUS_EMOJI.FAILED).toContain('FAILED');
    expect(STATUS_EMOJI.NEEDS_HUMAN_REVIEW).toContain('NEEDS_HUMAN_REVIEW');
    expect(STATUS_EMOJI.SKIPPED).toContain('SKIPPED');
  });
});

describe('SEVERITY_EMOJI', () => {
  it('maps all five severity levels', () => {
    expect(SEVERITY_EMOJI.critical).toBeDefined();
    expect(SEVERITY_EMOJI.high).toBeDefined();
    expect(SEVERITY_EMOJI.medium).toBeDefined();
    expect(SEVERITY_EMOJI.low).toBeDefined();
    expect(SEVERITY_EMOJI.info).toBeDefined();
  });
});

// ─── formatReviewComment ────────────────────────────────────────

describe('formatReviewComment', () => {
  // ── S1: Happy path — findings from all 4 sources ──

  it('renders findings grouped by source in render order (semgrep → trivy → cpd → ai)', () => {
    const result = makeResult({
      status: 'FAILED',
      summary: 'Issues found across all tools.',
      findings: [
        makeFinding({
          severity: 'high',
          category: 'security',
          file: 'src/auth.ts',
          line: 10,
          message: 'SQL injection',
          source: 'semgrep',
        }),
        makeFinding({
          severity: 'medium',
          category: 'vulnerability',
          file: 'Dockerfile',
          line: 5,
          message: 'Outdated base image',
          source: 'trivy',
        }),
        makeFinding({
          severity: 'low',
          category: 'duplication',
          file: 'src/utils.ts',
          line: 20,
          message: 'Code clone detected',
          source: 'cpd',
        }),
        makeFinding({
          severity: 'critical',
          category: 'bug',
          file: 'src/main.ts',
          line: 42,
          message: 'Null dereference',
          source: 'ai',
        }),
      ],
      metadata: {
        mode: 'standard',
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        tokensUsed: 2000,
        executionTimeMs: 5000,
        toolsRun: ['semgrep', 'trivy', 'cpd'],
        toolsSkipped: [],
      },
    });

    const output = formatReviewComment(result);

    // Header
    expect(output).toContain('## 🤖 GHAGGA Code Review');

    // Status
    expect(output).toContain('**Status:** ❌ FAILED');

    // Metadata line
    expect(output).toContain('**Mode:** standard');
    expect(output).toContain('**Model:** claude-sonnet-4-20250514');
    expect(output).toContain('**Time:** 5.0s');

    // Summary
    expect(output).toContain('### Summary\nIssues found across all tools.');

    // Findings count
    expect(output).toContain('### Findings (4)');

    // Source group labels — verify render order
    const semgrepIdx = output.indexOf('Semgrep');
    const trivyIdx = output.indexOf('Trivy');
    const cpdIdx = output.indexOf('CPD');
    const aiIdx = output.indexOf('AI Review');
    expect(semgrepIdx).toBeLessThan(trivyIdx);
    expect(trivyIdx).toBeLessThan(cpdIdx);
    expect(cpdIdx).toBeLessThan(aiIdx);

    // Table headers
    expect(output).toContain('| Severity | Category | File | Message |');
    expect(output).toContain('|----------|----------|------|----------|');

    // Findings content
    expect(output).toContain('src/auth.ts:10');
    expect(output).toContain('SQL injection');
    expect(output).toContain('Dockerfile:5');
    expect(output).toContain('Outdated base image');
    expect(output).toContain('src/utils.ts:20');
    expect(output).toContain('Code clone detected');
    expect(output).toContain('src/main.ts:42');
    expect(output).toContain('Null dereference');

    // Static analysis section
    expect(output).toContain('### Static Analysis');
    expect(output).toContain('✅ Tools run: semgrep, trivy, cpd');

    // Footer
    expect(output).toContain(
      '---\n*Powered by [GHAGGA](https://github.com/JNZader/ghagga) — AI Code Review*',
    );
  });

  // ── S2: Empty findings ──

  it('does not render findings table when there are no findings', () => {
    const result = makeResult({
      status: 'PASSED',
      findings: [],
      metadata: {
        mode: 'simple',
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        tokensUsed: 500,
        executionTimeMs: 1000,
        toolsRun: [],
        toolsSkipped: [],
      },
    });

    const output = formatReviewComment(result);

    expect(output).toContain('✅ PASSED');
    expect(output).not.toContain('### Findings');
    expect(output).not.toContain('| Severity |');
    expect(output).not.toContain('### Static Analysis');
    expect(output).toContain('Powered by');
  });

  // ── S3: Status variants ──

  it.each([
    ['PASSED', '✅ PASSED'],
    ['FAILED', '❌ FAILED'],
    ['NEEDS_HUMAN_REVIEW', '⚠️ NEEDS_HUMAN_REVIEW'],
    ['SKIPPED', '⏭️ SKIPPED'],
  ] as const)('renders status %s as "%s"', (status, expected) => {
    const result = makeResult({ status });
    const output = formatReviewComment(result);
    expect(output).toContain(`**Status:** ${expected}`);
  });

  // ── S4: Pipe and newline escaping ──

  it('escapes pipes and replaces newlines in finding messages', () => {
    const result = makeResult({
      status: 'FAILED',
      findings: [
        makeFinding({
          message: 'Use | instead\nof & operator',
          source: 'ai',
        }),
      ],
    });

    const output = formatReviewComment(result);

    // Pipe should be escaped, newline replaced with space
    expect(output).toContain('Use \\| instead of & operator');
    expect(output).not.toContain('Use | instead');
  });

  // ── Additional: Finding without line number ──

  it('renders file path without line number when line is undefined', () => {
    const result = makeResult({
      status: 'FAILED',
      findings: [
        makeFinding({
          file: 'src/utils.ts',
          line: undefined,
          source: 'semgrep',
        }),
      ],
    });

    const output = formatReviewComment(result);

    // Should have the file path without `:line`
    expect(output).toContain('src/utils.ts');
    expect(output).not.toContain('src/utils.ts:');
  });

  it('renders file path with line number when line is present', () => {
    const result = makeResult({
      status: 'FAILED',
      findings: [
        makeFinding({
          file: 'src/auth.ts',
          line: 42,
          source: 'ai',
        }),
      ],
    });

    const output = formatReviewComment(result);
    expect(output).toContain('src/auth.ts:42');
  });

  // ── Additional: Static analysis with both toolsRun and toolsSkipped ──

  it('renders both tools run and tools skipped in static analysis section', () => {
    const result = makeResult({
      metadata: {
        mode: 'standard',
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        tokensUsed: 1500,
        executionTimeMs: 3000,
        toolsRun: ['semgrep'],
        toolsSkipped: ['trivy', 'cpd'],
      },
    });

    const output = formatReviewComment(result);

    expect(output).toContain('### Static Analysis');
    expect(output).toContain('✅ Tools run: semgrep');
    expect(output).toContain('⏭️ Tools skipped: trivy, cpd');
  });

  // ── Additional: Footer always present ──

  it('always includes the footer', () => {
    // With findings
    const withFindings = formatReviewComment(
      makeResult({
        findings: [makeFinding()],
      }),
    );
    expect(withFindings).toContain('Powered by [GHAGGA]');

    // Without findings
    const withoutFindings = formatReviewComment(makeResult({ findings: [] }));
    expect(withoutFindings).toContain('Powered by [GHAGGA]');
  });

  // ── Additional: Sources not present are silently skipped ──

  it('silently skips sources with no findings', () => {
    const result = makeResult({
      status: 'FAILED',
      findings: [makeFinding({ source: 'semgrep' }), makeFinding({ source: 'ai' })],
    });

    const output = formatReviewComment(result);

    expect(output).toContain('Semgrep');
    expect(output).toContain('AI Review');
    // trivy and cpd should not appear as group headers
    expect(output).not.toContain('Trivy');
    expect(output).not.toContain('CPD');
  });

  // ── Additional: Severity emoji rendering ──

  it('renders severity emoji for each severity level', () => {
    const severities: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
    const findings = severities.map((severity, i) =>
      makeFinding({ severity, file: `src/file${i}.ts`, source: 'ai' }),
    );

    const result = makeResult({ status: 'FAILED', findings });
    const output = formatReviewComment(result);

    // Each severity name should appear
    for (const severity of severities) {
      expect(output).toContain(severity);
    }
    // Each emoji should appear
    expect(output).toContain('🔴'); // critical
    expect(output).toContain('🟠'); // high
    expect(output).toContain('🟡'); // medium
    expect(output).toContain('🟢'); // low
    expect(output).toContain('🟣'); // info
  });

  // ── Edge case: finding with no source defaults to 'ai' ──

  it('groups findings with no source under AI Review', () => {
    const finding = makeFinding({ message: 'No source finding' });
    // Force source to be undefined to test the ?? 'ai' fallback
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    (finding as any).source = undefined;

    const result = makeResult({
      status: 'FAILED',
      findings: [finding],
    });

    const output = formatReviewComment(result);
    expect(output).toContain('AI Review');
    expect(output).toContain('No source finding');
  });

  // ── Enhancement: Idempotent comment marker ──

  it('prepends the idempotent comment marker', () => {
    const result = makeResult();
    const output = formatReviewComment(result);
    expect(output).toMatch(/^<!-- ghagga-review -->/);
  });

  // ── Enhancement: Emoji stats bar ──

  it('renders emoji stats bar when fileStats provided', () => {
    const result = makeResult();
    const output = formatReviewComment(result, {
      fileStats: { additions: 120, deletions: 15 },
    });
    expect(output).toContain('+120 / -15');
    expect(output).toContain('net +105');
    expect(output).toContain('🟩');
    expect(output).toContain('🟥');
  });

  it('skips emoji stats bar when fileStats not provided', () => {
    const result = makeResult();
    const output = formatReviewComment(result);
    expect(output).not.toContain('🟩');
    expect(output).not.toContain('🟥');
  });

  it('skips emoji stats bar when both additions and deletions are 0', () => {
    const result = makeResult();
    const output = formatReviewComment(result, {
      fileStats: { additions: 0, deletions: 0 },
    });
    expect(output).not.toContain('🟩');
    expect(output).not.toContain('🟥');
  });

  // ── Enhancement: File category summary ──

  it('renders categorized file summary when fileList provided', () => {
    const result = makeResult();
    const output = formatReviewComment(result, {
      fileList: [
        'src/routes/users.ts',
        'src/components/UserCard.tsx',
        'src/utils/helpers.ts',
        'src/__tests__/auth.test.ts',
        'tsconfig.json',
      ],
    });
    expect(output).toContain('### Files Changed (5)');
    expect(output).toContain('🧪 **Tests**');
    expect(output).toContain('⚙️ **Config**');
    expect(output).toContain('tsconfig.json');
  });

  it('skips file category summary when fileList not provided', () => {
    const result = makeResult();
    const output = formatReviewComment(result);
    expect(output).not.toContain('### Files Changed');
  });

  // ── Sanitization of LLM-derived content (Sprint 2) ──

  it('mentions the PR author when the login is valid', () => {
    const output = formatReviewComment(makeResult(), { prAuthor: 'octocat' });
    expect(output).toContain('— @octocat');
  });

  it('omits the mention entirely when the login is invalid', () => {
    const output = formatReviewComment(makeResult(), { prAuthor: 'org/everyone' });
    expect(output).not.toContain('@org/everyone');
    expect(output).not.toContain('org/everyone');
  });

  it('neutralizes @-mentions and HTML in the LLM summary', () => {
    const output = formatReviewComment(
      makeResult({
        summary: 'cc @everyone <script>alert(1)</script><!-- hidden instruction -->',
      }),
    );
    expect(output).not.toContain('@everyone');
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('hidden instruction');
  });

  it('truncates an oversized LLM summary', () => {
    const output = formatReviewComment(makeResult({ summary: 'z'.repeat(10_000) }));
    expect(output).not.toContain('z'.repeat(2002));
  });

  it('sanitizes table-breaking content in finding file/category fields', () => {
    const output = formatReviewComment(
      makeResult({
        status: 'FAILED',
        findings: [
          makeFinding({
            file: 'a|b.ts\n| injected | row |',
            category: 'bug | <img src=x>',
            message: 'msg',
            source: 'ai',
          }),
        ],
      }),
    );
    expect(output).not.toContain('| injected | row |');
    expect(output).not.toContain('<img');
  });

  it('shows +N more when category has more than 3 files', () => {
    const result = makeResult();
    const output = formatReviewComment(result, {
      fileList: [
        'src/__tests__/a.test.ts',
        'src/__tests__/b.test.ts',
        'src/__tests__/c.test.ts',
        'src/__tests__/d.test.ts',
        'src/__tests__/e.test.ts',
      ],
    });
    expect(output).toContain('(+2 more)');
  });
});

// ─── buildStatsBar ──────────────────────────────────────────────

describe('buildStatsBar', () => {
  it('returns empty string for zero stats', () => {
    expect(buildStatsBar({ additions: 0, deletions: 0 })).toBe('');
  });

  it('renders all green for additions-only', () => {
    const bar = buildStatsBar({ additions: 100, deletions: 0 });
    expect(bar).toContain('🟩'.repeat(20));
    expect(bar).not.toContain('🟥');
    expect(bar).toContain('+100 / -0');
    expect(bar).toContain('net +100');
  });

  it('renders all red for deletions-only', () => {
    const bar = buildStatsBar({ additions: 0, deletions: 50 });
    expect(bar).toContain('🟥'.repeat(20));
    expect(bar).not.toContain('🟩');
    expect(bar).toContain('+0 / -50');
    expect(bar).toContain('net -50');
  });

  it('renders proportional blocks', () => {
    const bar = buildStatsBar({ additions: 75, deletions: 25 });
    // 75% of 20 = 15 green, 5 red
    const greenCount = (bar.match(/🟩/g) ?? []).length;
    const redCount = (bar.match(/🟥/g) ?? []).length;
    expect(greenCount).toBe(15);
    expect(redCount).toBe(5);
  });
});

// ─── categorizeFiles ────────────────────────────────────────────

describe('categorizeFiles', () => {
  it('categorizes files by pattern', () => {
    const categories = categorizeFiles([
      'src/routes/users.ts',
      'src/components/UserCard.tsx',
      'auth.test.ts',
      'tsconfig.json',
    ]);

    const names = categories.map((c) => c.name);
    expect(names).toContain('Tests');
    expect(names).toContain('Config');
    expect(names).toContain('API');
  });

  it('returns empty array for empty input', () => {
    expect(categorizeFiles([])).toEqual([]);
  });

  it('assigns each file to only one category (first match wins)', () => {
    const categories = categorizeFiles(['src/components/Button.tsx']);
    // Should match UI (components/) before Core (src/)
    const uiCat = categories.find((c) => c.name === 'UI');
    expect(uiCat).toBeDefined();
    expect(uiCat?.files).toContain('src/components/Button.tsx');
    // Should NOT also be in Core
    const coreCat = categories.find((c) => c.name === 'Core');
    expect(coreCat).toBeUndefined();
  });
});

// ─── formatFileCategorySummary ──────────────────────────────────

describe('formatFileCategorySummary', () => {
  it('returns empty string for empty file list', () => {
    expect(formatFileCategorySummary([])).toBe('');
  });

  it('includes file count in header', () => {
    const summary = formatFileCategorySummary(['src/index.ts', 'test.spec.ts']);
    expect(summary).toContain('### Files Changed (2)');
  });

  it('limits display to 3 files per category', () => {
    const summary = formatFileCategorySummary([
      'src/a.test.ts',
      'src/b.test.ts',
      'src/c.test.ts',
      'src/d.test.ts',
    ]);
    expect(summary).toContain('(+1 more)');
  });
});
