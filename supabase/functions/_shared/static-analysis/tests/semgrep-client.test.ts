/**
 * Tests for Semgrep Client (HTTP calls to microservice)
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
  afterEach,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { scanWithSemgrep } from '../semgrep-client.ts';

// Store original fetch for restoration
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Semgrep Client', () => {
  it('should return findings from successful scan', async () => {
    // Mock fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          findings: [
            {
              rule_id: 'js-eval-usage',
              path: 'src/app.ts',
              line: 5,
              message: 'Avoid eval() - security risk',
              severity: 'error',
              category: 'security',
            },
          ],
          duration_ms: 1200,
          files_scanned: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'src/app.ts', content: 'eval(input)' }]
    );

    assertEquals(result.serviceAvailable, true);
    assertEquals(result.findings.length, 1);
    assertEquals(result.findings[0].ruleId, 'js-eval-usage');
    assertEquals(result.findings[0].severity, 'error');
    assertEquals(result.findings[0].source, 'static-analysis');
    assertEquals(result.findings[0].file, 'src/app.ts');
    assertEquals(result.findings[0].line, 5);
  });

  it('should return empty findings for clean scan', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          findings: [],
          duration_ms: 800,
          files_scanned: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'clean.ts', content: 'const x = 1;' }]
    );

    assertEquals(result.serviceAvailable, true);
    assertEquals(result.findings.length, 0);
  });

  it('should handle timeout gracefully', async () => {
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      // Simulate a long-running request that will be aborted
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
        // Never resolve - will be aborted by timeout
      });
    };

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'test.ts', content: 'code' }],
      50 // 50ms timeout
    );

    assertEquals(result.serviceAvailable, false);
    assertEquals(result.findings.length, 0);
  });

  it('should handle service error gracefully', async () => {
    globalThis.fetch = async () =>
      new Response('Internal Server Error', { status: 500 });

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'test.ts', content: 'code' }]
    );

    assertEquals(result.serviceAvailable, false);
    assertEquals(result.findings.length, 0);
  });

  it('should handle network error gracefully', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network error: connection refused');
    };

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'test.ts', content: 'code' }]
    );

    assertEquals(result.serviceAvailable, false);
    assertEquals(result.findings.length, 0);
  });

  it('should return empty for empty service URL', async () => {
    const result = await scanWithSemgrep(
      '',
      [{ path: 'test.ts', content: 'code' }]
    );

    assertEquals(result.serviceAvailable, false);
    assertEquals(result.findings.length, 0);
  });

  it('should return empty for empty files list', async () => {
    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      []
    );

    assertEquals(result.serviceAvailable, false);
    assertEquals(result.findings.length, 0);
  });

  it('should map severity correctly', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          findings: [
            { rule_id: 'r1', path: 'a.ts', line: 1, message: 'err', severity: 'error', category: 'security' },
            { rule_id: 'r2', path: 'b.ts', line: 2, message: 'warn', severity: 'warning', category: 'security' },
            { rule_id: 'r3', path: 'c.ts', line: 3, message: 'inf', severity: 'info', category: 'quality' },
          ],
          duration_ms: 500,
          files_scanned: 3,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const result = await scanWithSemgrep(
      'https://semgrep.example.com',
      [{ path: 'a.ts', content: 'x' }]
    );

    assertEquals(result.findings[0].severity, 'error');
    assertEquals(result.findings[1].severity, 'warning');
    assertEquals(result.findings[2].severity, 'info');
  });

  it('should strip trailing slash from service URL', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (url: string | URL | Request) => {
      requestedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(
        JSON.stringify({ findings: [], duration_ms: 0, files_scanned: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    await scanWithSemgrep(
      'https://semgrep.example.com/',
      [{ path: 'test.ts', content: 'code' }]
    );

    assertEquals(requestedUrl, 'https://semgrep.example.com/api/scan');
  });
});
