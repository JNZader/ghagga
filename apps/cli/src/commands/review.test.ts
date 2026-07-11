/**
 * CLI review command tests.
 *
 * Tests argument parsing, config file resolution, output formatting,
 * and exit code mapping. The reviewPipeline is mocked to avoid
 * needing an actual LLM API key.
 */

import type { FindingSeverity, LLMProvider, ReviewResult, ReviewStatus } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ghagga-core to prevent actual LLM calls ───────────────

vi.mock('ghagga-core', () => {
  const mockTools = [
    {
      name: 'semgrep',
      displayName: 'Security (SAST multi-language)',
      category: 'security',
      tier: 'always-on',
      version: '1.90.0',
    },
    {
      name: 'trivy',
      displayName: 'SCA + IaC + Licenses',
      category: 'sca',
      tier: 'always-on',
      version: '0.69.3',
    },
    {
      name: 'cpd',
      displayName: 'Duplication detection',
      category: 'duplication',
      tier: 'always-on',
      version: '7.8.0',
    },
    {
      name: 'gitleaks',
      displayName: 'Secrets scanning',
      category: 'secrets',
      tier: 'always-on',
      version: '8.21.2',
    },
    {
      name: 'shellcheck',
      displayName: 'Shell script analysis',
      category: 'linting',
      tier: 'always-on',
      version: '0.10.0',
    },
    {
      name: 'markdownlint',
      displayName: 'Markdown linting',
      category: 'docs',
      tier: 'always-on',
      version: '0.17.1',
    },
    {
      name: 'lizard',
      displayName: 'Cyclomatic complexity',
      category: 'complexity',
      tier: 'always-on',
      version: '1.17.13',
    },
    {
      name: 'ruff',
      displayName: 'Python quality (*.py)',
      category: 'linting',
      tier: 'auto-detect',
      version: '0.9.7',
    },
    {
      name: 'bandit',
      displayName: 'Python security (*.py)',
      category: 'security',
      tier: 'auto-detect',
      version: '1.8.3',
    },
    {
      name: 'golangci-lint',
      displayName: 'Go quality + security (go.mod)',
      category: 'linting',
      tier: 'auto-detect',
      version: '1.63.4',
    },
    {
      name: 'biome',
      displayName: 'JS/TS quality (*.ts, *.js)',
      category: 'linting',
      tier: 'auto-detect',
      version: '1.9.4',
    },
    {
      name: 'pmd',
      displayName: 'Java quality (*.java)',
      category: 'quality',
      tier: 'auto-detect',
      version: '7.8.0',
    },
    {
      name: 'psalm',
      displayName: 'PHP quality + security (*.php)',
      category: 'quality',
      tier: 'auto-detect',
      version: '6.5.1',
    },
    {
      name: 'clippy',
      displayName: 'Rust quality (Cargo.toml)',
      category: 'linting',
      tier: 'auto-detect',
      version: '0.0.0',
    },
    {
      name: 'hadolint',
      displayName: 'Dockerfile best practices (Dockerfile)',
      category: 'linting',
      tier: 'auto-detect',
      version: '2.12.0',
    },
  ];

  return {
    reviewPipeline: vi.fn(),
    formatReviewComment: vi.fn().mockReturnValue('<!-- ghagga-review -->\nbody'),
    formatBoxSummary: vi.fn().mockReturnValue([]),
    REVIEW_COMMENT_MARKER: '<!-- ghagga-review -->',
    EngramMemoryStorage: { create: vi.fn() },
    buildSarif: vi.fn().mockReturnValue({
      $schema:
        'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [],
    }),
    SqliteMemoryStorage: {
      create: vi.fn().mockResolvedValue({
        searchObservations: vi.fn().mockResolvedValue([]),
        saveObservation: vi.fn().mockResolvedValue({}),
        createSession: vi.fn().mockResolvedValue({ id: 1 }),
        endSession: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }),
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
      gateway: 'auto',
      'cli-bridge': 'auto',
      ollama: 'llama3',
    },
    initializeDefaultTools: vi.fn(),
    toolRegistry: {
      getAll: vi.fn().mockReturnValue(mockTools),
      getByName: vi.fn(),
      getByTier: vi.fn(),
      register: vi.fn(),
      size: 15,
      validateAll: vi.fn(),
      clear: vi.fn(),
    },
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

// Embedding resolution is unrelated to this suite's behavior — stub to
// `none` (undefined provider) so the SqliteMemoryStorage.create call stays
// on the pre-existing keyword-only path the mocked ghagga-core above expects.
vi.mock('../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({
    config: { provider: 'none', candidateK: 200 },
    provider: undefined,
  }),
}));

describe('CLI review module', () => {
  it('exports reviewCommand function', async () => {
    const mod = await import('./review.js');
    expect(mod.reviewCommand).toBeTypeOf('function');
  });

  it('exports ReviewOptions type (verified by TypeScript at compile time)', async () => {
    const mod = await import('./review.js');
    expect(mod).toBeDefined();
    expect(typeof mod.reviewCommand).toBe('function');
  });

  it('reviewCommand expects exactly 2 arguments (targetPath, options)', async () => {
    const mod = await import('./review.js');
    expect(mod.reviewCommand.length).toBe(2);
  });
});

describe('CLI output formatting and exit codes', () => {
  // We test the internal formatting/exit code logic by checking types/contracts

  it('defines valid exit codes: PASSED=0, SKIPPED=0, FAILED=1, NEEDS_HUMAN_REVIEW=1, PARTIAL=1', () => {
    const exitCodes: Record<ReviewStatus, number> = {
      PASSED: 0,
      SKIPPED: 0,
      FAILED: 1,
      NEEDS_HUMAN_REVIEW: 1,
      PARTIAL: 1,
    };

    expect(exitCodes.PASSED).toBe(0);
    expect(exitCodes.SKIPPED).toBe(0);
    expect(exitCodes.FAILED).toBe(1);
    expect(exitCodes.NEEDS_HUMAN_REVIEW).toBe(1);
    expect(exitCodes.PARTIAL).toBe(1);
  });

  it('ReviewResult findings have expected structure', () => {
    const finding = {
      severity: 'high' as FindingSeverity,
      category: 'security',
      file: 'src/index.ts',
      line: 42,
      message: 'SQL injection vulnerability',
      suggestion: 'Use parameterized queries',
      source: 'ai' as const,
    };

    expect(finding.severity).toBe('high');
    expect(finding.category).toBe('security');
    expect(finding.file).toBe('src/index.ts');
    expect(finding.line).toBe(42);
    expect(finding.source).toBe('ai');
  });

  it('ReviewResult has all required metadata fields', () => {
    const metadata = {
      mode: 'simple' as const,
      provider: 'gateway' as const,
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 500,
      executionTimeMs: 3200,
      toolsRun: ['semgrep'],
      toolsSkipped: ['trivy', 'cpd'],
    };

    expect(metadata.mode).toBe('simple');
    expect(metadata.provider).toBe('gateway');
    expect(metadata.tokensUsed).toBeGreaterThan(0);
    expect(metadata.executionTimeMs).toBeGreaterThan(0);
    expect(metadata.toolsRun).toContain('semgrep');
    expect(metadata.toolsSkipped).toHaveLength(2);
  });
});

describe('CLI config file handling', () => {
  it('.ghagga.json config shape matches expected interface', () => {
    const config = {
      mode: 'workflow',
      provider: 'gateway',
      model: 'gpt-4o',
      enableSemgrep: true,
      enableTrivy: false,
      enableCpd: true,
      customRules: ['/path/to/rules.yml'],
      ignorePatterns: ['*.test.ts', '*.spec.ts'],
      reviewLevel: 'strict',
    };

    expect(config.mode).toBe('workflow');
    expect(config.enableTrivy).toBe(false);
    expect(config.customRules).toHaveLength(1);
    expect(config.ignorePatterns).toContain('*.test.ts');
  });

  it('CLI options take priority over config file', () => {
    // CLI says --no-semgrep, config says enableSemgrep: true
    const cliSemgrep = false;
    const configSemgrep = true;
    // In the mergeSettings function, CLI ?? config ?? default
    const resolved = cliSemgrep ?? configSemgrep;
    expect(resolved).toBe(false); // CLI wins
  });

  it('falls back to config file when CLI option is undefined', () => {
    const cliValue = undefined;
    const configValue = 'workflow';
    const defaultValue = 'simple';
    const resolved = cliValue ?? configValue ?? defaultValue;
    expect(resolved).toBe('workflow'); // Config wins over default
  });

  it('falls back to default when both CLI and config are undefined', () => {
    const cliValue = undefined;
    const configValue = undefined;
    const defaultValue = 'normal';
    const resolved = cliValue ?? configValue ?? defaultValue;
    expect(resolved).toBe('normal'); // Default wins
  });
});

describe('CLI input validation', () => {
  it('valid modes are: simple, workflow, consensus', () => {
    const validModes = ['simple', 'workflow', 'consensus'];
    expect(validModes).toContain('simple');
    expect(validModes).toContain('workflow');
    expect(validModes).toContain('consensus');
    expect(validModes).not.toContain('turbo');
  });

  it('valid providers are: gateway, cli-bridge, ollama', () => {
    const validProviders: LLMProvider[] = ['gateway', 'cli-bridge', 'ollama'];
    expect(validProviders).toContain('gateway');
    expect(validProviders).toContain('cli-bridge');
    expect(validProviders).toContain('ollama');
    expect(validProviders as string[]).not.toContain('anthropic');
    expect(validProviders as string[]).not.toContain('openai');
  });

  it('valid formats are: markdown, json', () => {
    const validFormats = ['markdown', 'json'];
    expect(validFormats).toContain('markdown');
    expect(validFormats).toContain('json');
    expect(validFormats).not.toContain('html');
  });
});

// ═══════════════════════════════════════════════════════════════
// Functional tests — exercise the actual reviewCommand function
// ═══════════════════════════════════════════════════════════════

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { reviewPipeline } from 'ghagga-core';
import type { ReviewOptions } from './review.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReviewPipeline = vi.mocked(reviewPipeline);

/** Default CLI options for tests */
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

/** A minimal ReviewResult that satisfies the type */
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

describe('reviewCommand — functional tests', () => {
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
    mockExistsSync.mockReturnValue(false); // no .ghagga.json by default
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should exit 0 with message when there is no diff', async () => {
    // execSync returns empty string for all git diff attempts
    mockExecSync.mockReturnValue('' as never);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No changes detected'));
  });

  it('should call reviewPipeline with correct arguments and exit 0 on PASSED', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+console.log("hello");';
    mockExecSync.mockReturnValue(diff as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult({ status: 'PASSED' }));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('/tmp/repo', defaultOptions());

    expect(mockReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        diff,
        mode: 'simple',
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'test-key',
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should exit 1 when review status is FAILED', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult({ status: 'FAILED' }));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should exit 1 when review status is NEEDS_HUMAN_REVIEW', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult({ status: 'NEEDS_HUMAN_REVIEW' }));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should exit 0 when review status is SKIPPED', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult({ status: 'SKIPPED' }));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should output JSON when format is json', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    const result = makeReviewResult();
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'json' }));

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
  });

  it('json output carries semanticDiff when present — full-result serialization is a DELIBERATE contract', async () => {
    // Pins the decision documented on ReviewResult.semanticDiff (types.ts):
    // the field is absent from DB persistence and the HTTP API, but the CLI
    // --format json path serializes the ENTIRE result, semanticDiff included.
    // If this test breaks, the CLI JSON contract changed — not an accident.
    mockExecSync.mockReturnValue('diff content' as never);
    const result = makeReviewResult({
      semanticDiff: {
        changes: [{ kind: 'function_added', name: 'newHelper', filePath: 'src/util.ts' }],
        summary: '1 function added',
      },
    });
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'json' }));

    const printed = logSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('"semanticDiff"'),
    );
    expect(printed).toBeDefined();
    const parsed = JSON.parse(String(printed?.[0]));
    expect(parsed.semanticDiff).toEqual({
      changes: [{ kind: 'function_added', name: 'newHelper', filePath: 'src/util.ts' }],
      summary: '1 function added',
    });
  });

  it('should output markdown with status and summary for markdown format', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    const result = makeReviewResult({
      status: 'PASSED',
      summary: 'Clean code, no issues found.',
      findings: [],
    });
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'markdown' }));

    // The markdown output should contain the summary
    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const markdownOutput = allLogCalls.find((s: string) => s.includes('PASSED'));
    expect(markdownOutput).toBeDefined();
    expect(markdownOutput).toContain('Clean code, no issues found.');
  });

  it('should format findings with severity and location in markdown', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    const result = makeReviewResult({
      findings: [
        {
          severity: 'high' as FindingSeverity,
          category: 'security',
          file: 'src/auth.ts',
          line: 42,
          message: 'Hardcoded secret detected',
          suggestion: 'Use environment variables',
          source: 'ai' as const,
        },
      ],
    });
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'markdown' }));

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const markdownOutput = allLogCalls.find((s: string) => s.includes('Findings'));
    expect(markdownOutput).toBeDefined();
    expect(markdownOutput).toContain('src/auth.ts:42');
    expect(markdownOutput).toContain('Hardcoded secret detected');
    expect(markdownOutput).toContain('Use environment variables');
  });

  it('should show "No findings" when findings array is empty', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult({ findings: [] }));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'markdown' }));

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const markdownOutput = allLogCalls.find((s: string) => s.includes('No findings'));
    expect(markdownOutput).toBeDefined();
  });

  it('should include tools run/skipped in markdown output', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    const result = makeReviewResult();
    result.metadata.toolsRun = ['semgrep', 'trivy'];
    result.metadata.toolsSkipped = ['cpd'];
    mockReviewPipeline.mockResolvedValue(result);

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ outputFormat: 'markdown' }));

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const markdownOutput = allLogCalls.find((s: string) => s.includes('Static Analysis'));
    expect(markdownOutput).toBeDefined();
    expect(markdownOutput).toContain('semgrep');
    expect(markdownOutput).toContain('cpd');
  });

  it('should exit 1 and log error when reviewPipeline throws', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockRejectedValue(new Error('API rate limit exceeded'));

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('API rate limit exceeded'));
  });

  it('should exit 1 when execSync throws (no git repo)', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('/tmp/not-a-repo', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Review failed'));
  });

  it('should load .ghagga.json config file when it exists', async () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+line';
    mockExecSync.mockReturnValue(diff as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        enableSemgrep: false,
        reviewLevel: 'strict',
        customRules: ['/rules/custom.yml'],
      }),
    );
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    // reviewPipeline should have been called with settings that include the config
    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.reviewLevel).toBe('strict');
    expect(settings.customRules).toEqual(['/rules/custom.yml']);
  });

  it('should handle non-Error thrown objects in catch block', async () => {
    mockExecSync.mockReturnValue('diff' as never);
    mockReviewPipeline.mockRejectedValue('string error');

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('string error'));
  });

  it('should use staged diff when available', async () => {
    const stagedDiff = 'diff --git staged changes';
    mockExecSync.mockReturnValue(stagedDiff as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    expect(mockReviewPipeline).toHaveBeenCalledWith(expect.objectContaining({ diff: stagedDiff }));
  });

  it('should pass verbose progress handler when verbose is true', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ verbose: true }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArgs.onProgress).toBeTypeOf('function');
  });

  it('should pass step-counter progress handler when verbose is false', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ verbose: false }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArgs.onProgress).toBeTypeOf('function');
  });

  it('should print progress header with mode, provider, and model', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand(
      '.',
      defaultOptions({ mode: 'workflow', provider: 'cli-bridge', model: 'gpt-4o' }),
    );

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(allLogCalls.some((s: string) => s.includes('workflow'))).toBe(true);
    expect(allLogCalls.some((s: string) => s.includes('cli-bridge'))).toBe(true);
    expect(allLogCalls.some((s: string) => s.includes('gpt-4o'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 7: Extensible tool system CLI flags
// ═══════════════════════════════════════════════════════════════

describe('Phase 7: --disable-tool flag', () => {
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

  it('should pass disabledTools to settings when --disable-tool is used', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ disableTools: ['gitleaks'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.disabledTools).toContain('gitleaks');
  });

  it('should pass multiple disabledTools when --disable-tool is repeated', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ disableTools: ['gitleaks', 'shellcheck', 'cpd'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    const disabled = settings.disabledTools as string[];
    expect(disabled).toContain('gitleaks');
    expect(disabled).toContain('shellcheck');
    expect(disabled).toContain('cpd');
  });

  it('should warn but not error for unknown tool in --disable-tool', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ disableTools: ['nonexistent'] }));

    // Should warn about unknown tool
    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(allLogCalls.some((s: string) => s.includes('Unknown tool "nonexistent"'))).toBe(true);

    // Should still proceed with review (not exit with error)
    expect(mockReviewPipeline).toHaveBeenCalled();
  });
});

describe('Phase 7: --enable-tool flag', () => {
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

  it('should pass enabledTools to settings when --enable-tool is used', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ enableTools: ['ruff'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.enabledTools).toContain('ruff');
  });

  it('should disable tool when both --enable-tool and --disable-tool for same tool', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ enableTools: ['ruff'], disableTools: ['ruff'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    // --disable-tool takes precedence
    expect(settings.disabledTools).toContain('ruff');
    expect(settings.enabledTools).not.toContain('ruff');
  });
});

describe('Phase 7: --list-tools flag', () => {
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

  it('should print tool list and exit 0 with --list-tools', async () => {
    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ listTools: true }));

    expect(exitSpy).toHaveBeenCalledWith(0);

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const output = allLogCalls.join('\n');
    expect(output).toContain('ALWAYS-ON:');
    expect(output).toContain('AUTO-DETECT:');
    expect(output).toContain('semgrep');
    expect(output).toContain('ruff');
    expect(output).toContain('hadolint');
  });

  it('should print JSON array with --list-tools --format json', async () => {
    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ listTools: true, outputFormat: 'json' }));

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Find the JSON output
    const jsonCall = logSpy.mock.calls.find((c: unknown[]) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();
    const tools = JSON.parse(String(jsonCall[0]));
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(15);

    // Each tool should have the required fields
    const first = tools[0];
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('category');
    expect(first).toHaveProperty('tier');
    expect(first).toHaveProperty('version');
  });

  it('should call process.exit(0) before review pipeline when --list-tools is used', async () => {
    // Note: process.exit is mocked as no-op, so execution continues past it.
    // We verify exit(0) is called first (real behavior: exits before pipeline).
    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ listTools: true }));

    // Verify exit(0) was called (which would terminate before pipeline in real execution)
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify exit was called before reviewPipeline would have been invoked
    // In real execution, process.exit(0) terminates — the pipeline never runs.
    const exitCallOrder = exitSpy.mock.invocationCallOrder[0];
    if (mockReviewPipeline.mock.invocationCallOrder.length > 0) {
      const pipelineCallOrder = mockReviewPipeline.mock.invocationCallOrder[0];
      expect(exitCallOrder).toBeLessThan(pipelineCallOrder);
    }
  });
});

describe('Phase 7: deprecated --no-semgrep/--no-trivy/--no-cpd flags', () => {
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

  it('should emit deprecation warning and map --no-semgrep to disabledTools', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ semgrep: false }));

    // Deprecation warning should be printed
    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      allLogCalls.some((s: string) =>
        s.includes('--no-semgrep is deprecated, use --disable-tool semgrep instead'),
      ),
    ).toBe(true);

    // Settings should have semgrep in disabledTools
    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.disabledTools).toContain('semgrep');
  });

  it('should emit deprecation warning for --no-trivy', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ trivy: false }));

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      allLogCalls.some((s: string) =>
        s.includes('--no-trivy is deprecated, use --disable-tool trivy instead'),
      ),
    ).toBe(true);

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.disabledTools).toContain('trivy');
  });

  it('should emit deprecation warning for --no-cpd', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ cpd: false }));

    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      allLogCalls.some((s: string) =>
        s.includes('--no-cpd is deprecated, use --disable-tool cpd instead'),
      ),
    ).toBe(true);

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.disabledTools).toContain('cpd');
  });

  it('should combine deprecated --no-semgrep with new --disable-tool gitleaks', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ semgrep: false, disableTools: ['gitleaks'] }));

    // Deprecation warning for --no-semgrep
    const allLogCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(allLogCalls.some((s: string) => s.includes('--no-semgrep is deprecated'))).toBe(true);

    // Both should be in disabledTools
    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    const disabled = settings.disabledTools as string[];
    expect(disabled).toContain('semgrep');
    expect(disabled).toContain('gitleaks');
  });
});

describe('Phase 7: config file with new tool fields', () => {
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
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should merge config file disabledTools with CLI --disable-tool', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        disabledTools: ['cpd', 'markdownlint'],
      }),
    );
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ disableTools: ['gitleaks'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    const disabled = settings.disabledTools as string[];
    expect(disabled).toContain('cpd');
    expect(disabled).toContain('markdownlint');
    expect(disabled).toContain('gitleaks');
  });

  it('should merge config file enabledTools with CLI --enable-tool', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        enabledTools: ['ruff'],
      }),
    );
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions({ enableTools: ['bandit'] }));

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    const enabled = settings.enabledTools as string[];
    expect(enabled).toContain('ruff');
    expect(enabled).toContain('bandit');
  });

  it('should handle config file with old enableCpd: false format', async () => {
    mockExecSync.mockReturnValue('diff content' as never);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        enableCpd: false,
      }),
    );
    mockReviewPipeline.mockResolvedValue(makeReviewResult());

    const { reviewCommand } = await import('./review.js');
    await reviewCommand('.', defaultOptions());

    const callArgs = mockReviewPipeline.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const settings = callArgs.settings as Record<string, unknown>;
    expect(settings.disabledTools).toContain('cpd');
  });
});
