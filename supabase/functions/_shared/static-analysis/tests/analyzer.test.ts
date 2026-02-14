/**
 * Tests for Static Analysis Orchestrator
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
  afterEach,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { runStaticAnalysis, formatFindingsAsLLMContext } from '../analyzer.ts';
import type { StaticAnalysisConfig } from '../types.ts';
import type { GitHubDiffFile } from '../../types/github.ts';

// Store original fetch for restoration
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Default enabled config for testing */
const enabledConfig: StaticAnalysisConfig = {
  enabled: true,
  aiAttributionCheck: true,
  securityPatternsCheck: true,
  semgrepServiceUrl: 'https://semgrep.example.com',
  commitMessageCheck: true,
  stackAwarePrompts: true,
};

/** Disabled config */
const disabledConfig: StaticAnalysisConfig = {
  enabled: false,
  aiAttributionCheck: false,
  securityPatternsCheck: false,
  semgrepServiceUrl: '',
  commitMessageCheck: false,
  stackAwarePrompts: false,
};

/** Mock diff files */
function createMockFiles(): GitHubDiffFile[] {
  return [
    {
      sha: 'abc123',
      filename: 'package.json',
      status: 'modified',
      additions: 2,
      deletions: 1,
      changes: 3,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '@@ -1,3 +1,4 @@\n {\n+  "name": "test",\n   "version": "1.0.0"\n }',
    },
    {
      sha: 'def456',
      filename: 'src/app.ts',
      status: 'modified',
      additions: 5,
      deletions: 0,
      changes: 5,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '@@ -1,3 +1,8 @@\n import express from "express";\n+\n+const app = express();\n+app.listen(3000);',
    },
  ];
}

describe('Static Analysis Orchestrator', () => {
  describe('runStaticAnalysis', () => {
    it('should return empty result when disabled', async () => {
      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: disabledConfig,
      });

      assertEquals(result.findings.length, 0);
      assertEquals(result.hasBlockingFindings, false);
    });

    it('should detect stack from files', async () => {
      // Mock semgrep to avoid HTTP calls
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const result = await runStaticAnalysis({
        files: createMockFiles(), // Contains package.json
        fileContents: [],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: enabledConfig,
      });

      assertEquals(result.detectedStack, 'node-npm');
    });

    it('should detect AI attribution in files', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const files: GitHubDiffFile[] = [
        {
          sha: 'abc',
          filename: 'src/app.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '@@ -1,3 +1,5 @@\n+// Made by Claude\n const x = 1;',
        },
      ];

      const result = await runStaticAnalysis({
        files,
        fileContents: [],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: enabledConfig,
      });

      assertEquals(result.summary.aiAttribution.fileFindings, 1);
      assertEquals(result.hasBlockingFindings, true); // AI attribution is 'error'
    });

    it('should detect AI attribution in commits', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [],
        commits: [
          { sha: 'abc1234567890', message: 'feat: add login\n\nCo-Authored-By: Claude <noreply@anthropic.com>' },
        ],
        config: enabledConfig,
      });

      assertEquals(result.summary.aiAttribution.commitFindings, 1);
    });

    it('should validate commit messages', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [],
        commits: [
          { sha: 'abc1234', message: 'feat: valid commit' },
          { sha: 'def5678', message: 'bad commit no type' },
        ],
        config: enabledConfig,
      });

      assertEquals(result.summary.commitMessage.valid, 1);
      assertEquals(result.summary.commitMessage.invalid, 1);
    });

    it('should include semgrep findings when service available', async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            findings: [
              {
                rule_id: 'js-eval-usage',
                path: 'src/app.ts',
                line: 5,
                message: 'Avoid eval()',
                severity: 'error',
                category: 'security',
              },
            ],
            duration_ms: 1000,
            files_scanned: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [{ path: 'src/app.ts', content: 'eval(input)' }],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: enabledConfig,
      });

      assertEquals(result.summary.security.findings, 1);
      assertEquals(result.summary.security.serviceAvailable, true);
    });

    it('should handle semgrep unavailable gracefully', async () => {
      globalThis.fetch = async () => {
        throw new Error('Connection refused');
      };

      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [{ path: 'src/app.ts', content: 'eval(input)' }],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: enabledConfig,
      });

      // Should still have results, just no security findings
      assertEquals(result.summary.security.findings, 0);
      assertEquals(result.summary.security.serviceAvailable, false);
      assertExists(result.totalTimeMs);
    });

    it('should report totalTimeMs', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const result = await runStaticAnalysis({
        files: createMockFiles(),
        fileContents: [],
        commits: [{ sha: 'abc1234', message: 'feat: test' }],
        config: enabledConfig,
      });

      assertEquals(result.totalTimeMs >= 0, true);
    });
  });

  describe('formatFindingsAsLLMContext', () => {
    it('should return empty string when no findings and unknown stack', () => {
      const context = formatFindingsAsLLMContext({
        detectedStack: 'unknown',
        findings: [],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 0, serviceAvailable: true },
          commitMessage: { valid: 1, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: false,
      });

      assertEquals(context, '');
    });

    it('should include stack info', () => {
      const context = formatFindingsAsLLMContext({
        detectedStack: 'node-npm',
        findings: [],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 0, serviceAvailable: true },
          commitMessage: { valid: 1, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: false,
      });

      assertStringIncludes(context, 'Node.js (npm)');
    });

    it('should include findings with severity', () => {
      const context = formatFindingsAsLLMContext({
        detectedStack: 'node-npm',
        findings: [
          {
            severity: 'error',
            category: 'security',
            message: 'Avoid eval()',
            file: 'src/app.ts',
            line: 5,
            source: 'static-analysis',
            ruleId: 'js-eval-usage',
          },
        ],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 1, serviceAvailable: true },
          commitMessage: { valid: 1, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: true,
      });

      assertStringIncludes(context, '[ERROR]');
      assertStringIncludes(context, 'js-eval-usage');
      assertStringIncludes(context, 'src/app.ts:5');
    });

    it('should include "do NOT repeat" instruction', () => {
      const context = formatFindingsAsLLMContext({
        detectedStack: 'node-npm',
        findings: [
          {
            severity: 'error',
            category: 'security',
            message: 'test',
            source: 'static-analysis',
            ruleId: 'test-rule',
          },
        ],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 1, serviceAvailable: true },
          commitMessage: { valid: 0, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: true,
      });

      assertStringIncludes(context, 'do NOT repeat');
    });

    it('should include stack-aware hints', () => {
      const context = formatFindingsAsLLMContext({
        detectedStack: 'python',
        findings: [],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 0, serviceAvailable: true },
          commitMessage: { valid: 0, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: false,
      });

      assertStringIncludes(context, 'Python');
      assertStringIncludes(context, 'type hints');
    });
  });
});
