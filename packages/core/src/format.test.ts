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
  formatSemanticDiffSection,
  SEVERITY_EMOJI,
  STATUS_EMOJI,
} from './format.js';
import {
  type EntityChange,
  extractSemanticDiff,
  type SemanticDiff,
} from './semantic-diff/index.js';
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

  // ── S1b: Tool names are sanitized (untrusted runner-callback payload) ──

  it('sanitizes malicious tool names before joining into the Static Analysis line', () => {
    const result = makeResult({
      status: 'PASSED',
      findings: [],
      metadata: {
        mode: 'simple',
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        tokensUsed: 500,
        executionTimeMs: 1000,
        // Attacker-influenceable names: an HTML-comment injection and an
        // @-mention that would otherwise notify an org/user.
        toolsRun: ['evil<!--hidden-->', '@org'],
        toolsSkipped: ['<script>alert(1)</script>'],
      },
    });

    const output = formatReviewComment(result);

    // Isolate the Static Analysis section so the idempotent marker comment at
    // the top of the document doesn't pollute the assertions.
    const staticSection = output.slice(output.indexOf('### Static Analysis'));

    // The injected HTML comment payload is stripped from the tool name.
    expect(staticSection).not.toContain('<!--');
    expect(staticSection).not.toContain('hidden');
    // '<' is escaped so a <script> tool name cannot open an HTML tag.
    expect(staticSection).not.toContain('<script>');
    expect(staticSection).toContain('&lt;script>');
    // The inert prefix of the comment-injection name survives.
    expect(staticSection).toContain('evil');
    // '@org' is neutralized: a literal "@org" (no zero-width char) must NOT appear.
    expect(staticSection).not.toMatch(/@org\b/);
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

// ─── formatSemanticDiffSection ──────────────────────────────────

function makeChange(overrides: Partial<EntityChange> = {}): EntityChange {
  return {
    kind: 'function_added',
    name: 'foo',
    filePath: 'src/foo.ts',
    ...overrides,
  };
}

function makeSemanticDiff(changes: EntityChange[]): SemanticDiff {
  return { changes, summary: 'test summary' };
}

describe('formatSemanticDiffSection', () => {
  it('returns "" for undefined semanticDiff (silent degradation)', () => {
    expect(formatSemanticDiffSection(undefined)).toBe('');
  });

  it('returns "" for an empty changes array', () => {
    expect(formatSemanticDiffSection(makeSemanticDiff([]))).toBe('');
  });

  it('renders a collapsed <details> with surviving entities grouped by file', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'function_added', name: 'formatSemanticDiffSection' }),
        makeChange({ kind: 'function_modified', name: 'formatReviewComment' }),
        makeChange({ kind: 'type_added', name: 'SemanticDiffMeta', filePath: 'src/types.ts' }),
      ]),
    );
    expect(section).toContain('<details>');
    expect(section).toContain('</details>');
    expect(section).toContain('🧬 What changed (3 entities)');
    expect(section).toContain('**foo.ts**');
    expect(section).toContain('**types.ts**');
    expect(section).toContain('➕ function `formatSemanticDiffSection`');
    expect(section).toContain('✏️ function `formatReviewComment`');
    expect(section).toContain('➕ type `SemanticDiffMeta`');
  });

  // ── R-filtros: drop method kind entirely ──

  it('drops ALL method-kind entries (it()/expect() noise)', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'method_added', name: 'itMethod', filePath: 'src/x.test.ts' }),
        makeChange({ kind: 'method_modified', name: 'expectMethod', filePath: 'src/x.test.ts' }),
        makeChange({ kind: 'function_added', name: 'realFn' }),
      ]),
    );
    // No method name renders as a bullet.
    expect(section).not.toContain('`itMethod`');
    expect(section).not.toContain('`expectMethod`');
    // No "method" noun label appears at all.
    expect(section).not.toContain('method `');
    expect(section).toContain('`realFn`');
    // method entries do NOT inflate the entity count
    expect(section).toContain('(1 entity)');
  });

  // ── R-filtros: extension gate ──

  it('gates out entities from non-TS/JS files (.md, .py, .go)', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'function_added', name: 'pyFunc', filePath: 'src/script.py' }),
        makeChange({ kind: 'function_added', name: 'goFunc', filePath: 'pkg/main.go' }),
        makeChange({ kind: 'type_added', name: 'mdHeading', filePath: 'README.md' }),
        makeChange({ kind: 'function_added', name: 'tsFunc', filePath: 'src/real.ts' }),
      ]),
    );
    expect(section).not.toContain('pyFunc');
    expect(section).not.toContain('goFunc');
    expect(section).not.toContain('mdHeading');
    expect(section).toContain('tsFunc');
    expect(section).toContain('(1 entity)');
  });

  it('accepts all TS/JS extensions (.ts/.tsx/.js/.jsx/.mjs/.cjs) and drops the unknown pseudo-path', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'function_added', name: 'tsFn', filePath: 'a.ts' }),
        makeChange({ kind: 'function_added', name: 'tsxFn', filePath: 'a.tsx' }),
        makeChange({ kind: 'function_added', name: 'jsFn', filePath: 'a.js' }),
        makeChange({ kind: 'function_added', name: 'jsxFn', filePath: 'a.jsx' }),
        makeChange({ kind: 'function_added', name: 'mjsFn', filePath: 'a.mjs' }),
        makeChange({ kind: 'function_added', name: 'cjsFn', filePath: 'a.cjs' }),
        makeChange({ kind: 'function_added', name: 'ghostFn', filePath: 'unknown' }),
      ]),
    );
    for (const name of ['tsFn', 'tsxFn', 'jsFn', 'jsxFn', 'mjsFn', 'cjsFn']) {
      expect(section).toContain(name);
    }
    expect(section).not.toContain('ghostFn');
    expect(section).toContain('(6 entities)');
  });

  // ── R-filtros: imports as counts only ──

  it('renders imports as aggregate counts on one line, without module names', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'function_added', name: 'realFn' }),
        makeChange({ kind: 'import_added', name: 'react', filePath: 'src/a.ts' }),
        makeChange({ kind: 'import_added', name: 'lodash', filePath: 'src/a.ts' }),
        makeChange({ kind: 'import_removed', name: 'old-dep', filePath: 'src/a.ts' }),
        makeChange({ kind: 'import_modified', name: 'zod', filePath: 'src/a.ts' }),
      ]),
    );
    expect(section).toContain('**Imports:** 2 added · 1 removed · 1 modified');
    // module names MUST NOT leak
    expect(section).not.toContain('react');
    expect(section).not.toContain('lodash');
    expect(section).not.toContain('old-dep');
    expect(section).not.toContain('zod');
    // import changes are surfaced in the summary line too
    expect(section).toContain('1 entity · 4 import changes');
  });

  // ── R-render guard: imports-only → no section ──

  it('returns "" when only imports survive (imports-only diff → no section)', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'import_added', name: 'react', filePath: 'src/a.ts' }),
        makeChange({ kind: 'import_removed', name: 'old', filePath: 'src/a.ts' }),
      ]),
    );
    expect(section).toBe('');
  });

  it('returns "" when all entities are filtered out (method + non-TS)', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'method_added', name: 'it', filePath: 'src/x.test.ts' }),
        makeChange({ kind: 'function_added', name: 'pyFn', filePath: 'a.py' }),
      ]),
    );
    expect(section).toBe('');
  });

  // ── R-filtros: cap + "+N more" ──

  it('caps visible entries at 10 and shows a "+N more" indicator (PR #221 giant class)', () => {
    const changes: EntityChange[] = [];
    for (let i = 0; i < 250; i++) {
      changes.push(makeChange({ kind: 'function_added', name: `fn${i}`, filePath: 'src/big.ts' }));
    }
    const section = formatSemanticDiffSection(makeSemanticDiff(changes));
    // Exactly 10 entity bullet lines rendered.
    const bulletLines = section.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines).toHaveLength(10);
    expect(section).toContain('_+240 more entities_');
    // Summary still reflects the FULL surviving count (honest count).
    expect(section).toContain('(250 entities)');
  });

  it('does not show "+N more" when entities fit within the cap', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({ kind: 'function_added', name: 'a' }),
        makeChange({ kind: 'function_added', name: 'b' }),
      ]),
    );
    expect(section).not.toContain('more entities');
  });

  it('does not emit a dangling file header when the cap is hit at a file boundary', () => {
    // 10 entities fill fileA.ts exactly to the cap; fileB.ts must NOT get a
    // header (it would have zero bullets under it).
    const changes: EntityChange[] = [];
    for (let i = 0; i < 10; i++) {
      changes.push(makeChange({ kind: 'function_added', name: `a${i}`, filePath: 'src/fileA.ts' }));
    }
    changes.push(makeChange({ kind: 'function_added', name: 'b0', filePath: 'src/fileB.ts' }));
    const section = formatSemanticDiffSection(makeSemanticDiff(changes));
    expect(section).toContain('**fileA.ts**');
    expect(section).not.toContain('**fileB.ts**');
    expect(section).toContain('_+1 more entity_');
    // Every '- ' bullet line is immediately preceded by content (no header with
    // zero bullets): there are exactly 10 bullets and exactly 1 file header.
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(10);
    expect(section.match(/^\*\*[^*]+\*\*$/gm) ?? []).toHaveLength(1);
  });

  // ── R-filtros: stable deterministic ordering ──

  it('produces byte-identical output for the same input (stable ordering)', () => {
    const changes: EntityChange[] = [
      makeChange({ kind: 'function_added', name: 'b', filePath: 'src/z.ts' }),
      makeChange({ kind: 'function_added', name: 'a', filePath: 'src/a.ts' }),
      makeChange({ kind: 'type_added', name: 'c', filePath: 'src/z.ts' }),
    ];
    const first = formatSemanticDiffSection(makeSemanticDiff([...changes]));
    const second = formatSemanticDiffSection(makeSemanticDiff([...changes]));
    expect(first).toBe(second);
    // Files appear in first-seen order: z.ts (first change) before a.ts.
    expect(first.indexOf('**z.ts**')).toBeLessThan(first.indexOf('**a.ts**'));
    // Within z.ts, original order: b before c.
    expect(first.indexOf('`b`')).toBeLessThan(first.indexOf('`c`'));
  });

  // ── R-seguridad: signatures are NEVER rendered ──

  it('never renders oldSignature/newSignature', () => {
    const section = formatSemanticDiffSection(
      makeSemanticDiff([
        makeChange({
          kind: 'function_modified',
          name: 'foo',
          filePath: 'src/a.ts',
          oldSignature: 'export function foo(secret: InjectMe): void',
          newSignature: 'export function foo(x: PAYLOAD): void',
        }),
      ]),
    );
    expect(section).not.toContain('secret');
    expect(section).not.toContain('InjectMe');
    expect(section).not.toContain('PAYLOAD');
    expect(section).toContain('`foo`');
  });
});

// ─── R-seguridad: markdown injection (MANDATORY, blocking) ──────

describe('formatSemanticDiffSection — markdown injection', () => {
  // Render every vector through a single helper and assert neutralization.
  function renderName(name: string): string {
    return formatSemanticDiffSection(
      makeSemanticDiff([makeChange({ kind: 'function_added', name, filePath: 'src/evil.ts' })]),
    );
  }

  it('escapes table-breaking pipes', () => {
    const out = renderName('a|b|c');
    // Raw pipes must not survive unescaped (would break any enclosing table).
    expect(out).toContain('\\|');
    expect(out).not.toMatch(/[^\\]\|/);
  });

  it('strips backticks so the inline-code span cannot be broken out of', () => {
    // A backtick would close the `name` span and let trailing markup render.
    const out = renderName('a`b`c');
    // No bare backtick from the NAME survives — the only backticks present are
    // the two wrapping the (now backtick-free) name.
    const backtickCount = (out.match(/`/g) ?? []).length;
    expect(backtickCount).toBe(2);
    expect(out).toContain('`abc`');
  });

  it('neutralizes a code-fence breakout attempt', () => {
    const out = renderName('x```js\nalert(1)\n```');
    // The triple-fence backticks are stripped; the newline-bearing payload is
    // flattened. No bare fence remains beyond the wrapping pair.
    expect(out).not.toContain('```');
    // newlines from the name collapse to spaces (no extra markdown lines).
    expect(out).not.toContain('alert(1)\n');
  });

  it('neutralizes markdown/javascript links by keeping them inert inside code', () => {
    const out = renderName('[click](javascript:alert(1))');
    // Backticks are intact around the name (no breakout), so the bracket/paren
    // link syntax is literal text inside the inline-code span — not a live link.
    expect(out).toContain('`[click](javascript:alert(1))`');
    // sanity: there is no UNwrapped link rendered outside a code span.
    expect(out).not.toMatch(/[^`]\[click\]\(javascript/);
  });

  it('strips HTML comments (hidden prompt-injection payloads)', () => {
    const out = renderName('safe<!-- inject me -->name');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('inject me');
  });

  it('neutralizes @mentions (@everyone and @org/team)', () => {
    const everyone = renderName('@everyone');
    const team = renderName('@org/team');
    // A zero-width space is inserted after each '@' to break linkification.
    expect(everyone).toContain('@​');
    expect(team).toContain('@​');
    // The literal "@everyone" / "@org/team" sequences must NOT appear contiguously.
    expect(everyone).not.toMatch(/@everyone/);
    expect(team).not.toMatch(/@org\/team/);
  });

  it('escapes a <details>/</details> breakout attempt', () => {
    const out = renderName('</details><script>alert(1)</script>');
    // Every '<' is escaped to &lt; (sanitizeMarkdownText) — the closing tag
    // cannot terminate the real <details> wrapper, and <script> cannot open.
    // ('>' is intentionally NOT escaped; neutralizing the opening '<' is
    // sufficient to defang the tag.)
    expect(out).toContain('&lt;/details>');
    expect(out).toContain('&lt;script>');
    // The injected raw "</details><script>" sequence must NOT survive intact.
    expect(out).not.toContain('</details><script>');
    // The real wrapper still closes itself exactly once, on its own line.
    expect(out.match(/^<\/details>$/m) ?? []).toHaveLength(1);
  });

  it('combines all vectors in one name without breaking the section', () => {
    const out = renderName('@everyone|`</details>`<!--x-->[a](javascript:alert(1))```\nbreakout');
    // Section still well-formed: opens and closes its own <details> exactly once.
    expect(out.match(/<details>/g) ?? []).toHaveLength(1);
    expect(out.match(/<\/details>\n/g) ?? []).toHaveLength(1);
    // No raw injection metacharacters leaked:
    expect(out).not.toContain('<!--');
    expect(out).toContain('@​');
    expect(out).not.toContain('```');
  });
});

// ─── formatReviewComment: "What changed" integration ────────────

describe('formatReviewComment — "What changed" section', () => {
  it('inserts the section between Summary and Findings', () => {
    const result = makeResult({
      summary: 'Some summary.',
      findings: [makeFinding({ message: 'a finding' })],
      semanticDiff: makeSemanticDiff([makeChange({ kind: 'function_added', name: 'foo' })]),
    });
    const out = formatReviewComment(result);
    const summaryIdx = out.indexOf('### Summary');
    const sectionIdx = out.indexOf('🧬 What changed');
    const findingsIdx = out.indexOf('### Findings');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(summaryIdx);
    expect(findingsIdx).toBeGreaterThan(sectionIdx);
  });

  // ── R-render: byte-identical when no section renders ──

  it('is byte-identical when semanticDiff is undefined vs absent (no section)', () => {
    const base = makeResult({ summary: 'identical', findings: [makeFinding()] });
    const withUndefined = formatReviewComment({ ...base, semanticDiff: undefined });
    const without = formatReviewComment(base);
    expect(withUndefined).toBe(without);
  });

  it('is byte-identical when semanticDiff has 0 surviving entities (imports-only)', () => {
    const base = makeResult({ summary: 'identical', findings: [makeFinding()] });
    const without = formatReviewComment(base);
    const withImportsOnly = formatReviewComment({
      ...base,
      semanticDiff: makeSemanticDiff([
        makeChange({ kind: 'import_added', name: 'react', filePath: 'src/a.ts' }),
        makeChange({ kind: 'method_added', name: 'it', filePath: 'src/a.test.ts' }),
        makeChange({ kind: 'function_added', name: 'pyFn', filePath: 'a.py' }),
      ]),
    });
    expect(withImportsOnly).toBe(without);
  });

  it('is byte-identical for the c05-class diff (zero entity-level changes)', () => {
    // c05 fixture is a binary-only diff → extractor yields zero changes.
    const base = makeResult({ summary: 'binary only', findings: [] });
    const without = formatReviewComment(base);
    const withEmpty = formatReviewComment({ ...base, semanticDiff: makeSemanticDiff([]) });
    expect(withEmpty).toBe(without);
  });
});

// ─── End-to-end regression: extractSemanticDiff → section ───────
//
// Exercises the FULL real path (the extractor the pipeline runs feeds the
// renderer) rather than hand-built EntityChange fixtures. Asserts the
// presentation invariants the explore established for real giant/noisy PRs
// (#217/#221/#223 class): method noise dropped, signatures absent, non-TS
// gated, output well-formed markdown.

describe('formatSemanticDiffSection — extractSemanticDiff end-to-end', () => {
  it('renders a real TS diff: surfaces functions, drops method/test noise', () => {
    const diff = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      'index 1111111..2222222 100644',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1,3 +1,8 @@',
      '+export function buildThing(x: number): number {',
      '+  return x * 2;',
      '+}',
      '+export const handler = async (req: Req) => {',
      '+  return req;',
      '+};',
      '+import { z } from "zod";',
    ].join('\n');

    const sd = extractSemanticDiff(diff);
    const section = formatSemanticDiffSection(sd);

    expect(section).toContain('<details>');
    expect(section).toContain('</details>');
    expect(section).toContain('`buildThing`');
    expect(section).toContain('`handler`');
    // Imports surfaced as a count, never as the module name.
    expect(section).toContain('**Imports:** 1 added');
    expect(section).not.toContain('zod');
    // No signatures leaked into the rendered section.
    expect(section).not.toContain('req: Req');
    expect(section).not.toContain('x: number');
  });

  it('gates a non-TS (.py) real diff to an empty section', () => {
    const diff = [
      'diff --git a/script.py b/script.py',
      'index 1111111..2222222 100644',
      '--- a/script.py',
      '+++ b/script.py',
      '@@ -1,1 +1,2 @@',
      '+def do_thing():',
      '+    pass',
    ].join('\n');

    // The Python `def` does not match the TS declaration patterns, and even if
    // it did the extension gate would drop it. Either way: no section.
    expect(formatSemanticDiffSection(extractSemanticDiff(diff))).toBe('');
  });

  it('produces deterministic, well-formed output (single <details> pair) on a mixed diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,4 @@',
      '+export function alpha(): void {}',
      '+  private helper() {}',
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,1 +1,2 @@',
      '+export function ignored(): void {}',
    ].join('\n');

    const section = formatSemanticDiffSection(extractSemanticDiff(diff));
    expect(section).toContain('`alpha`');
    expect(section).not.toContain('ignored'); // .md gated out
    expect(section.match(/<details>/g) ?? []).toHaveLength(1);
    expect(section.match(/<\/details>/g) ?? []).toHaveLength(1);
  });
});
