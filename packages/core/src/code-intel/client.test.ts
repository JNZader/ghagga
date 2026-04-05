/**
 * Unit tests for McpCodeIntelClient.
 *
 * Tests cover:
 * - Successful queries returning parsed results
 * - Server unavailable returning empty arrays
 * - Timeout returning empty arrays
 * - Malformed response handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpCodeIntelClient } from './client.js';

// ─── Test Setup ────────────────────────────────────────────────

const SERVER_URL = 'http://localhost:9999/mcp';

function jsonRpcOk(result: unknown) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response;
}

function jsonRpcError(code: number, message: string) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  } as unknown as Response;
}

describe('McpCodeIntelClient', () => {
  let client: McpCodeIntelClient;

  beforeEach(() => {
    client = new McpCodeIntelClient(SERVER_URL, 1000);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── getCallers ────────────────────────────────────────────

  describe('getCallers', () => {
    it('returns parsed symbol references on success', async () => {
      const mockData = [
        { file: 'src/auth.ts', symbol: 'login', line: 42 },
        { file: 'src/api.ts', symbol: 'handleRequest' },
      ];
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(mockData));

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([
        { file: 'src/auth.ts', symbol: 'login', line: 42 },
        { file: 'src/api.ts', symbol: 'handleRequest' },
      ]);
    });

    it('returns empty array when server returns error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcError(-32600, 'Invalid request'));

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([]);
    });

    it('returns empty array when server is unreachable', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([]);
    });

    it('returns empty array on abort signal', async () => {
      // Simulate an aborted fetch (same as what happens on timeout)
      vi.mocked(fetch).mockRejectedValueOnce(
        new DOMException('The operation was aborted', 'AbortError'),
      );

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([]);
    });

    it('filters out malformed entries from response', async () => {
      const mockData = [
        { file: 'src/auth.ts', symbol: 'login' },
        { bad: 'entry' },
        null,
        'not an object',
        { file: 'src/api.ts', symbol: 'handle', line: 10 },
      ];
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(mockData));

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([
        { file: 'src/auth.ts', symbol: 'login' },
        { file: 'src/api.ts', symbol: 'handle', line: 10 },
      ]);
    });

    it('returns empty array when result is not an array', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk({ unexpected: 'object' }));

      const result = await client.getCallers('validate', 'src/utils.ts');

      expect(result).toEqual([]);
    });
  });

  // ─── getCallees ────────────────────────────────────────────

  describe('getCallees', () => {
    it('returns parsed symbol references on success', async () => {
      const mockData = [{ file: 'src/db.ts', symbol: 'query', line: 15 }];
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(mockData));

      const result = await client.getCallees('processData', 'src/handler.ts');

      expect(result).toEqual([{ file: 'src/db.ts', symbol: 'query', line: 15 }]);
    });
  });

  // ─── getFileImports ────────────────────────────────────────

  describe('getFileImports', () => {
    it('returns string array on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(['./utils.js', './types.js']));

      const result = await client.getFileImports('src/auth.ts');

      expect(result).toEqual(['./utils.js', './types.js']);
    });

    it('filters out non-string entries', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(['./utils.js', 42, null, './types.js']));

      const result = await client.getFileImports('src/auth.ts');

      expect(result).toEqual(['./utils.js', './types.js']);
    });

    it('returns empty array on HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      const result = await client.getFileImports('src/auth.ts');

      expect(result).toEqual([]);
    });
  });

  // ─── getFileExports ────────────────────────────────────────

  describe('getFileExports', () => {
    it('returns string array on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk(['validateToken', 'AuthConfig']));

      const result = await client.getFileExports('src/auth.ts');

      expect(result).toEqual(['validateToken', 'AuthConfig']);
    });
  });

  // ─── JSON-RPC compliance ───────────────────────────────────

  describe('JSON-RPC request format', () => {
    it('sends correct JSON-RPC 2.0 request', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonRpcOk([]));

      await client.getCallers('myFunc', 'src/file.ts');

      expect(fetch).toHaveBeenCalledWith(
        SERVER_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'code-intel/callers',
            params: { symbol: 'myFunc', file: 'src/file.ts' },
          }),
        }),
      );
    });
  });
});
