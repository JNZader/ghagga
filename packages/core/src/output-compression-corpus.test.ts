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
 *   diagnostic-hypotheses  — HYPOTHESIS H1/H2 pair through parseHypotheses
 *                            (REL-002: diagnostic voice had zero fixtures)
 *   status-summary         — STATUS/SUMMARY pair through parseReviewResponse's
 *                            structured branch (REL-002: multi-line verbose
 *                            summary vs one-line compressed summary)
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
import { parseHypotheses } from './agents/diagnostic.js';
import { parseRefuterVerdicts } from './agents/fan-out-lenses.js';
import { parseFindingsBlock, parseReviewResponse } from './agents/simple.js';
import { formatReviewComment } from './format.js';
import type { Hypothesis, ReviewFinding, ReviewResult } from './types.js';

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

interface ExpectedHypothesis {
  id: string;
  confidence: string;
  relatedFiles: string[];
}

/** Structural fingerprint — the fields compression MUST NOT change. */
function hypothesisFingerprint(hypotheses: Hypothesis[]): ExpectedHypothesis[] {
  return hypotheses.map((h) => ({
    id: h.id,
    confidence: h.confidence,
    relatedFiles: h.relatedFiles,
  }));
}

// ─── Tests ──────────────────────────────────────────────────────

describe('output-compression parser-parity corpus', () => {
  it('corpus has the seven authored cases', () => {
    expect(readdirSync(CORPUS_DIR).sort()).toEqual([
      'consensus-decision',
      'diagnostic-hypotheses',
      'fresh-exact-multi-file',
      'not-exact-fresh',
      'refuter-verdicts',
      'status-summary',
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

  describe('hypotheses case: diagnostic-hypotheses', () => {
    const verbose = parseHypotheses(
      readCorpusFile('diagnostic-hypotheses', 'hypotheses-verbose.txt'),
    );
    const compressed = parseHypotheses(
      readCorpusFile('diagnostic-hypotheses', 'hypotheses-compressed.txt'),
    );
    const expected = readJson<ExpectedHypothesis[]>(
      'diagnostic-hypotheses',
      'expected-hypotheses.json',
    );

    it('both styles parse to the identical structural fingerprint (no hypothesis lost, demoted, or reordered)', () => {
      // Authored pair — a zero-hypotheses parse in EITHER style is a real bug
      // (silent-drop path), so the count assert fails loudly.
      expect(verbose.length).toBeGreaterThan(0);
      expect(compressed.length).toBeGreaterThan(0);
      expect(hypothesisFingerprint(compressed)).toEqual(hypothesisFingerprint(verbose));
    });

    it('the shared fingerprint matches expected-hypotheses.json', () => {
      expect(hypothesisFingerprint(verbose)).toEqual(expected);
    });

    it('both styles keep TITLE, CONDITIONS and VERIFICATION non-empty', () => {
      for (const h of [...verbose, ...compressed]) {
        expect(h.title.trim().length).toBeGreaterThan(0);
        expect(h.conditions.trim().length).toBeGreaterThan(0);
        expect(h.verification.trim().length).toBeGreaterThan(0);
      }
    });

    it('compressed style is genuinely compressed: one-line prose fields with bold key terms', () => {
      for (const h of compressed) {
        expect(h.conditions).not.toContain('\n');
        expect(h.verification).not.toContain('\n');
        expect(h.conditions).toContain('**');
      }
      // Compression evidence, per hypothesis (matched by id — order already
      // pinned by the fingerprint assert above).
      for (const h of compressed) {
        const counterpart = verbose.find((v) => v.id === h.id);
        expect(counterpart).toBeDefined();
        expect(counterpart!.conditions.length).toBeGreaterThan(h.conditions.length);
        expect(counterpart!.verification.length).toBeGreaterThan(h.verification.length);
      }
    });
  });

  describe('status-summary case: status-summary', () => {
    const parse = (file: string) =>
      parseReviewResponse(
        readCorpusFile('status-summary', file),
        'ollama',
        'test-model',
        0,
        0,
        null,
      );
    const verbose = parse('status-verbose.txt');
    const compressed = parse('status-compressed.txt');
    const expected = readJson<{
      status: string;
      verboseSummary: string;
      compressedSummary: string;
    }>('status-summary', 'expected-status-summary.json');

    it('both styles yield the identical STATUS and findings fingerprint', () => {
      expect(compressed.status).toBe(verbose.status);
      expect(compressed.status).toBe(expected.status);
      expect(fingerprint(compressed.findings)).toEqual(fingerprint(verbose.findings));
    });

    it('the structured SUMMARY branch parses both styles exactly (no raw-text fallback)', () => {
      // Pinning the exact parsed strings proves the SUMMARY regex captured the
      // verbose MULTI-LINE summary and the compressed ONE-LINE summary through
      // the structured branch — the fallback path would return the raw text.
      expect(verbose.summary).toBe(expected.verboseSummary);
      expect(compressed.summary).toBe(expected.compressedSummary);
    });

    it('compressed summary is one line with bold key terms, shorter than verbose', () => {
      expect(compressed.summary).not.toContain('\n');
      expect(compressed.summary).toContain('**');
      expect(compressed.summary.length).toBeLessThan(verbose.summary.length);
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
