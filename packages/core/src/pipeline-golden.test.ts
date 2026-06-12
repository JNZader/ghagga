/**
 * GOLDEN SNAPSHOT NET for reviewPipeline — split-review-pipeline Batch 0.
 *
 * ⚠️ FREEZE AS-IS — do NOT "fix" behavior here. These snapshots pin the
 * EXACT observable behavior of reviewPipeline @ main 992c69f (result shape,
 * findings order, emit stream order, console.warn strings, failedSteps
 * names) so the phase-extraction batches (B1..B6) can prove byte-equal
 * behavior. If a snapshot changes during the refactor, that IS the drift
 * we are hunting — fix the code, not the snapshot.
 *
 * Normalization contract (see normalizeDeep / normalizeMsString):
 *   - numeric keys matching /(executionTimeMs|durationMs|queryDurationMs)$/i → 0
 *   - Date values (e.g. lastUpdated, createdAt) → '<date>'
 *   - emit/warn strings: /\(\d+ms\)/ → '(Nms)'
 *
 * Load-bearing notes pinned by this suite:
 *   - `fileList` is captured BEFORE the blast-radius filter (pipeline.ts:228)
 *     and consumed by call-chain/static/code-intel/negative-examples. The
 *     "call-chain sees PRE-blast-radius fileList" test guards that trap.
 *   - 3 steps degrade WITHOUT failedSteps.push: call-chain (:360),
 *     negative-examples (:430), self-improve (:453). Pinned explicitly.
 *   - code-intel's failedSteps.push (:1410) is UNREACHABLE via provider
 *     failures (Promise.allSettled swallows per-file rejections). The only
 *     way to exercise that catch is the emit callback throwing on the
 *     success message — which is exactly how we force it here.
 *   - negative-examples requires `memoryStorage instanceof SqliteMemoryStorage`
 *     (pipeline.ts:408). We satisfy it with
 *     Object.create(SqliteMemoryStorage.prototype) — real prototype chain,
 *     no sqlite database, fully deterministic stubs (B0.3 resolution).
 */

import { afterEach, beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';

// ─── Mocks (full) ───────────────────────────────────────────────

vi.mock('./agents/simple.js', () => ({ runSimpleReview: vi.fn() }));
vi.mock('./agents/workflow.js', () => ({ runWorkflowReview: vi.fn() }));
vi.mock('./agents/consensus.js', () => ({ runConsensusReview: vi.fn() }));
vi.mock('./agents/diagnostic.js', () => ({ runDiagnosticReview: vi.fn() }));
vi.mock('./agents/fan-out-lenses.js', () => ({
  runFanOutReview: vi.fn(),
  loadLensesFromDir: vi.fn(),
}));
vi.mock('./graph/blast-radius.js', () => ({ computeBlastRadius: vi.fn() }));
vi.mock('./memory/search.js', () => ({ searchMemoryForContext: vi.fn() }));
vi.mock('./memory/persist.js', () => ({ persistReviewObservations: vi.fn() }));
vi.mock('./tools/plugins/index.js', () => ({ initializeDefaultTools: vi.fn() }));
vi.mock('./tools/registry.js', () => ({
  toolRegistry: { getAll: vi.fn().mockReturnValue([]), clear: vi.fn() },
}));
vi.mock('./exploitability/index.js', () => ({
  analyzeExploitability: vi.fn(),
  analyzeUsage: vi.fn(),
}));
vi.mock('./recursive/index.js', () => ({ recursiveReview: vi.fn() }));
vi.mock('./doc-validation/index.js', () => ({
  extractChangedSymbols: vi.fn(),
  scanDocsForSymbols: vi.fn(),
}));
vi.mock('./ranking/index.js', () => ({ rankFindings: vi.fn() }));

// ─── Mocks (partial — keep pure helpers real) ───────────────────

vi.mock('./tools/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/runner.js')>();
  return {
    ...actual,
    runStaticAnalysis: vi.fn(),
    isToolRegistryEnabled: vi.fn(() => false),
  };
});

vi.mock('./flood/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flood/index.js')>();
  return { ...actual, detectFlood: vi.fn(actual.detectFlood) };
});

vi.mock('./graph/call-chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph/call-chain.js')>();
  return { ...actual, buildCallChainFromDiff: vi.fn(actual.buildCallChainFromDiff) };
});

vi.mock('./graph/reverse-deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph/reverse-deps.js')>();
  return {
    ...actual,
    buildReverseDependencyMap: vi.fn(actual.buildReverseDependencyMap),
    findDependents: vi.fn(actual.findDependents),
  };
});

vi.mock('./enhance/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./enhance/index.js')>();
  return { ...actual, enhanceFindings: vi.fn() };
});

vi.mock('./trust/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trust/index.js')>();
  return { ...actual, computeAuthorTrustScore: vi.fn() };
});

vi.mock('./self-improve/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./self-improve/index.js')>();
  return {
    ...actual,
    loadFeedback: vi.fn(),
    deriveRules: vi.fn(),
    formatRulesForPrompt: vi.fn(),
  };
});

// ─── Imports (post-mock) ────────────────────────────────────────

import { runConsensusReview } from './agents/consensus.js';
import { runDiagnosticReview } from './agents/diagnostic.js';
import { loadLensesFromDir, runFanOutReview } from './agents/fan-out-lenses.js';
import { runSimpleReview } from './agents/simple.js';
import { runWorkflowReview } from './agents/workflow.js';
import type { CodeIntelProvider } from './code-intel/types.js';
import { extractChangedSymbols, scanDocsForSymbols } from './doc-validation/index.js';
import { enhanceFindings } from './enhance/index.js';
import type { EnhanceMetadata, EnhanceResult } from './enhance/types.js';
import { analyzeExploitability, analyzeUsage } from './exploitability/index.js';
import { detectFlood } from './flood/index.js';
import { type BlastRadiusResult, computeBlastRadius } from './graph/blast-radius.js';
import { buildCallChainFromDiff } from './graph/call-chain.js';
import { findDependents } from './graph/reverse-deps.js';
import type { DependencyGraph, GraphLoader, GraphMetadata } from './graph/schema.js';
import { persistReviewObservations } from './memory/persist.js';
import { searchMemoryForContext } from './memory/search.js';
import { SqliteMemoryStorage } from './memory/sqlite.js';
import { reviewPipeline } from './pipeline.js';
import { rankFindings } from './ranking/index.js';
import { recursiveReview } from './recursive/index.js';
import type { RecursiveReviewReport, RegressionFinding } from './recursive/types.js';
import {
  deriveRules,
  formatRulesForPrompt,
  type ImprovementRule,
  loadFeedback,
} from './self-improve/index.js';
import { runStaticAnalysis } from './tools/runner.js';
import { computeAuthorTrustScore } from './trust/index.js';
import type {
  AuthorTrustScore,
  LLMProvider,
  NegativeExample,
  ProgressEvent,
  ProviderChainEntry,
  ReviewFinding,
  ReviewInput,
  ReviewResult,
  ReviewSettings,
} from './types.js';

// ─── Normalization (the central timing normalizer) ──────────────

const TIMING_KEY_RE = /(executionTimeMs|durationMs|queryDurationMs)$/i;
const MS_IN_STRING_RE = /\(\d+ms\)/g;
// toLocaleString() output is locale-dependent ('140.000' es-AR vs '140,000' en-US,
// pipeline.ts token-budget emit) — strip group separators so snapshots are
// portable across machines/CI locales while still pinning the value.
const GROUPED_NUMBER_RE = /\d{1,3}(?:[.,\u00A0\u202F\u2009 ]\d{3})+/g;

function normalizeMsString(value: string): string {
  return value
    .replace(MS_IN_STRING_RE, '(Nms)')
    .replace(GROUPED_NUMBER_RE, (m) => m.replace(/\D/g, ''));
}

/**
 * Recursively normalize a value for snapshotting:
 * - numbers under timing keys → 0
 * - Date instances → '<date>'
 * - strings: '(123ms)' → '(Nms)'
 */
function normalizeDeep(value: unknown, key?: string): unknown {
  if (value instanceof Date) return '<date>';
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDeep(v, k);
    }
    return out;
  }
  if (typeof value === 'number' && key !== undefined && TIMING_KEY_RE.test(key)) return 0;
  if (typeof value === 'string') return normalizeMsString(value);
  return value;
}

function normalizeEvent(e: ProgressEvent): Record<string, string> {
  const out: Record<string, string> = { step: e.step, message: normalizeMsString(e.message) };
  if (e.detail !== undefined) out.detail = normalizeMsString(e.detail);
  return out;
}

function formatWarnArg(arg: unknown): string {
  if (arg instanceof Error) return `[Error] ${arg.message}`;
  if (typeof arg === 'string') return normalizeMsString(arg);
  return JSON.stringify(arg);
}

// ─── Fixtures ───────────────────────────────────────────────────

const MINIMAL_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export default x;
`;

const TWO_FILE_DIFF = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const x = 1;
+export function indexFn() {}
 export default x;
diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1 +1,2 @@
 export const u = 1;
+export function helper() {}
`;

const MD_ONLY_DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Hello
+World
`;

function skippedTool() {
  return { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 };
}

const SKIPPED_STATIC = () => ({ semgrep: skippedTool(), trivy: skippedTool(), cpd: skippedTool() });

function semgrepFinding(): ReviewFinding {
  return {
    severity: 'high',
    category: 'security',
    file: 'src/index.ts',
    line: 5,
    message: 'SQL injection via string concatenation',
    source: 'semgrep',
  };
}

function trivyCveFinding(): ReviewFinding {
  return {
    severity: 'critical',
    category: 'dependency-vulnerability',
    file: 'package.json',
    line: 1,
    message: 'CVE-2024-0001 in lodash',
    source: 'trivy',
  };
}

function staticWithSemgrep() {
  return {
    semgrep: { status: 'success' as const, findings: [semgrepFinding()], executionTimeMs: 100 },
    trivy: skippedTool(),
    cpd: skippedTool(),
  };
}

function staticWithTwoFindings() {
  return {
    semgrep: {
      status: 'success' as const,
      findings: [
        semgrepFinding(),
        {
          severity: 'low' as const,
          category: 'style',
          file: 'src/index.ts',
          line: 9,
          message: 'Prefer const over let',
          source: 'semgrep' as const,
        },
      ],
      executionTimeMs: 100,
    },
    trivy: skippedTool(),
    cpd: skippedTool(),
  };
}

function staticWithCve() {
  return {
    semgrep: { status: 'success' as const, findings: [semgrepFinding()], executionTimeMs: 100 },
    trivy: { status: 'success' as const, findings: [trivyCveFinding()], executionTimeMs: 200 },
    cpd: skippedTool(),
  };
}

function aiFinding(): ReviewFinding {
  return {
    severity: 'medium',
    category: 'bug',
    file: 'src/index.ts',
    line: 2,
    message: 'AI: possible off-by-one in loop bound',
    source: 'ai',
  };
}

function makeAgentResult(mode: string, overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: `${mode} review OK.`,
    findings: [],
    staticAnalysis: { semgrep: skippedTool(), trivy: skippedTool(), cpd: skippedTool() },
    memoryContext: null,
    metadata: {
      mode: mode as ReviewResult['metadata']['mode'],
      provider: 'gateway',
      model: 'test-model',
      tokensUsed: 100,
      executionTimeMs: 500,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

const TRUST_SCORE: AuthorTrustScore = {
  author: 'alice',
  score: 0.85,
  tier: 'trusted',
  commitCount: 42,
  firstSeenDaysAgo: 200,
  lastUpdated: new Date('2024-01-01T00:00:00Z'),
};

const ENHANCE_RESULT: EnhanceResult = {
  groups: [],
  priorities: { 1: 9 },
  suggestions: { 1: 'Use parameterized queries.' },
  filtered: [],
};

const ENHANCE_META: EnhanceMetadata = {
  model: 'test-enhance-model',
  tokenUsage: { input: 10, output: 5 },
  groupCount: 0,
  filteredCount: 0,
};

const NEG_EXAMPLE: NegativeExample = {
  findingHash: 'hash-1',
  contextHash: 'ctx-1',
  category: 'security',
  reason: 'false positive on test fixture',
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

function regressionFinding(): RegressionFinding {
  return {
    severity: 'high',
    category: 'bug',
    file: 'src/index.ts',
    line: 2,
    message: 'Regression: suggested fix breaks null handling',
    source: 'ai',
    isRegression: true,
    originatingSuggestion: { file: 'src/index.ts', line: 2, suggestion: 'use ?. operator' },
  };
}

const RECURSIVE_REPORT: RecursiveReviewReport = {
  iterations: 1,
  converged: false,
  regressions: [regressionFinding()],
  totalNewIssues: 1,
};

const MINIMAL_GRAPH: DependencyGraph = {
  version: 1,
  rootDir: '/repo',
  nodes: {
    'src/index.ts': {
      hash: 'abc123',
      language: 'typescript',
      imports: [],
      exports: ['indexFn'],
      calls: [],
      isTest: false,
    },
    'src/utils.ts': {
      hash: 'def456',
      language: 'typescript',
      imports: ['src/index.ts'],
      exports: ['helper'],
      calls: [],
      isTest: false,
    },
  },
};

const BLAST_KEEP_INDEX_ONLY: BlastRadiusResult = {
  files: new Set(['src/index.ts']),
  changedFiles: ['src/index.ts'],
  dependents: [],
  testFiles: [],
  depth: 1,
  exceededCap: false,
};

const BLAST_KEEP_BOTH: BlastRadiusResult = {
  files: new Set(['src/index.ts', 'src/utils.ts']),
  changedFiles: ['src/index.ts', 'src/utils.ts'],
  dependents: [],
  testFiles: [],
  depth: 1,
  exceededCap: false,
};

const BLAST_EXCEEDED: BlastRadiusResult = {
  files: new Set(Array.from({ length: 55 }, (_, i) => `src/file${i}.ts`)),
  changedFiles: ['src/index.ts'],
  dependents: Array.from({ length: 54 }, (_, i) => `src/file${i}.ts`),
  testFiles: [],
  depth: 3,
  exceededCap: true,
};

function makeGraphLoader(overrides: Partial<GraphLoader> = {}): GraphLoader {
  return {
    load: vi.fn().mockResolvedValue(MINIMAL_GRAPH),
    loadMetadata: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const FAKE_EMBED: NonNullable<ReviewInput['embeddingProvider']> = {
  embed: async () => [0.1, 0.2],
  embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
  dimension: 2,
};

function makeCodeIntelProvider(): CodeIntelProvider {
  return {
    getCallers: async () => [{ file: 'src/app.ts', symbol: 'callerFn', line: 3 }],
    getCallees: async () => [],
    getFileImports: async () => ['./utils.js'],
    getFileExports: async () => ['indexFn'],
  };
}

/**
 * B0.3 resolution: a structurally-real SqliteMemoryStorage that passes the
 * `instanceof` gate at pipeline.ts:408 WITHOUT opening a database. Methods
 * used by the pipeline are stubbed deterministically.
 */
function makeFakeSqliteStorage(
  overrides: Partial<
    Pick<SqliteMemoryStorage, 'getNegativeExamplesForFile' | 'getTrustScore' | 'upsertTrustScore'>
  > = {},
): SqliteMemoryStorage {
  const fake = Object.create(SqliteMemoryStorage.prototype) as SqliteMemoryStorage;
  fake.getNegativeExamplesForFile = overrides.getNegativeExamplesForFile ?? (() => []);
  fake.getTrustScore = overrides.getTrustScore ?? (() => null);
  fake.upsertTrustScore = overrides.upsertTrustScore ?? (() => {});
  return fake;
}

function makeSettings(overrides: Partial<ReviewSettings> = {}): ReviewSettings {
  return {
    enableSemgrep: false,
    enableTrivy: false,
    enableCpd: false,
    enableMemory: false,
    customRules: [],
    ignorePatterns: [],
    reviewLevel: 'normal',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: MINIMAL_DIFF,
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-api-key',
    settings: makeSettings(),
    context: {
      repoFullName: 'test/repo',
      prNumber: 42,
      commitMessages: [],
      fileList: [],
    },
    memoryStorage: undefined,
    ...overrides,
  };
}

// ─── Harness ────────────────────────────────────────────────────

let warnCalls: string[][] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

interface GoldenCapture {
  result: ReviewResult;
  golden: { result: unknown; events: Record<string, string>[]; warns: string[][] };
}

async function runGolden(
  input: ReviewInput,
  opts: { emitHook?: (e: ProgressEvent) => void } = {},
): Promise<GoldenCapture> {
  const events: ProgressEvent[] = [];
  const result = await reviewPipeline({
    ...input,
    onProgress: (e) => {
      events.push(e);
      opts.emitHook?.(e);
    },
  });
  return {
    result,
    golden: {
      result: normalizeDeep(result),
      events: events.map(normalizeEvent),
      warns: warnCalls.map((args) => [...args]),
    },
  };
}

// ─── Setup ──────────────────────────────────────────────────────

type M<T extends (...args: never[]) => unknown> = MockedFunction<T>;

beforeEach(() => {
  vi.clearAllMocks();
  warnCalls = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnCalls.push(args.map(formatWarnArg));
  });

  (runStaticAnalysis as M<typeof runStaticAnalysis>).mockImplementation(async () =>
    SKIPPED_STATIC(),
  );
  (runSimpleReview as M<typeof runSimpleReview>).mockImplementation(async () =>
    makeAgentResult('simple'),
  );
  (runWorkflowReview as M<typeof runWorkflowReview>).mockImplementation(async () =>
    makeAgentResult('workflow'),
  );
  (runConsensusReview as M<typeof runConsensusReview>).mockImplementation(async () =>
    makeAgentResult('consensus'),
  );
  (runDiagnosticReview as M<typeof runDiagnosticReview>).mockImplementation(async () =>
    makeAgentResult('diagnostic'),
  );
  (runFanOutReview as M<typeof runFanOutReview>).mockImplementation(async () =>
    makeAgentResult('fan-out'),
  );
  (searchMemoryForContext as M<typeof searchMemoryForContext>).mockResolvedValue(
    'Past review: watch the parser.',
  );
  (persistReviewObservations as M<typeof persistReviewObservations>).mockResolvedValue(undefined);
  (recursiveReview as M<typeof recursiveReview>).mockResolvedValue(null);
  (extractChangedSymbols as M<typeof extractChangedSymbols>).mockReturnValue([]);
  (scanDocsForSymbols as M<typeof scanDocsForSymbols>).mockReturnValue({
    changedSymbols: [],
    staleReferences: [],
    docsScanned: 0,
  });
  (rankFindings as M<typeof rankFindings>).mockImplementation(async (findings) =>
    [...findings].reverse(),
  );
  (enhanceFindings as M<typeof enhanceFindings>).mockResolvedValue({
    result: ENHANCE_RESULT,
    metadata: ENHANCE_META,
  });
  (analyzeExploitability as M<typeof analyzeExploitability>).mockImplementation((findings) => {
    for (const f of findings) {
      if (f.source === 'trivy') f.exploitability = 'not-exploitable';
    }
  });
  (analyzeUsage as M<typeof analyzeUsage>).mockImplementation(async (findings) => {
    for (const f of findings) {
      if (f.source === 'trivy') f.usageLabel = 'in-use';
    }
  });
  (loadFeedback as M<typeof loadFeedback>).mockResolvedValue([]);
  (deriveRules as M<typeof deriveRules>).mockReturnValue([]);
  (formatRulesForPrompt as M<typeof formatRulesForPrompt>).mockReturnValue('');
  (computeAuthorTrustScore as M<typeof computeAuthorTrustScore>).mockResolvedValue(TRUST_SCORE);
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('golden: baseline & modes', () => {
  it('baseline: simple mode, all optional steps off', async () => {
    const run = await runGolden(makeInput());
    expect(run.golden).toMatchSnapshot();
  });

  it('static-only: aiReviewEnabled=false skips the agent entirely', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    const run = await runGolden(makeInput({ aiReviewEnabled: false }));
    expect(runSimpleReview).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });

  it('mode: workflow', async () => {
    const run = await runGolden(makeInput({ mode: 'workflow' }));
    expect(runWorkflowReview).toHaveBeenCalledOnce();
    expect(run.golden).toMatchSnapshot();
  });

  it('mode: consensus', async () => {
    const run = await runGolden(makeInput({ mode: 'consensus' }));
    expect(runConsensusReview).toHaveBeenCalledOnce();
    expect(run.golden).toMatchSnapshot();
  });

  it('mode: diagnostic stays diagnostic on ollama', async () => {
    const run = await runGolden(
      makeInput({ mode: 'diagnostic', provider: 'ollama', model: 'llama3', apiKey: 'ollama-key' }),
    );
    expect(runDiagnosticReview).toHaveBeenCalledOnce();
    expect(runSimpleReview).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });

  it('mode: fan-out (no lensDir → loadLensesFromDir not called)', async () => {
    const run = await runGolden(makeInput({ mode: 'fan-out' }));
    expect(runFanOutReview).toHaveBeenCalledOnce();
    expect(loadLensesFromDir).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });

  it('mode: diagnostic falls back to simple on gateway', async () => {
    const run = await runGolden(makeInput({ mode: 'diagnostic' }));
    expect(runDiagnosticReview).not.toHaveBeenCalled();
    expect(runSimpleReview).toHaveBeenCalledOnce();
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: early returns', () => {
  it('flood-skip: recommendation=skip aborts before any expensive step', async () => {
    (detectFlood as M<typeof detectFlood>).mockReturnValueOnce({
      isFlood: true,
      signals: [{ type: 'bot', confidence: 1.0, detail: 'Author "dep-bot" matches bot pattern' }],
      recommendation: 'skip',
    });
    const run = await runGolden(makeInput());
    expect(run.result.status).toBe('SKIPPED');
    expect(runStaticAnalysis).not.toHaveBeenCalled();
    expect(runSimpleReview).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });

  it('all files filtered out: returns SKIPPED before any expensive step', async () => {
    const run = await runGolden(
      makeInput({ diff: MD_ONLY_DIFF, settings: makeSettings({ ignorePatterns: ['*.md'] }) }),
    );
    expect(run.result.status).toBe('SKIPPED');
    expect(runStaticAnalysis).not.toHaveBeenCalled();
    expect(runSimpleReview).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: optional steps ON (isolated)', () => {
  it('blast-radius ON: graph available filters files', async () => {
    (computeBlastRadius as M<typeof computeBlastRadius>).mockReturnValueOnce(BLAST_KEEP_INDEX_ONLY);
    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        graphLoader: makeGraphLoader(),
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('blast-radius ON: exceeded cap falls back to full diff', async () => {
    (computeBlastRadius as M<typeof computeBlastRadius>).mockReturnValueOnce(BLAST_EXCEEDED);
    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        graphLoader: makeGraphLoader(),
        settings: makeSettings({ enableBlastRadius: true, maxBlastRadiusFiles: 50 }),
      }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('call-chain + reverse-deps ON: consumes PRE-blast-radius fileList (load-bearing)', async () => {
    (computeBlastRadius as M<typeof computeBlastRadius>).mockReturnValueOnce(BLAST_KEEP_INDEX_ONLY);
    (buildCallChainFromDiff as M<typeof buildCallChainFromDiff>).mockReturnValueOnce({
      changedSymbols: [{ filePath: 'src/index.ts', symbolName: 'indexFn', kind: 'function' }],
      affectedSymbols: [
        { filePath: 'src/index.ts', symbolName: 'indexFn', kind: 'function' },
        { filePath: 'src/utils.ts', symbolName: 'helper', kind: 'function' },
      ],
      callChainGraph: { nodes: [], edges: [] },
      depth: 2,
    });
    (findDependents as M<typeof findDependents>)
      .mockReturnValueOnce({ target: 'src/index.ts', dependents: [], transitiveCount: 4 })
      .mockReturnValueOnce({ target: 'src/utils.ts', dependents: [], transitiveCount: 0 });

    const fileReaderCalls: string[] = [];
    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        graphLoader: makeGraphLoader(),
        fileReader: async (p: string) => {
          fileReaderCalls.push(p);
          return 'import "./index.js";\nexport function helper() {}\n';
        },
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    // ⚠️ fileList is captured BEFORE blast-radius filtering (pipeline.ts:228):
    // the blast filter reduced filteredFiles to src/index.ts only, but
    // call-chain still reads BOTH files. Do not "fix" during the refactor.
    expect(fileReaderCalls).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(run.golden).toMatchSnapshot();
  });

  it('code-intel ON: provider data flows into metadata and emits', async () => {
    const run = await runGolden(
      makeInput({
        codeIntelProvider: makeCodeIntelProvider(),
        settings: makeSettings({ enableCodeIntel: true }),
      }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('checklist ON: context emitted and findings scored', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    const run = await runGolden(
      makeInput({ settings: makeSettings({ checklist: { enabled: true, dimensions: [] } }) }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('enhance ON: compute in 5.5, apply in merge — ai findings preserved', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (runSimpleReview as M<typeof runSimpleReview>).mockResolvedValueOnce(
      makeAgentResult('simple', { findings: [aiFinding()] }),
    );
    const run = await runGolden(makeInput({ enhance: true }));
    expect(run.golden).toMatchSnapshot();
  });

  it('author-trust ON: trusted author overrides workflow → simple', async () => {
    const run = await runGolden(
      makeInput({ mode: 'workflow', author: 'alice', features: { authorTrust: true } }),
    );
    expect(runSimpleReview).toHaveBeenCalledOnce();
    expect(runWorkflowReview).not.toHaveBeenCalled();
    expect(run.golden).toMatchSnapshot();
  });

  it('recursive-review ON: regressions are appended to findings', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (recursiveReview as M<typeof recursiveReview>).mockResolvedValueOnce(RECURSIVE_REPORT);
    const run = await runGolden(
      makeInput({ settings: makeSettings({ enableRecursiveReview: true }) }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('doc-validation ON: stale references pushed as low/documentation findings', async () => {
    (extractChangedSymbols as M<typeof extractChangedSymbols>).mockReturnValueOnce(['indexFn']);
    (scanDocsForSymbols as M<typeof scanDocsForSymbols>).mockReturnValueOnce({
      changedSymbols: ['indexFn'],
      staleReferences: [
        { file: 'docs/api.md', line: 10, symbol: 'indexFn', context: 'see indexFn()' },
      ],
      docsScanned: 2,
    });
    const run = await runGolden(
      makeInput({ settings: makeSettings({ enableDocValidation: true }) }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('semantic-ranking ON: findings reordered (reverse mock pins reorder)', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(
      staticWithTwoFindings(),
    );
    const run = await runGolden(makeInput({ embeddingProvider: FAKE_EMBED }));
    expect(run.golden).toMatchSnapshot();
  });

  it('negative-examples ON: SqliteMemoryStorage instanceof gate satisfied', async () => {
    const storage = makeFakeSqliteStorage({
      getNegativeExamplesForFile: () => [NEG_EXAMPLE],
    });
    const run = await runGolden(makeInput({ memoryStorage: storage }));
    expect(run.golden).toMatchSnapshot();
  });

  it('self-improve ON: rules prepended to memory context', async () => {
    (loadFeedback as M<typeof loadFeedback>).mockResolvedValueOnce([
      {
        findingHash: 'h1',
        outcome: 'rejected',
        category: 'security',
        severity: 'high',
        modelUsed: 'test-model',
        recordedAt: '2024-01-01T00:00:00Z',
      },
      {
        findingHash: 'h2',
        outcome: 'rejected',
        category: 'security',
        severity: 'low',
        modelUsed: 'test-model',
        recordedAt: '2024-01-02T00:00:00Z',
      },
    ]);
    (deriveRules as M<typeof deriveRules>).mockReturnValueOnce([{} as ImprovementRule]);
    (formatRulesForPrompt as M<typeof formatRulesForPrompt>).mockReturnValueOnce(
      '## Self-Improve Rules\n- Avoid flagging test fixtures.',
    );
    const run = await runGolden(
      makeInput({ settings: makeSettings({ selfImprovePath: '/fake/self-improve.json' }) }),
    );
    expect(run.golden).toMatchSnapshot();
  });

  it('memory ON: search feeds context and persist receives the final result', async () => {
    const storage = {} as unknown as NonNullable<ReviewInput['memoryStorage']>;
    const run = await runGolden(
      makeInput({
        memoryStorage: storage,
        settings: makeSettings({ enableMemory: true }),
      }),
    );
    expect(persistReviewObservations).toHaveBeenCalledOnce();
    expect(run.golden).toMatchSnapshot();
  });

  it('exploitability + usage ON: trivy CVEs labeled in-place', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithCve());
    const run = await runGolden(
      makeInput({
        fileReader: async () => 'import _ from "lodash";\n',
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: forced degradation — 12 failedSteps.push sites', () => {
  it('blast-radius fails (:298): degraded metadata + PARTIAL', async () => {
    const run = await runGolden(
      makeInput({
        graphLoader: makeGraphLoader({
          load: vi.fn().mockRejectedValue(new Error('graph file not found')),
        }),
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.result.failedSteps).toEqual([
      { step: 'blast-radius', error: 'graph file not found' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('ai-enhance fails (:571): no console.warn, push + emit only', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (enhanceFindings as M<typeof enhanceFindings>).mockRejectedValueOnce(
      new Error('enhance model unavailable'),
    );
    const run = await runGolden(makeInput({ enhance: true }));
    expect(run.result.failedSteps).toEqual([
      { step: 'ai-enhance', error: 'enhance model unavailable' },
    ]);
    // Pin the asymmetry: this catch is the only push-site WITHOUT console.warn.
    expect(run.golden.warns).toEqual([]);
    expect(run.golden).toMatchSnapshot();
  });

  it('author-trust fails (:622): warn + push, mode not overridden', async () => {
    (computeAuthorTrustScore as M<typeof computeAuthorTrustScore>).mockRejectedValueOnce(
      new Error('git unavailable'),
    );
    const run = await runGolden(makeInput({ author: 'mallory', features: { authorTrust: true } }));
    expect(run.result.failedSteps).toEqual([{ step: 'author-trust', error: 'git unavailable' }]);
    expect(run.golden).toMatchSnapshot();
  });

  it('ai-review fails (:771): static-only result + NEEDS_HUMAN_REVIEW (no PARTIAL downgrade)', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (runSimpleReview as M<typeof runSimpleReview>).mockRejectedValueOnce(new Error('LLM exploded'));
    const run = await runGolden(makeInput());
    expect(run.result.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(run.result.failedSteps).toEqual([{ step: 'ai-review', error: 'LLM exploded' }]);
    expect(run.golden).toMatchSnapshot();
  });

  it('exploitability fails (:902): warn + push + emit', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithCve());
    (analyzeExploitability as M<typeof analyzeExploitability>).mockImplementationOnce(() => {
      throw new Error('exploit graph corrupt');
    });
    const run = await runGolden(makeInput({ settings: makeSettings({ enableBlastRadius: true }) }));
    expect(run.result.failedSteps).toEqual([
      { step: 'exploitability', error: 'exploit graph corrupt' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('recursive-review fails (:960): warn + push + emit', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (recursiveReview as M<typeof recursiveReview>).mockRejectedValueOnce(
      new Error('re-review loop crashed'),
    );
    const run = await runGolden(
      makeInput({ settings: makeSettings({ enableRecursiveReview: true }) }),
    );
    expect(run.result.failedSteps).toEqual([
      { step: 'recursive-review', error: 're-review loop crashed' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('doc-validation fails (:1010): warn + push + emit', async () => {
    (extractChangedSymbols as M<typeof extractChangedSymbols>).mockImplementationOnce(() => {
      throw new Error('symbol extraction blew up');
    });
    const run = await runGolden(
      makeInput({ settings: makeSettings({ enableDocValidation: true }) }),
    );
    expect(run.result.failedSteps).toEqual([
      { step: 'doc-validation', error: 'symbol extraction blew up' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('semantic-ranking fails (:1034): warn + push + emit, order untouched', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(
      staticWithTwoFindings(),
    );
    (rankFindings as M<typeof rankFindings>).mockRejectedValueOnce(
      new Error('embedding provider down'),
    );
    const run = await runGolden(makeInput({ embeddingProvider: FAKE_EMBED }));
    expect(run.result.failedSteps).toEqual([
      { step: 'semantic-ranking', error: 'embedding provider down' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('memory-persist fails (:1054): warn + push, no emit', async () => {
    (persistReviewObservations as M<typeof persistReviewObservations>).mockRejectedValueOnce(
      new Error('sqlite is locked'),
    );
    const run = await runGolden(
      makeInput({
        memoryStorage: {} as unknown as NonNullable<ReviewInput['memoryStorage']>,
        settings: makeSettings({ enableMemory: true }),
      }),
    );
    expect(run.result.failedSteps).toEqual([{ step: 'memory-persist', error: 'sqlite is locked' }]);
    expect(run.golden).toMatchSnapshot();
  });

  it('static-analysis fails (:1294): error result for all tools + PARTIAL', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockRejectedValueOnce(
      new Error('semgrep crashed'),
    );
    const run = await runGolden(makeInput());
    expect(run.result.failedSteps).toEqual([{ step: 'static-analysis', error: 'semgrep crashed' }]);
    expect(run.golden).toMatchSnapshot();
  });

  it('memory-search fails (:1334): warn + push, context null', async () => {
    (searchMemoryForContext as M<typeof searchMemoryForContext>).mockRejectedValueOnce(
      new Error('database connection failed'),
    );
    const run = await runGolden(
      makeInput({
        memoryStorage: {} as unknown as NonNullable<ReviewInput['memoryStorage']>,
        settings: makeSettings({ enableMemory: true }),
      }),
    );
    expect(run.result.failedSteps).toEqual([
      { step: 'memory-search', error: 'database connection failed' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('code-intel fails (:1410): only reachable via emit throwing on the success message', async () => {
    // The outer catch in queryCodeIntelSafe is UNREACHABLE through provider
    // failures (per-file rejections are swallowed by Promise.allSettled).
    // The only path into it is the emit callback itself throwing — pinned
    // here so the refactor preserves the catch (and its semantics) verbatim.
    const run = await runGolden(
      makeInput({
        codeIntelProvider: makeCodeIntelProvider(),
        settings: makeSettings({ enableCodeIntel: true }),
      }),
      {
        emitHook: (e) => {
          if (e.step === 'code-intel' && e.message.includes('files with structural data')) {
            throw new Error('forced code-intel emit failure');
          }
        },
      },
    );
    expect(run.result.failedSteps).toEqual([
      { step: 'code-intel', error: 'forced code-intel emit failure' },
    ]);
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: degradation WITHOUT failedSteps.push — 3 sites (do NOT uniformize)', () => {
  it('call-chain fails (:360): warn only, NO failedSteps entry, status PASSED', async () => {
    (buildCallChainFromDiff as M<typeof buildCallChainFromDiff>).mockImplementationOnce(() => {
      throw new Error('call-chain parser exploded');
    });
    const run = await runGolden(
      makeInput({
        fileReader: async () => 'export function helper() {}\n',
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.result.failedSteps).toBeUndefined();
    expect(run.result.status).toBe('PASSED');
    expect(run.golden.warns).toEqual([
      [
        '[ghagga] Call-chain/reverse-deps failed (degrading gracefully):',
        'call-chain parser exploded',
      ],
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('negative-examples fails (:430): warn only, NO failedSteps entry, status PASSED', async () => {
    const storage = makeFakeSqliteStorage({
      getNegativeExamplesForFile: () => {
        throw new Error('negative table missing');
      },
    });
    const run = await runGolden(makeInput({ memoryStorage: storage }));
    expect(run.result.failedSteps).toBeUndefined();
    expect(run.result.status).toBe('PASSED');
    expect(run.golden.warns).toEqual([
      ['[ghagga] Negative examples load failed (degrading gracefully):', 'negative table missing'],
    ]);
    expect(run.golden).toMatchSnapshot();
  });

  it('self-improve fails (:453): warn only, NO failedSteps entry, status PASSED', async () => {
    (loadFeedback as M<typeof loadFeedback>).mockRejectedValueOnce(
      new Error('feedback file unreadable'),
    );
    const run = await runGolden(
      makeInput({ settings: makeSettings({ selfImprovePath: '/fake/self-improve.json' }) }),
    );
    expect(run.result.failedSteps).toBeUndefined();
    expect(run.result.status).toBe('PASSED');
    expect(run.golden.warns).toEqual([
      [
        '[ghagga] Self-improve rules load failed (degrading gracefully):',
        'feedback file unreadable',
      ],
    ]);
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: kitchen-sink', () => {
  it('everything ON: pins the final findings order (enhance→exploit→recursive→doc→rank)', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithCve());
    (computeBlastRadius as M<typeof computeBlastRadius>).mockReturnValueOnce(BLAST_KEEP_BOTH);
    (runSimpleReview as M<typeof runSimpleReview>).mockResolvedValueOnce(
      makeAgentResult('simple', { findings: [aiFinding()] }),
    );
    (recursiveReview as M<typeof recursiveReview>).mockResolvedValueOnce(RECURSIVE_REPORT);
    (extractChangedSymbols as M<typeof extractChangedSymbols>).mockReturnValueOnce(['indexFn']);
    (scanDocsForSymbols as M<typeof scanDocsForSymbols>).mockReturnValueOnce({
      changedSymbols: ['indexFn'],
      staleReferences: [
        { file: 'docs/api.md', line: 10, symbol: 'indexFn', context: 'see indexFn()' },
      ],
      docsScanned: 2,
    });
    (loadFeedback as M<typeof loadFeedback>).mockResolvedValueOnce([
      {
        findingHash: 'h1',
        outcome: 'rejected',
        category: 'security',
        severity: 'high',
        modelUsed: 'test-model',
        recordedAt: '2024-01-01T00:00:00Z',
      },
    ]);
    (deriveRules as M<typeof deriveRules>).mockReturnValueOnce([{} as ImprovementRule]);
    (formatRulesForPrompt as M<typeof formatRulesForPrompt>).mockReturnValueOnce(
      '## Self-Improve Rules\n- Avoid flagging test fixtures.',
    );

    const storage = makeFakeSqliteStorage({
      getNegativeExamplesForFile: () => [NEG_EXAMPLE],
    });

    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        mode: 'workflow', // trusted author override → simple
        author: 'alice',
        enhance: true,
        features: { authorTrust: true },
        memoryStorage: storage,
        embeddingProvider: FAKE_EMBED,
        codeIntelProvider: makeCodeIntelProvider(),
        graphLoader: makeGraphLoader(),
        fileReader: async () => 'import "./index.js";\nexport function helper() {}\n',
        settings: makeSettings({
          enableMemory: true,
          enableBlastRadius: true,
          enableCodeIntel: true,
          enableRecursiveReview: true,
          enableDocValidation: true,
          checklist: { enabled: true, dimensions: [] },
          selfImprovePath: '/fake/self-improve.json',
        }),
      }),
    );

    expect(runSimpleReview).toHaveBeenCalledOnce();
    expect(runWorkflowReview).not.toHaveBeenCalled();
    expect(persistReviewObservations).toHaveBeenCalledOnce();
    expect(run.golden).toMatchSnapshot();
  });
});

// ─── B0.5 fixtures (review fix-forward) ─────────────────────────

/**
 * ⚠️ Load-bearing nuance (B0.5): [BLOCKED]/[REDACTED] are NOT driven by
 * settings.ignorePatterns. They come from the HARDCODED security tiers in
 * utils/path-protection.ts (ZERO_ACCESS_PATTERNS / REDACT_PATTERNS), applied
 * BEFORE user ignorePatterns (filterDiffFiles, utils/diff.ts:130-145).
 * `.env` → ZERO_ACCESS (blocked); `.env.example` → REDACT (checked FIRST,
 * path-protection.ts:139 — otherwise `.env.*` would block it). Redacted files
 * stay in `filtered` with content replaced by REDACTED_CONTENT.
 */
const PATH_PROTECTION_DIFF = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1,2 @@
 SECRET=old
+SECRET=new
diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@ -1 +1,2 @@
 SECRET=
+OTHER=
diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export default x;
`;

const GATEWAY_CHAIN_3: ProviderChainEntry[] = [
  { provider: 'gateway', model: 'model-a', apiKey: 'key-a', gatewayUrl: 'https://gw.test' },
  { provider: 'gateway', model: 'model-b', apiKey: 'key-b' },
  { provider: 'gateway', model: 'model-c', apiKey: 'key-c' },
];

const STALE_METADATA: GraphMetadata = {
  lastIndexedCommit: 'deadbeef',
  // NOTE: no milliseconds — '00:00:00.000Z' would trip GROUPED_NUMBER_RE
  // ('00.000' parses as a locale-grouped number) and mangle the emit string.
  lastIndexedAt: '2020-01-01T00:00:00Z',
  schemaVersion: 1,
  fileCount: 2,
  languages: ['typescript'],
  indexDurationMs: 5,
};

// ─── B0.5 tests — coverage holes from the 2vr review ────────────

describe('golden: providers — cli-bridge & providerChain (B0.5)', () => {
  it('cli-bridge simple via providerChain: opencode + cliModel resolve credentials', async () => {
    // Exercises resolveGenerateTextFns cli-bridge branch (pipeline.ts:1170-1195):
    // preferredCLI='opencode' (entry.model !== 'auto'), cliModel='openai/gpt-4o'
    // → resolveCredentialEnvVar → OPENAI_API_KEY ← decrypted entry apiKey.
    const run = await runGolden(
      makeInput({
        provider: 'cli-bridge',
        model: 'auto',
        apiKey: undefined,
        providerChain: [
          {
            provider: 'cli-bridge',
            model: 'opencode',
            cliModel: 'openai/gpt-4o',
            apiKey: 'cli-key',
          },
        ],
      }),
    );
    expect(runSimpleReview).toHaveBeenCalledOnce();
    expect(run.result.status).toBe('PASSED');
    expect(run.golden).toMatchSnapshot();
  });

  it('cli-bridge diagnostic (flat fields): mode-fallback pins the "CLI bridge" message', async () => {
    // Flat-field branch of the cli-bridge resolution (cliBridgeEntry undefined,
    // preferredCLI = input.model 'gemini' → GEMINI_API_KEY) + resolveEffectiveMode
    // diagnostic→simple (pipeline.ts:1256).
    const run = await runGolden(
      makeInput({ mode: 'diagnostic', provider: 'cli-bridge', model: 'gemini' }),
    );
    expect(runDiagnosticReview).not.toHaveBeenCalled();
    expect(runSimpleReview).toHaveBeenCalledOnce();
    expect(run.golden.events).toContainEqual({
      step: 'mode-fallback',
      message: 'Diagnostic mode not supported with CLI bridge — falling back to simple mode',
    });
    expect(run.golden).toMatchSnapshot();
  });

  it('consensus with 3-entry gateway chain: stance distribution + one generateFn per entry', async () => {
    // resolvePrimaryProvider takes chain[0]; buildConsensusModels N>=3 →
    // chain[0]→for, chain[1]→against, chain[2]→neutral (pipeline.ts:1116);
    // gateway branch maps ALL chain entries → 3 generateFns (pipeline.ts:1207).
    const run = await runGolden(makeInput({ mode: 'consensus', providerChain: GATEWAY_CHAIN_3 }));
    expect(runConsensusReview).toHaveBeenCalledOnce();
    const consensusArgs = (runConsensusReview as M<typeof runConsensusReview>).mock.calls[0]?.[0];
    expect(consensusArgs?.models).toEqual([
      { provider: 'gateway', model: 'model-a', apiKey: 'key-a', stance: 'for' },
      { provider: 'gateway', model: 'model-b', apiKey: 'key-b', stance: 'against' },
      { provider: 'gateway', model: 'model-c', apiKey: 'key-c', stance: 'neutral' },
    ]);
    expect(consensusArgs?.generateFns).toHaveLength(3);
    expect(run.golden).toMatchSnapshot();
  });

  it('consensus with 2-entry gateway chain: neutral wraps around to chain[0] (i % N)', async () => {
    const run = await runGolden(
      makeInput({ mode: 'consensus', providerChain: GATEWAY_CHAIN_3.slice(0, 2) }),
    );
    expect(runConsensusReview).toHaveBeenCalledOnce();
    const consensusArgs = (runConsensusReview as M<typeof runConsensusReview>).mock.calls[0]?.[0];
    expect(consensusArgs?.models).toEqual([
      { provider: 'gateway', model: 'model-a', apiKey: 'key-a', stance: 'for' },
      { provider: 'gateway', model: 'model-b', apiKey: 'key-b', stance: 'against' },
      { provider: 'gateway', model: 'model-a', apiKey: 'key-a', stance: 'neutral' },
    ]);
    expect(consensusArgs?.generateFns).toHaveLength(2);
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: validateInput throws (B0.5)', () => {
  it('empty diff: rejects with the exact message', async () => {
    await expect(reviewPipeline(makeInput({ diff: '' }))).rejects.toThrow(
      'Review input must include a non-empty diff',
    );
  });

  it('legacy provider (openai): rejects with the migration error', async () => {
    await expect(
      reviewPipeline(makeInput({ provider: 'openai' as unknown as LLMProvider })),
    ).rejects.toThrow(
      "Provider 'openai' is no longer supported directly. " +
        "Set provider: 'gateway' and configure credentials in mcp-llm-bridge. " +
        'See docs/configuration.md#gateway-mode-mcp-llm-bridge',
    );
  });
});

describe('golden: path-protection tiers (B0.5)', () => {
  it('blocked (.env) + redacted (.env.example): emits + parse-diff counts pinned', async () => {
    // NOTE: review assumed ignorePatterns of type block/redact — WRONG. These
    // tiers are hardcoded in path-protection.ts and non-overridable. No
    // ignorePatterns needed to trigger them (see PATH_PROTECTION_DIFF docblock).
    const run = await runGolden(makeInput({ diff: PATH_PROTECTION_DIFF }));
    expect(run.golden.events).toContainEqual({
      step: 'path-protection',
      message: 'Blocked 1 sensitive file(s) from review',
      detail: '  [BLOCKED] .env',
    });
    expect(run.golden.events).toContainEqual({
      step: 'path-protection',
      message: 'Redacted 1 file(s) — paths visible, content hidden',
      detail: '  [REDACTED] .env.example',
    });
    expect(run.golden.events).toContainEqual(
      expect.objectContaining({
        step: 'parse-diff',
        message: 'Parsed 3 files from diff, 2 after filtering (1 blocked, 1 redacted)',
      }),
    );
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: chained multi-degradation (B0.5)', () => {
  it('blast-radius + memory-search + semantic-ranking fail together: failedSteps ORDER pinned', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(
      staticWithTwoFindings(),
    );
    (searchMemoryForContext as M<typeof searchMemoryForContext>).mockRejectedValueOnce(
      new Error('database connection failed'),
    );
    (rankFindings as M<typeof rankFindings>).mockRejectedValueOnce(
      new Error('embedding provider down'),
    );
    const run = await runGolden(
      makeInput({
        graphLoader: makeGraphLoader({
          load: vi.fn().mockRejectedValue(new Error('graph file not found')),
        }),
        memoryStorage: {} as unknown as NonNullable<ReviewInput['memoryStorage']>,
        embeddingProvider: FAKE_EMBED,
        settings: makeSettings({ enableBlastRadius: true, enableMemory: true }),
      }),
    );
    // Order is load-bearing: blast-radius pushes at Step 2.5 (sequential),
    // memory-search inside the Step 5 Promise.all, semantic-ranking at Step 7.8.
    expect(run.result.failedSteps).toEqual([
      { step: 'blast-radius', error: 'graph file not found' },
      { step: 'memory-search', error: 'database connection failed' },
      { step: 'semantic-ranking', error: 'embedding provider down' },
    ]);
    expect(run.result.status).toBe('PARTIAL');
    expect(run.golden).toMatchSnapshot();
  });
});

describe('golden: blast-radius edges (B0.5)', () => {
  it('stale graph: emits staleness warning + metadata.blastRadius.graphStale=true', async () => {
    (computeBlastRadius as M<typeof computeBlastRadius>).mockReturnValueOnce(BLAST_KEEP_INDEX_ONLY);
    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        graphLoader: makeGraphLoader({
          loadMetadata: vi.fn().mockResolvedValue(STALE_METADATA),
        }),
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.golden.events).toContainEqual({
      step: 'blast-radius',
      message: 'Dependency graph is stale (last indexed: 2020-01-01T00:00:00Z)',
    });
    expect(run.result.metadata.blastRadius?.graphStale).toBe(true);
    expect(run.golden).toMatchSnapshot();
  });

  it('enableBlastRadius without graphLoader: block 2.5 skipped entirely, call-chain 2.6 still runs', async () => {
    // Gating verified in pipeline.ts: Step 2.5 requires enableBlastRadius AND
    // input.graphLoader (:233); Step 2.6 only requires enableBlastRadius (:315)
    // plus a fileReader inside. No blast-radius events, no metadata.blastRadius.
    (buildCallChainFromDiff as M<typeof buildCallChainFromDiff>).mockReturnValueOnce({
      changedSymbols: [{ filePath: 'src/index.ts', symbolName: 'indexFn', kind: 'function' }],
      affectedSymbols: [{ filePath: 'src/index.ts', symbolName: 'indexFn', kind: 'function' }],
      callChainGraph: { nodes: [], edges: [] },
      depth: 1,
    });
    const run = await runGolden(
      makeInput({
        diff: TWO_FILE_DIFF,
        fileReader: async () => 'export function indexFn() {}\n',
        settings: makeSettings({ enableBlastRadius: true }),
      }),
    );
    expect(run.golden.events.filter((e) => e.step === 'blast-radius')).toEqual([]);
    expect(run.golden.events.some((e) => e.step === 'call-chain')).toBe(true);
    expect(run.result.metadata.blastRadius).toBeUndefined();
    expect(run.golden).toMatchSnapshot();
  });
});

// ─── Identity asserts (B4) ──────────────────────────────────────
// The phase split threads ONE mutable `state.result` object end-to-end
// (D1: no Partial-merge, no clones). These asserts pin that identity
// through OBSERVABLE references only — objects returned by the mocks —
// without exposing any production internals.
// NOT pinnable non-invasively: `result.failedSteps === <internal
// accumulator>` — the accumulator is function-local to reviewPipeline
// and has no external handle; covered indirectly by the first assert
// (finalize attaches it onto the very object the caller receives).

describe('identity: result object is threaded, never cloned (B4)', () => {
  it('returns the very ReviewResult object the agent produced (mutated in-place)', async () => {
    const agentResult = makeAgentResult('simple');
    (runSimpleReview as M<typeof runSimpleReview>).mockResolvedValueOnce(agentResult);
    const { result } = await runGolden(makeInput());
    expect(result).toBe(agentResult);
    // ...and enrich really mutated THIS object in-place (step-7 merge ran on it)
    expect(result.metadata.fileList).toEqual(['src/index.ts']);
  });

  it('result.staticAnalysis is the same object the static runner produced', async () => {
    const staticResult = staticWithSemgrep();
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticResult);
    const { result } = await runGolden(makeInput());
    expect(result.staticAnalysis).toBe(staticResult);
  });

  it('result.recursiveReview is the same report object recursiveReview returned', async () => {
    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockResolvedValueOnce(staticWithSemgrep());
    (recursiveReview as M<typeof recursiveReview>).mockResolvedValueOnce(RECURSIVE_REPORT);
    const { result } = await runGolden(
      makeInput({ settings: makeSettings({ enableRecursiveReview: true }) }),
    );
    expect(result.recursiveReview).toBe(RECURSIVE_REPORT);
  });
});

// ─── Trio parallelism (B5) ──────────────────────────────────────
// R-orden: the step-5 trio (static analysis ∥ memory search ∥ code-intel)
// MUST stay a single Promise.all — all three start before any resolves.
// Each leg records its start and then awaits a shared gate that only opens
// after the assertion; if the trio were sequentialized, the first leg
// would block the others from starting and vi.waitFor would time out.

describe('ordering: step-5 trio runs in one Promise.all (B5)', () => {
  it('static-analysis, memory-search and code-intel all start before any resolves', async () => {
    const started: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    (runStaticAnalysis as M<typeof runStaticAnalysis>).mockImplementationOnce(async () => {
      started.push('static-analysis');
      await gate;
      return SKIPPED_STATIC();
    });
    (searchMemoryForContext as M<typeof searchMemoryForContext>).mockImplementationOnce(
      async () => {
        started.push('memory-search');
        await gate;
        return 'Past review: watch the parser.';
      },
    );
    const gatedProvider: CodeIntelProvider = {
      ...makeCodeIntelProvider(),
      getFileImports: async () => {
        started.push('code-intel');
        await gate;
        return ['./utils.js'];
      },
    };

    const resultPromise = reviewPipeline(
      makeInput({
        memoryStorage: {} as unknown as NonNullable<ReviewInput['memoryStorage']>,
        settings: makeSettings({ enableMemory: true, enableCodeIntel: true }),
        codeIntelProvider: gatedProvider,
      }),
    );

    try {
      await vi.waitFor(() => expect(started).toHaveLength(3));
      // All three in-flight simultaneously — none has resolved (gate closed).
      expect(new Set(started)).toEqual(new Set(['static-analysis', 'memory-search', 'code-intel']));
    } finally {
      release();
    }
    await resultPromise;
  });
});

// Deferred coverage (explicitly out of B0.5 scope, per review reconciliation):
//   - #8 registry-enabled skipped result (isToolRegistryEnabled=true path /
//     dynamic skipped-result keys from toolRegistry.getAll).
//   - #9 truncateDiff actually truncating (diff > token budget → wasTruncated
//     branch + '[... diff truncated ...]' marker in the agent input).
