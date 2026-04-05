/**
 * MCP Code Intelligence Client
 *
 * Connects to an MCP-compatible code intelligence server
 * (codedb, repoforge graph) and implements the CodeIntelProvider interface.
 *
 * All methods degrade gracefully — network errors or timeouts return
 * empty results instead of throwing.
 */

import type { CodeIntelProvider, SymbolReference } from './types.js';

// ─── Constants ─────────────────────────────────────────────────

/** Default timeout for MCP queries in milliseconds. */
export const DEFAULT_CODE_INTEL_TIMEOUT = 5_000;

// ─── MCP Response Types ────────────────────────────────────────

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Client ────────────────────────────────────────────────────

export class McpCodeIntelClient implements CodeIntelProvider {
  private readonly serverUrl: string;
  private readonly timeout: number;
  private requestId = 0;

  constructor(serverUrl: string, timeout = DEFAULT_CODE_INTEL_TIMEOUT) {
    this.serverUrl = serverUrl;
    this.timeout = timeout;
  }

  async getCallers(symbol: string, file: string): Promise<SymbolReference[]> {
    return this.querySymbolRefs('code-intel/callers', { symbol, file });
  }

  async getCallees(symbol: string, file: string): Promise<SymbolReference[]> {
    return this.querySymbolRefs('code-intel/callees', { symbol, file });
  }

  async getFileImports(file: string): Promise<string[]> {
    return this.queryStringList('code-intel/imports', { file });
  }

  async getFileExports(file: string): Promise<string[]> {
    return this.queryStringList('code-intel/exports', { file });
  }

  // ─── Internal Helpers ──────────────────────────────────────

  private async querySymbolRefs(
    method: string,
    params: Record<string, string>,
  ): Promise<SymbolReference[]> {
    const data = await this.rpc(method, params);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (item): item is { file: string; symbol: string; line?: number } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).file === 'string' &&
          typeof (item as Record<string, unknown>).symbol === 'string',
      )
      .map((item) => ({
        file: item.file,
        symbol: item.symbol,
        ...(typeof item.line === 'number' ? { line: item.line } : {}),
      }));
  }

  private async queryStringList(method: string, params: Record<string, string>): Promise<string[]> {
    const data = await this.rpc(method, params);
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is string => typeof item === 'string');
  }

  /**
   * Send a JSON-RPC 2.0 request to the MCP server.
   * Returns the result field on success, null on any error.
   */
  private async rpc(method: string, params: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const json = (await response.json()) as McpJsonRpcResponse;
      if (json.error) return null;

      return json.result ?? null;
    } catch {
      // Network error, timeout, or abort — degrade gracefully
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
