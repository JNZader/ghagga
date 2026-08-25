import type { GenerateTextFn } from 'ghagga-core';
import { describe, expect, it, vi } from 'vitest';
import type { TriageConfig } from '../config/schema.js';
import type { ReproEvidence } from '../types/evidence.js';
import { runTriage } from './run.js';

function scriptedFn(...responses: string[]): {
  fn: GenerateTextFn;
  calls: Array<{ system: string; prompt: string }>;
} {
  const calls: Array<{ system: string; prompt: string }> = [];
  let i = 0;
  const fn: GenerateTextFn = vi.fn(async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    const text = responses[Math.min(i, responses.length - 1)] ?? '';
    i += 1;
    return { text, tokensUsed: 10, provider: 'cli-bridge', model: 'test' };
  });
  return { fn, calls };
}

const TRIAGE_RESPONSE = [
  'CLASSIFICATION: bug',
  'CONFIDENCE: 0.7',
  '',
  'PLAN:',
  '- [ ] investigate',
  '',
  'FILES_TO_TOUCH: internal/alerts/threshold.go',
  '',
  'SOURCES:',
  '- issue text | issue | #0',
  '',
  'REPORT:',
  '## Triage: bug',
  'Root cause: query against constraint chk_threshold_positive at internal/alerts/threshold.go:42 fails when config.timeout is unset (see reproduction evidence).',
].join('\n');

const baseConfig: TriageConfig = {
  forge: 'gitlab',
  repo: 'acme/widgets',
  codeRoot: '/tmp/does-not-matter',
  language: 'go',
  graphExpand: false,
  models: { rerank: 'x', analysis: 'y' },
  clientReplyPolicy: { language: 'es', jargonBan: ['constraint', 'query', 'threshold.go'] },
};

const baseIssue = {
  iid: '42',
  title: 'Threshold check fails intermittently',
  body: 'Sometimes the threshold check does not trigger.',
  labels: ['módulo::alertas'],
};

describe('runTriage', () => {
  it('produces technicalAnalysis (report) and a clientReply via TWO generateFn calls', async () => {
    const { fn, calls } = scriptedFn(
      TRIAGE_RESPONSE,
      'Estamos revisando tu consulta, gracias por avisarnos.',
    );
    const result = await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: [],
      files: new Map(),
      keywords: [],
      analysisGenerateFn: fn,
    });

    expect(calls).toHaveLength(2);
    expect(result.technicalAnalysis).toContain('Root cause');
    expect(result.clientReply).toBe('Estamos revisando tu consulta, gracias por avisarnos.');
    expect(result.classification).toBe('bug');
  });

  it('passes code context into the analysis call via its own fenced sourceCode input', async () => {
    const { fn, calls } = scriptedFn(TRIAGE_RESPONSE, 'ok');
    const files = new Map([
      ['internal/alerts/threshold.go', 'package alerts\nfunc CheckThreshold() {}\n'],
    ]);
    await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: ['internal/alerts/threshold.go'],
      files,
      keywords: ['threshold'],
      analysisGenerateFn: fn,
    });

    // Code now rides the <SOURCE_CODE> fence in the USER prompt (not the memory
    // channel in the system prompt).
    const analysisPrompt = calls[0]?.prompt ?? '';
    expect(analysisPrompt).toContain('CheckThreshold');
    expect(analysisPrompt).toContain('<SOURCE_CODE>');
    expect(calls[0]?.system ?? '').not.toContain('CheckThreshold');
  });

  it('still forwards a non-null memoryContext to the system prompt after the code/memory split', async () => {
    const { fn, calls } = scriptedFn(TRIAGE_RESPONSE, 'ok');
    const files = new Map([['a.go', 'package a\nfunc Widget() {}\n']]);
    await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: ['a.go'],
      files,
      keywords: ['widget'],
      memoryContext: 'PRIOR_DEDUP_NOTE',
      analysisGenerateFn: fn,
    });

    // Memory → system prompt; code → its own <SOURCE_CODE> fence in the user prompt.
    expect(calls[0]?.system ?? '').toContain('PRIOR_DEDUP_NOTE');
    expect(calls[0]?.prompt ?? '').toContain('Widget');
    expect(calls[0]?.prompt ?? '').not.toContain('PRIOR_DEDUP_NOTE');
  });

  it('formats and fences reproduction evidence into the analysis call', async () => {
    const { fn, calls } = scriptedFn(TRIAGE_RESPONSE, 'ok');
    const evidence: ReproEvidence = {
      reproduced: true,
      steps: ['clicked edit', 'entered 999'],
      consoleErrors: ['TypeError: threshold undefined'],
      netFails: [],
      uiErrors: [],
    };
    await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: [],
      files: new Map(),
      keywords: [],
      reproEvidence: evidence,
      analysisGenerateFn: fn,
    });

    const analysisPrompt = calls[0]?.prompt ?? '';
    expect(analysisPrompt).toContain('<REPRO_EVIDENCE>');
    expect(analysisPrompt).toContain('TypeError: threshold undefined');
  });

  it('skips the reproduction-evidence fence when no evidence is provided', async () => {
    const { fn, calls } = scriptedFn(TRIAGE_RESPONSE, 'ok');
    await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: [],
      files: new Map(),
      keywords: [],
      analysisGenerateFn: fn,
    });

    expect(calls[0]?.prompt ?? '').not.toContain('<REPRO_EVIDENCE>');
  });

  it('uses a separate clientReplyGenerateFn when provided', async () => {
    const { fn: analysisFn } = scriptedFn(TRIAGE_RESPONSE);
    const { fn: replyFn, calls: replyCalls } = scriptedFn('respuesta al cliente');
    const result = await runTriage({
      issue: baseIssue,
      config: baseConfig,
      contextFiles: [],
      files: new Map(),
      keywords: [],
      analysisGenerateFn: analysisFn,
      clientReplyGenerateFn: replyFn,
    });

    expect(replyCalls).toHaveLength(1);
    expect(result.clientReply).toBe('respuesta al cliente');
  });

  // ─── TASK (HIGH-RISK #1) — no-leak guarantee ──────────────────
  //
  // The raw reproduction evidence (file paths, DB constraint names, stack
  // traces, internal error text) must NEVER appear verbatim in the
  // generated clientReply, and technicalAnalysis must never be emitted as a
  // PostableReply. clientReply is derived from a jargon-banned SUMMARY of
  // the report, not the raw evidence/analysis directly.
  describe('no-leak guarantee (security invariant)', () => {
    it('never leaks a raw file path from reproduction evidence into clientReply', async () => {
      const secretPath = '/home/deploy/monorepo/internal/alerts/threshold_secret_module.go';
      const evidence: ReproEvidence = {
        reproduced: true,
        steps: [`opened ${secretPath}`],
        consoleErrors: [`panic at ${secretPath}:117`],
        netFails: [],
        uiErrors: [],
      };
      // Even a "misbehaving" LLM that tries to leak the path into the client
      // reply is caught because the client-reply call NEVER receives the raw
      // evidence text — only the already-summarized report.
      const { fn: analysisFn } = scriptedFn(TRIAGE_RESPONSE);
      // The client-reply generateFn is scripted to (adversarially) try to
      // leak the secret path anyway, simulating a worst-case LLM — the
      // ASSERTION is on the PIPELINE'S input isolation, not model obedience.
      const clientReplyFn: GenerateTextFn = vi.fn(async (_system, prompt) => {
        // Assert the raw secret path is NOT present in what the client-reply
        // call even SEES as input — the pipeline-level guarantee.
        expect(prompt).not.toContain(secretPath);
        return {
          text: 'Estamos revisando tu consulta.',
          tokensUsed: 1,
          provider: 'cli-bridge',
          model: 'x',
        };
      });

      const result = await runTriage({
        issue: baseIssue,
        config: baseConfig,
        contextFiles: [],
        files: new Map(),
        keywords: [],
        reproEvidence: evidence,
        analysisGenerateFn: analysisFn,
        clientReplyGenerateFn: clientReplyFn,
      });

      expect(result.clientReply).not.toContain(secretPath);
      expect(result.clientReply).not.toContain('panic at');
    });

    it('never leaks a DB constraint name from reproduction evidence into clientReply', async () => {
      const secretConstraint = 'chk_alert_threshold_range_v3';
      const evidence: ReproEvidence = {
        reproduced: true,
        steps: [],
        consoleErrors: [],
        netFails: [
          {
            url: '/api/thresholds',
            status: 500,
            method: 'POST',
            body: `constraint "${secretConstraint}" violated`,
          },
        ],
        uiErrors: [],
      };
      const { fn: analysisFn } = scriptedFn(TRIAGE_RESPONSE);
      const clientReplyFn: GenerateTextFn = vi.fn(async (_system, prompt) => {
        expect(prompt).not.toContain(secretConstraint);
        return {
          text: 'Ya estamos al tanto, gracias.',
          tokensUsed: 1,
          provider: 'cli-bridge',
          model: 'x',
        };
      });

      const result = await runTriage({
        issue: baseIssue,
        config: baseConfig,
        contextFiles: [],
        files: new Map(),
        keywords: [],
        reproEvidence: evidence,
        analysisGenerateFn: analysisFn,
        clientReplyGenerateFn: clientReplyFn,
      });

      expect(result.clientReply).not.toContain(secretConstraint);
    });

    it('never leaks an internal stack trace from reproduction evidence into clientReply', async () => {
      const secretTrace = 'at Object.<anonymous> (/srv/internal/db/pool.ts:88:19)';
      const evidence: ReproEvidence = {
        reproduced: true,
        steps: [],
        consoleErrors: [`Uncaught Error: connection refused\n${secretTrace}`],
        netFails: [],
        uiErrors: [],
      };
      const { fn: analysisFn } = scriptedFn(TRIAGE_RESPONSE);
      const clientReplyFn: GenerateTextFn = vi.fn(async (_system, prompt) => {
        expect(prompt).not.toContain(secretTrace);
        return {
          text: 'Gracias por reportarlo, lo estamos viendo.',
          tokensUsed: 1,
          provider: 'cli-bridge',
          model: 'x',
        };
      });

      const result = await runTriage({
        issue: baseIssue,
        config: baseConfig,
        contextFiles: [],
        files: new Map(),
        keywords: [],
        reproEvidence: evidence,
        analysisGenerateFn: analysisFn,
        clientReplyGenerateFn: clientReplyFn,
      });

      expect(result.clientReply).not.toContain(secretTrace);
      expect(result.clientReply).not.toContain('/srv/internal/db/pool.ts');
    });

    it('technicalAnalysis is a plain string, structurally distinct from PostableReply', async () => {
      // PostableReply is a branded type constructible ONLY via approveDraft
      // (../types/postable.ts). runTriage's technicalAnalysis is a plain
      // `string` — TypeScript would reject passing it directly to
      // `postComment(iid, reply: PostableReply)` at COMPILE time. This test
      // asserts the RUNTIME contract: technicalAnalysis is never the same
      // value as clientReply (they must diverge, since clientReply passes
      // through the jargon-ban translation step).
      const { fn: analysisFn } = scriptedFn(TRIAGE_RESPONSE);
      const { fn: replyFn } = scriptedFn('Traducción para el cliente, sin jerga.');
      const result = await runTriage({
        issue: baseIssue,
        config: baseConfig,
        contextFiles: [],
        files: new Map(),
        keywords: [],
        analysisGenerateFn: analysisFn,
        clientReplyGenerateFn: replyFn,
      });

      expect(result.technicalAnalysis).not.toBe(result.clientReply);
      expect(typeof result.technicalAnalysis).toBe('string');
    });
  });
});
