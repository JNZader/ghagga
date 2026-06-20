/**
 * Output format routing tests for the review command.
 *
 * Tests that --output json / sarif / markdown produce correct output
 * and that TUI decorations are suppressed when --output is set.
 *
 * Uses the same mock patterns as review.test.ts.
 */

import type { ReviewResult } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ghagga-core ───────────────────────────────────────────

const { mockBuildSarif } = vi.hoisted(() => ({
  mockBuildSarif: vi.fn().mockReturnValue({
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ghagga',
            version: '1.0.0',
            informationUri: 'https://ghagga.dev',
            rules: [],
          },
        },
        results: [],
      },
    ],
  }),
}));

vi.mock('ghagga-core', () => ({
  reviewPipeline: vi.fn(),
  buildSarif: mockBuildSarif,
  formatReviewComment: vi.fn().mockReturnValue('<!-- ghagga-review -->\nbody'),
  formatBoxSummary: vi.fn().mockReturnValue([]),
  REVIEW_COMMENT_MARKER: '<!-- ghagga-review -->',
  SqliteMemoryStorage: {
    create: vi.fn().mockResolvedValue({
      searchObservations: vi.fn().mockResolvedValue([]),
      saveObservation: vi.fn().mockResolvedValue({}),
      createSession: vi.fn().mockResolvedValue({ id: 1 }),
      endSession: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
  EngramMemoryStorage: {
    create: vi.fn().mockResolvedValue(null),
  },
  DEFAULT_SETTINGS: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: true,
    enableMemory: true,
    customRules: [],
    ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
    reviewLevel: 'normal',
    enabledTools: [],
    disabledTools: [],
  },
  DEFAULT_MODELS: {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    google: 'gemini-2.0-flash',
  },
  initializeDefaultTools: vi.fn(),
  toolRegistry: {
    getAll: vi.fn().mockReturnValue([]),
    getByName: vi.fn(),
    getByTier: vi.fn(),
    register: vi.fn(),
    size: 0,
    validateAll: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

// ─── Imports ────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { reviewPipeline } from 'ghagga-core';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);

// ─── Helpers ────────────────────────────────────────────────────

function defaultOptions(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return {
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
    semgrep: true,
    trivy: true,
    cpd: true,
    memory: true,
    verbose: false,
    disableTools: [],
    enableTools: [],
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'All good!',
    findings: [],
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 100,
      executionTimeMs: 1500,
      toolsRun: ['semgrep'],
      toolsSkipped: [],
    },
    ...overrides,
  } as ReviewResult;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('--output flag routing', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mock spy type
  let logSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: mock spy type
  let errorSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: mock spy type
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('--output json produces valid JSON on console.log', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+hello';
    mockExecSync.mockReturnValue(diff as never);
    const result = makeReviewResult();
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'json' }));

    // Find the JSON call
    const jsonCall = logSpy.mock.calls.find((c: unknown[]) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();

    const parsed = JSON.parse(String(jsonCall[0]));
    expect(parsed.status).toBe('PASSED');
    expect(parsed.summary).toBe('All good!');
    expect(parsed.findings).toEqual([]);
  });

  it('--output sarif calls buildSarif and produces valid SARIF JSON with version 2.1.0', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+hello';
    mockExecSync.mockReturnValue(diff as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'sarif', version: '2.5.0' }));

    // buildSarif should have been called
    expect(mockBuildSarif).toHaveBeenCalledWith(expect.anything(), '2.5.0');

    // Output should be valid JSON with SARIF schema
    const jsonCall = logSpy.mock.calls.find((c: unknown[]) => {
      try {
        const parsed = JSON.parse(String(c[0]));
        return parsed.$schema !== undefined;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(String(jsonCall[0]));
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toContain('sarif-schema-2.1.0.json');
  });

  it('--output markdown produces string output (no ANSI)', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+hello';
    mockExecSync.mockReturnValue(diff as never);
    mockReviewPipeline.mockResolvedValue(
      makeReviewResult({
        status: 'PASSED',
        summary: 'Clean code!',
      }),
    );

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'markdown' }));

    // console.log should have been called with the markdown output
    const markdownCall = logSpy.mock.calls.find((c: unknown[]) => {
      const text = String(c[0]);
      return text.includes('GHAGGA Code Review') && text.includes('Clean code!');
    });

    expect(markdownCall).toBeDefined();

    // Should not contain ANSI escape codes
    const output = String(markdownCall[0]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI detection
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('--output sarif keeps stdout pure JSON (no interleaved tool diagnostics)', async () => {
    // BL-SARIF-STDOUT: core static-analysis tools used to write progress to
    // stdout (console.log), corrupting machine output for CI consumers. They
    // must now write to stderr. Simulate a tool emitting a diagnostic during
    // the pipeline and assert it never lands on stdout.
    const diff = 'diff --git a/file.ts b/file.ts\n+hello';
    mockExecSync.mockReturnValue(diff as never);
    mockReviewPipeline.mockImplementation(async () => {
      // A core tool diagnostic — now correctly routed to stderr.
      console.error('[ghagga:tools] Running static analysis with registry-driven orchestrator');
      return makeReviewResult();
    });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'sarif', version: '2.5.0' }));

    // EVERY console.log (stdout) call must be parseable JSON — zero diagnostics.
    const stdoutCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stdoutCalls.length).toBeGreaterThan(0);
    for (const line of stdoutCalls) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // The tool diagnostic landed on stderr, not stdout.
    const stderrCalls = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[ghagga:tools]'))).toBe(true);
    expect(stdoutCalls.some((s: string) => s.includes('[ghagga:tools]'))).toBe(false);
  });

  it('when --output is set, tui.intro() and tui.outro() are NOT called', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+hello';
    mockExecSync.mockReturnValue(diff as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'json' }));

    // tui.intro and tui.outro delegate to console.log in plain mode.
    // When --output is set (json), the intro/outro should be skipped.
    // The only console.log call should be the JSON output.
    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));

    // Should NOT contain TUI intro/outro markers
    expect(allLogCalls.some((s: string) => s.includes('GHAGGA Code Review'))).toBe(false);
    expect(allLogCalls.some((s: string) => s.includes('Review complete'))).toBe(false);
  });
});
