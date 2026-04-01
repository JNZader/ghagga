/**
 * Node.js execution context — used by CLI and server modes.
 *
 * Uses `child_process.execFile` under the hood.
 * Handles timeouts via AbortController.
 */

import { execFile } from 'node:child_process';
import type { ExecOptions, ExecutionContext, RawToolOutput } from './types.js';

/**
 * Create a Node.js-based ExecutionContext.
 *
 * @param logger - Optional logger; defaults to console
 */
export function createNodeExecutionContext(logger?: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}): ExecutionContext {
  const log = logger ?? console;

  return {
    async exec(command: string, args: string[], opts: ExecOptions): Promise<RawToolOutput> {
      return new Promise<RawToolOutput>((resolve, reject) => {
        const ac = new AbortController();
        let timedOut = false;

        // Set up timeout
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, opts.timeoutMs);

        const env = opts.env ? { ...process.env, ...opts.env } : process.env;

        const child = execFile(
          command,
          args,
          {
            cwd: opts.cwd,
            env,
            maxBuffer: 50 * 1024 * 1024, // 50MB
            signal: ac.signal,
          },
          (error, stdout, stderr) => {
            clearTimeout(timer);

            if (timedOut) {
              resolve({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode: -1,
                timedOut: true,
              });
              return;
            }

            // Get exit code from error or default to 0
            const exitCode = error && 'code' in error ? ((error.code as number) ?? 1) : 0;

            // Check if exit code is acceptable
            const allowedCodes = [0, ...(opts.allowExitCodes ?? [])];
            if (error && !allowedCodes.includes(exitCode)) {
              // Still resolve with the output — let the caller decide
              resolve({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                exitCode,
                timedOut: false,
              });
              return;
            }

            resolve({
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              exitCode,
              timedOut: false,
            });
          },
        );

        // Handle spawn errors
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },

    async cacheRestore(_toolName: string, _paths: string[]): Promise<boolean> {
      // CLI/server mode has no cache — always miss
      return false;
    },

    async cacheSave(_toolName: string, _paths: string[]): Promise<void> {
      // CLI/server mode has no cache — no-op
    },

    log(level: 'info' | 'warn' | 'error', message: string): void {
      log[level](message);
    },

    // No MCP server in default Node context — plugins that need MCP will skip gracefully
    mcpCall: undefined,
  };
}
