/**
 * CLI Bridge — calls LLM CLIs directly instead of using API tokens.
 *
 * Supported CLIs (in priority order):
 * 1. claude -p "prompt" --output-format text --max-turns 1
 * 2. gemini -p "prompt" --output-format text
 * 3. codex exec "prompt"
 * 4. copilot -p "prompt"
 *
 * Authentication:
 * - Claude: ANTHROPIC_API_KEY env var or claude auth login
 * - Gemini: GEMINI_API_KEY env var or google account
 * - Codex: CODEX_API_KEY env var or codex login
 * - Copilot: COPILOT_GITHUB_TOKEN or GH_TOKEN env var
 */

import { execSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

interface CLIAdapter {
  name: string;
  command: string;
  available: boolean;
  generate: (prompt: string, systemPrompt?: string) => string;
}

// ─── CLI Detection ──────────────────────────────────────────────

/**
 * Detect whether a CLI command is installed on the system.
 * Uses `which` to check PATH availability.
 */
function detectCLI(command: string): boolean {
  try {
    execSync(`which ${command}`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── CLI Exec Options ───────────────────────────────────────────

const CLI_EXEC_OPTIONS: import('node:child_process').ExecSyncOptionsWithStringEncoding = {
  timeout: 180_000,
  maxBuffer: 10 * 1024 * 1024,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
};

// ─── Adapters ───────────────────────────────────────────────────

const adapters: CLIAdapter[] = [
  {
    name: 'claude',
    command: 'claude',
    available: detectCLI('claude'),
    generate(prompt, systemPrompt) {
      // Pass prompt via stdin to avoid E2BIG on large diffs
      const args = ['--output-format', 'text', '--max-turns', '1'];
      if (systemPrompt) args.push('--system-prompt', systemPrompt);
      return execSync(`claude -p - ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
        ...CLI_EXEC_OPTIONS,
        input: prompt,
      }).trim();
    },
  },
  {
    name: 'gemini',
    command: 'gemini',
    available: detectCLI('gemini'),
    generate(prompt, systemPrompt) {
      // Gemini auto-detects non-TTY stdin and reads from it
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      return execSync('gemini -p - --output-format text', {
        ...CLI_EXEC_OPTIONS,
        input: fullPrompt,
      }).trim();
    },
  },
  {
    name: 'codex',
    command: 'codex',
    available: detectCLI('codex'),
    generate(prompt, systemPrompt) {
      // Codex reads from stdin with `codex exec -`
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      return execSync('codex exec -', {
        ...CLI_EXEC_OPTIONS,
        input: fullPrompt,
      }).trim();
    },
  },
  {
    name: 'copilot',
    command: 'copilot',
    available: detectCLI('copilot'),
    generate(prompt, _systemPrompt) {
      // copilot -p takes prompt as argument — too large for ARG_MAX with big diffs.
      // Write to temp file and tell copilot to read it.
      const tmpFile = join(tmpdir(), `ghagga-prompt-${Date.now()}.txt`);
      try {
        writeFileSync(tmpFile, prompt, 'utf8');
        return execSync(
          `copilot -p "Read and analyze the file at ${tmpFile} and provide a code review"`,
          { ...CLI_EXEC_OPTIONS },
        ).trim();
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get list of available CLI providers.
 */
export function getAvailableCLIs(): string[] {
  return adapters.filter((a) => a.available).map((a) => a.name);
}

/**
 * Generate text using CLI bridge.
 * Tries each available CLI in priority order.
 *
 * @param prompt - User prompt
 * @param systemPrompt - Optional system prompt
 * @param preferredCLI - Optional preferred CLI name ('claude', 'gemini', 'codex', 'copilot')
 * @returns { text, provider, cli }
 */
export function generateViaCLI(
  prompt: string,
  systemPrompt?: string,
  preferredCLI?: string,
): { text: string; provider: string; cli: string } {
  const available = adapters.filter((a) => a.available);

  if (available.length === 0) {
    throw new Error('No CLI providers available. Install one of: claude, gemini, codex, copilot');
  }

  // Reorder: preferred first, then rest
  const ordered = preferredCLI
    ? [
        ...available.filter((a) => a.name === preferredCLI),
        ...available.filter((a) => a.name !== preferredCLI),
      ]
    : available;

  for (const adapter of ordered) {
    try {
      const text = adapter.generate(prompt, systemPrompt);
      return { text, provider: 'cli-bridge', cli: adapter.name };
    } catch (error) {
      console.error(`[cli-bridge] ${adapter.name} failed: ${(error as Error).message}`);
    }
  }

  throw new Error(`All CLI providers failed: ${available.map((a) => a.name).join(', ')}`);
}

// ─── Test Helpers ───────────────────────────────────────────────

/**
 * Get the raw adapters array (for testing purposes only).
 * @internal
 */
export function _getAdapters(): readonly CLIAdapter[] {
  return adapters;
}
