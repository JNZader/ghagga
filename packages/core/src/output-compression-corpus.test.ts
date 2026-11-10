/**
 * Output-compression parser-parity corpus (review-output-compression T3.2).
 *
 * Fixture cases under `test/fixtures/output-compression/<case>/`, authored
 * in pairs (verbose vs compressed styles of the SAME findings):
 *
 *   fresh-exact-multi-file — 2 findings, numeric lines (TS backdrop)
 *   not-exact-fresh        — 1 finding, LINE: N/A (line-less path)
 *   symbol-sparse-python   — 1 finding, numeric line (Python backdrop)
 *   consensus-decision     — DECISION/CONFIDENCE/REASONING pair
 *   refuter-verdicts       — terse `<id>: stands|refute` (single style —
 *                            proves the terse format needs no calibration)
 *
 * CI is model-free/network-free/deterministic: BOTH styles must parse
 * through the UNTOUCHED parsers to identical structural fingerprints —
 * compression may only shrink prose, never lose or move a finding. The
 * pairs are authored, so any asymmetry is a real bug: a zero-findings
 * parse in EITHER style fails loudly.
 *
 * Render-parity row: compressed-style fields with **bold** must pass
 * through the comment formatter with bold intact (sanitize.ts passes `*`
 * and `|`; the comment-formatting spec is untouched by this change).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVote } from './agents/consensus.js';
import { parseRefuterVerdicts } from './agents/fan-out-lenses.js';
import { parseFindingsBlock } from './agents/simple.js';
import { formatReviewComment } from './format.js';
import type { ReviewFinding, ReviewResult } from './types.js';

// ─── Fixture loading ────────────────────────────────────────────

const CORPUS_DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'output-compression');

function readCorpusFile(caseName: string, file: string): string {
  return readFileSync(join(CORPUS_DIR, caseName, file), 'utf-8');
}

function readJson<T>(caseName: string, file: string): T {
  return JSON.parse(readCorpusFile(caseName, file)) as T;
}

interface ExpectedFinding {
  severity: string;
  category: string;
  file: string;
  line: number | null;
}

/** Structural fingerprint — the fields compression MUST NOT change. */
function fingerprint(findings: ReviewFinding[]): ExpectedFinding[] {
  return findings.map((f) => ({
    severity: f.severity,
    category: f.category,
    file: f.file,
    line: f.line ?? null,
  }));
}

const FINDING_CASES = ['fresh-exact-multi-file', 'not-exact-fresh', 'symbol-sparse-python'];

// ─── Tests ──────────────────────────────────────────────────────

describe('output-compression parser-parity corpus', () => {
  it('corpus has the five authored cases', () => {
    expect(readdirSync(CORPUS_DIR).sort()).toEqual([
      'consensus-decision',
      'fresh-exact-multi-file',
      'not-exact-fresh',
      'refuter-verdicts',
      'symbol-sparse-python',
    ]);
  });

  for (const caseName of FINDING_CASES) {
    describe(`findings case: ${caseName}`, () => {
      const verbose = parseFindingsBlock(readCorpusFile(caseName, 'findings-verbose.txt'));
      const compressed = parseFindingsBlock(readCorpusFile(caseName, 'findings-compressed.txt'));
      const expected = readJson<ExpectedFinding[]>(caseName, 'expected-findings.json');

      it('both styles parse to the identical structural fingerprint (no finding lost or moved)', () => {
        // Authored pairs — a zero-findings parse in EITHER style is a real
        // bug (silent-drop path), so the count assert fails loudly.
        expect(verbose.length).toBeGreaterThan(0);
        expect(compressed.length).toBeGreaterThan(0);
        expect(fingerprint(compressed)).toEqual(fingerprint(verbose));
      });

      it('the shared fingerprint matches expected-findings.json', () => {
        expect(fingerprint(verbose)).toEqual(expected);
      });

      it('both styles keep MESSAGE and SUGGESTION non-empty', () => {
        for (const f of [...verbose, ...compressed]) {
          expect(f.message?.trim().length ?? 0).toBeGreaterThan(0);
          expect(f.suggestion?.trim().length ?? 0).toBeGreaterThan(0);
        }
      });

      it('compressed style is genuinely compressed: one-line prose fields with bold key terms', () => {
        for (const f of compressed) {
          expect(f.message).not.toContain('\n');
          expect(f.suggestion).not.toContain('\n');
          expect(f.message).toContain('**');
        }
      });
    });
  }

  describe('consensus case: consensus-decision', () => {
    const verbose = parseVote(
      readCorpusFile('consensus-decision', 'decision-verbose.txt'),
      'gateway',
      'test-model',
      'for',
    );
    const compressed = parseVote(
      readCorpusFile('consensus-decision', 'decision-compressed.txt'),
      'gateway',
      'test-model',
      'for',
    );

    it('both styles yield the identical DECISION and CONFIDENCE', () => {
      expect(compressed.decision).toBe(verbose.decision);
      expect(compressed.confidence).toBeCloseTo(verbose.confidence, 5);
    });

    it('the decision matches expected-decision.json (compressed REASONING keeps bold)', () => {
      const expected = readJson<{ decision: string; confidence: number }>(
        'consensus-decision',
        'expected-decision.json',
      );
      expect(verbose.decision).toBe(expected.decision);
      expect(verbose.confidence).toBeCloseTo(expected.confidence, 5);
      expect(compressed.reasoning).toContain('**');
      expect(verbose.reasoning.length).toBeGreaterThan(compressed.reasoning.length);
    });
  });

  describe('refuter case: refuter-verdicts (terse format needs no calibration)', () => {
    it('the terse verdict parser reads the authored verdicts exactly', () => {
      const verdicts = parseRefuterVerdicts(readCorpusFile('refuter-verdicts', 'refuter.txt'));
      const expected = readJson<Record<string, 'stands' | 'refute'>>(
        'refuter-verdicts',
        'expected-verdicts.json',
      );
      expect(Object.fromEntries(verdicts)).toEqual(expected);
      expect(verdicts.size).toBe(3);
    });
  });

  describe('render parity: compressed bold survives the comment formatter', () => {
    it('formatReviewComment renders **bold** MESSAGE text with the bold intact', () => {
      const compressed = parseFindingsBlock(
        readCorpusFile('fresh-exact-multi-file', 'findings-compressed.txt'),
      );
      const result: ReviewResult = {
        status: 'FAILED',
        summary: 'Compressed-style fixture render.',
        findings: compressed,
        staticAnalysis: {
          semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
          trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
          cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
        },
        memoryContext: null,
        metadata: {
          mode: 'simple',
          provider: 'cli-bridge',
          model: 'claude-sonnet-4-20250514',
          tokensUsed: 1000,
          executionTimeMs: 100,
          toolsRun: [],
          toolsSkipped: [],
        },
      };

      const comment = formatReviewComment(result);
      expect(comment).toContain('**Unused import**');
      expect(comment).toContain('**Duplicated helper**');
      // Pipes inside prose would break the findings table — the compressed
      // style must not have introduced any.
      expect(compressed.every((f) => !f.message?.includes('|'))).toBe(true);
    });
  });
});
