/**
 * Graph-context eval corpus (graph-context-retrieval T4.4).
 *
 * Six fixture cases under `test/fixtures/graph-context/<case>/` spanning
 * the degradation ladder:
 *
 *   fresh-exact-multi-file — exact-commit graph, 2 changed files in graph
 *   not-exact-fresh        — graph fresh but indexed at another commit
 *   stale-7d               — graph older than the 7-day tolerance
 *   no-graph               — no graph loaded
 *   symbol-sparse-python   — regex-extracted Python (no importSymbols)
 *   oversize-refused       — loader refuses (>MAX_GRAPH_SIZE_BYTES) → null
 *
 * CI is model-free/network-free/deterministic: the corpus asserts the
 * assembled context SHAPE (files/symbols present, freshness tier,
 * truncation markers, skippedReason) and the PROMPT BYTES (on vs off).
 * Findings quality is NOT asserted here — it rides the golden suites'
 * prompt determinism plus the documented out-of-band model run.
 *
 * Fixture maintenance: run with GHAGGA_REGEN_GRAPH_CONTEXT_CORPUS=1 to
 * (re)write expected-context.json / expected-prompt-{off,on}.txt, then
 * review the diff like any golden. The clock is FAKED to 2026-11-10 so the
 * staleness fixtures never rot.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GRAPH_NEIGHBORHOOD_UNTRUSTED_LABEL } from './agents/prompts.js';
import { runSimpleReview } from './agents/simple.js';
import type { DependencyGraph, GraphMetadata } from './graph/schema.js';
import { gatherGraphContextSafe } from './pipeline/gather-safe.js';
import type { GenerateTextFn } from './providers/generate-fn.js';
import type { GraphContextMetadata, ReviewInput } from './types.js';

// ─── Fixture loading ────────────────────────────────────────────

const CORPUS_DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'graph-context');

/** The frozen "now" the staleness fixtures are authored against. */
const FROZEN_NOW = new Date('2026-11-10T00:00:00Z');

interface CaseConfig {
  currentHead: string | null;
  enableGraphContext: boolean;
  /** Harness flag: loader refuses the graph (oversize path) → load() null. */
  simulateOversize?: boolean;
}

interface CorpusCase {
  name: string;
  diff: string;
  graph: DependencyGraph | undefined;
  metadata: GraphMetadata | null;
  config: CaseConfig;
  fileList: string[];
}

function readJson<T>(caseDir: string, file: string): T {
  return JSON.parse(readFileSync(join(caseDir, file), 'utf-8')) as T;
}

function parseDiffFilePaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

function loadCorpusCases(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  for (const name of readdirSync(CORPUS_DIR).sort()) {
    const caseDir = join(CORPUS_DIR, name);
    if (!existsSync(join(caseDir, 'diff.patch'))) continue;
    const diff = readFileSync(join(caseDir, 'diff.patch'), 'utf-8');
    const config = readJson<CaseConfig>(caseDir, 'case.json');
    const hasGraph = existsSync(join(caseDir, 'graph.json'));
    const graph = hasGraph
      ? (readJson<DependencyGraph>(caseDir, 'graph.json') as DependencyGraph)
      : undefined;
    const metadata = readJson<GraphMetadata>(caseDir, 'metadata.json');
    cases.push({
      name,
      diff,
      graph: config.simulateOversize ? undefined : graph,
      metadata,
      config,
      fileList: parseDiffFilePaths(diff),
    });
  }
  return cases;
}

// ─── Corpus execution (wiring + formatter + prompt bytes) ───────

function makeInputFor(c: CorpusCase): ReviewInput {
  return {
    diff: c.diff,
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'k',
    settings: {
      enableSemgrep: false,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'normal',
      enableGraphContext: c.config.enableGraphContext,
    },
    context: { repoFullName: 'corpus/repo', prNumber: 1, commitMessages: [], fileList: [] },
    ...(c.config.currentHead ? { currentHead: c.config.currentHead } : {}),
  };
}

async function assemble(
  c: CorpusCase,
): Promise<{ context: string; metadata?: GraphContextMetadata }> {
  return gatherGraphContextSafe(makeInputFor(c), c.fileList, c.graph, c.metadata, () => {}, []);
}

async function captureSimpleSystemPrompt(
  diff: string,
  graphNeighborhoodContext: string,
): Promise<string> {
  let captured = '';
  const generateFn: GenerateTextFn = async (system) => {
    captured = system;
    return {
      text: 'STATUS: PASSED\nSUMMARY: ok.\nFINDINGS:\n',
      tokensUsed: 1,
      provider: 'gateway',
      model: 'auto',
    };
  };
  await runSimpleReview({
    diff,
    provider: 'gateway',
    model: 'auto',
    apiKey: 'k',
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    reviewLevel: 'normal',
    generateFn,
    graphNeighborhoodContext,
    // review-output-compression: the corpus pins the graph-context delta
    // in isolation — the expected-prompt-*.txt fixtures were authored with
    // compression OFF (pre-feature bytes), so the capture stays pinned to
    // the explicit-false path. The calibration block's own on/off contract
    // lives in the agents/* suites.
    compressOutput: false,
  });
  return captured;
}

const REGEN = process.env.GHAGGA_REGEN_GRAPH_CONTEXT_CORPUS === '1';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('graph-context eval corpus', () => {
  const cases = loadCorpusCases();

  it('corpus has the seven ladder cases', () => {
    expect(cases.map((c) => c.name)).toEqual([
      'budget-cut-ranked',
      'fresh-exact-multi-file',
      'no-graph',
      'not-exact-fresh',
      'oversize-refused',
      'stale-7d',
      'symbol-sparse-python',
    ]);
  });

  for (const c of cases) {
    describe(`case: ${c.name}`, () => {
      const caseDir = join(CORPUS_DIR, c.name);

      it('assembled context matches the expected shape', async () => {
        const outcome = await assemble(c);

        const expectedPath = join(caseDir, 'expected-context.json');
        if (REGEN) {
          writeFileSync(expectedPath, `${JSON.stringify(outcome, null, 2)}\n`);
        }
        const expected = readJson<{
          context: string;
          metadata?: GraphContextMetadata;
        }>(caseDir, 'expected-context.json');

        // SHAPE assertions (context is asserted byte-exactly below via the
        // prompt; here the structure is pinned per the corpus contract).
        expect(outcome.context).toBe(expected.context);
        expect(outcome.metadata).toEqual(expected.metadata);
      });

      it('prompt bytes match expected-prompt-off/on (degraded cases: on === off)', async () => {
        const { context } = await assemble(c);
        const onSystem = await captureSimpleSystemPrompt(c.diff, context);
        const offSystem = await captureSimpleSystemPrompt(c.diff, '');

        const offPath = join(caseDir, 'expected-prompt-off.txt');
        const onPath = join(caseDir, 'expected-prompt-on.txt');
        if (REGEN) {
          writeFileSync(offPath, offSystem);
          writeFileSync(onPath, onSystem);
        }

        expect(offSystem).toBe(readFileSync(offPath, 'utf-8'));
        expect(onSystem).toBe(readFileSync(onPath, 'utf-8'));

        // Degraded ladder rungs MUST be byte-stable: no section at all.
        if (!context) {
          expect(onSystem).toBe(offSystem);
          expect(onSystem).not.toContain('Graph Neighborhood');
        } else {
          expect(onSystem).not.toBe(offSystem);
          expect(onSystem.match(/## Graph Neighborhood/g)).toHaveLength(1);
          expect(onSystem).toContain(GRAPH_NEIGHBORHOOD_UNTRUSTED_LABEL);
        }
      });
    });
  }

  // Pin ladder semantics the generic rows cannot express:
  it('fresh-exact renders importer/importee paths AND symbols', async () => {
    const fresh = cases.find((c) => c.name === 'fresh-exact-multi-file');
    const { context } = await assemble(fresh as CorpusCase);
    expect(context).toContain('src/api.ts');
    expect(context).toContain('src/util.ts');
    expect(context).toContain('src/client.ts'); // importer
    expect(context).toContain('src/other.ts'); // importee
    expect(context).toContain('helper'); // exported symbol
  });

  it('not-exact-fresh renders file-level only — NO symbol names', async () => {
    const notFresh = cases.find((c) => c.name === 'not-exact-fresh');
    const { context, metadata } = await assemble(notFresh as CorpusCase);
    expect(metadata?.freshness).toBe('file-level');
    expect(context).toContain('src/api.ts');
    expect(context).toContain('older commit');
    expect(context).not.toContain('helper');
  });

  it('stale-7d skips entirely with skippedReason', async () => {
    const stale = cases.find((c) => c.name === 'stale-7d');
    const { context, metadata } = await assemble(stale as CorpusCase);
    expect(context).toBe('');
    expect(metadata?.skippedReason).toBe('stale-graph');
  });

  it('symbol-sparse python renders imports/exports, no placeholder symbols', async () => {
    const py = cases.find((c) => c.name === 'symbol-sparse-python');
    const { context } = await assemble(py as CorpusCase);
    expect(context).toContain('src/lib.py');
    expect(context).toContain('src/cli.py');
    expect(context).toContain('main'); // exports only
    expect(context).not.toContain('symbol-named');
  });

  // ─── budget-cut-ranked (context-hybrid-ranking T2.2) ────────────
  //
  // 11 changed files at the DEFAULT 1,200-token budget (~7,000 rendered
  // chars vs the 4,800 cap). Cast by intent: filler-a FIRST in diff order
  // with zero lexical signal (comment-only hunk); fillers b..i each
  // declare a symbol (fvarX); hub has 10 importers but zero lexical;
  // ranker LAST in diff order with both exports called from filler-i's
  // hunk. Scores per neighborhood-rank.ts (importers capped at 10): every
  // file's w1 is 36 — own path PLUS importer/importee paths, and every
  // neighbor here is itself a changed file, so all 12 overlapping path
  // tokens hit the diff (edges.ts, the one unchanged graph node, never
  // appears in the diff text). The spread rides w2 and the hub bonus:
  // ranker 46 (w2 = 10, rankerMain + rankerHelper both called; NO hub
  // bonus — nothing imports ranker), fillers b..i 42 (w2 = 5 for fvarX
  // + 1 hub bonus — importers hit the 10 cap), filler-a and hub 37 (w2 =
  // 0 + 1 hub bonus; the 37-tie keeps diff order, filler-a before hub).
  // Expected ranked order: ranker, then the fvar-declaring fillers in
  // diff order, then filler-a, then hub — the cut keeps the top 7 and
  // drops filler-h/i, filler-a, hub.
  describe('case: budget-cut-ranked survival under the DEFAULT budget', () => {
    const cut = () => cases.find((c) => c.name === 'budget-cut-ranked') as CorpusCase;
    const DEFAULT_BUDGET_CHARS = 1_200 * 4;

    it('drops filler-a (first in diff) and keeps ranker.ts (last in diff) — relevance beats position', async () => {
      const { context, metadata } = await assemble(cut());
      expect(metadata?.filesCovered).toBe(7);
      expect(metadata?.truncatedFiles).toBe(4);

      // (a) filler-a is NOT rendered despite being first in diff order.
      expect(context).not.toContain('- src/filler-a.ts');
      // (b) ranker IS rendered despite being last in diff order.
      expect(context).toContain('- src/ranker.ts');
    });

    it('renders score-desc with stable ties — ranker first, then decl-fillers in diff order', async () => {
      const { context } = await assemble(cut());
      const order = [
        'src/ranker.ts', // 46 — w2 = 10 (both exports called cross-file), no hub bonus
        'src/filler-b.ts', // 42 — ties keep diff order
        'src/filler-c.ts',
        'src/filler-d.ts',
        'src/filler-e.ts',
        'src/filler-f.ts',
        'src/filler-g.ts', // 7th entry — the budget cut lands here
      ];
      let prev = -1;
      for (const file of order) {
        const at = context.indexOf(`- ${file}`);
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeGreaterThan(prev);
        prev = at;
      }
      // The dropped tail never renders.
      for (const file of ['src/filler-h.ts', 'src/filler-i.ts', 'src/hub.ts']) {
        expect(context).not.toContain(`- ${file}`);
      }
    });

    it('truncation notice counts match the drop, and rendered bytes respect the cap', async () => {
      const { context, metadata } = await assemble(cut());
      expect(context).toContain('_(graph neighborhood truncated to fit 1200-token budget');
      expect(context).toMatch(/7 of 11 file\(s\) shown/);
      expect(context.length).toBeLessThanOrEqual(DEFAULT_BUDGET_CHARS);
      expect(metadata?.truncatedFiles).toBe(4);
    });

    it('metadata reports rankingMode lexical (ranker ran before the cut)', async () => {
      const { metadata } = await assemble(cut());
      expect(metadata?.rankingMode).toBe('lexical');
      expect(metadata?.freshness).toBe('exact');
    });

    it('repeated assembly is byte-identical (determinism)', async () => {
      const first = await assemble(cut());
      const second = await assemble(cut());
      expect(second.context).toBe(first.context);
      expect(second.metadata).toEqual(first.metadata);
    });
  });
});
