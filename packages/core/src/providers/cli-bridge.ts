/**
 * CLI Bridge — calls LLM CLIs directly instead of using API tokens.
 *
 * Supported CLIs (in auto-detect priority order):
 * 1. opencode run --model <provider/model> --format json "<prompt>"
 * 2. copilot -p "prompt"
 * 3. gemini -p "prompt" --output-format text
 *
 * Legacy alias:
 * - 'claude' is treated as 'opencode' with default cliModel 'anthropic/claude-sonnet-4-5'
 *
 * Authentication:
 * - OpenCode: provider-specific env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 * - Gemini: GEMINI_API_KEY env var or google account
 * - Copilot: COPILOT_GITHUB_TOKEN or GH_TOKEN env var
 */

import { execSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────

/** Default model used when 'claude' legacy alias is resolved to 'opencode'. */
const CLAUDE_LEGACY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5';

/** Prompt size threshold (in chars) above which stdin is used instead of inline arg. */
const STDIN_THRESHOLD = 10_000;

// ─── Types ──────────────────────────────────────────────────────

interface CLIAdapter {
  name: string;
  command: string;
  available: boolean;
  generate: (prompt: string, systemPrompt?: string, cliModel?: string) => string;
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

// ─── OpenCode JSON Output Parsing ───────────────────────────────

interface OpenCodeTextEvent {
  type: 'text';
  part: { text: string };
}

interface OpenCodeStepFinishEvent {
  type: 'step_finish';
  part: { tokens?: { input?: number; output?: number }; cost?: number };
}

type OpenCodeEvent = OpenCodeTextEvent | OpenCodeStepFinishEvent | { type: string };

/**
 * Parse OpenCode `--format json` output.
 *
 * The output is newline-delimited JSON. Each line is an object with a `type` field:
 * - `text` — contains actual LLM response text in `part.text`
 * - `step_finish` — contains token usage in `part.tokens` and cost in `part.cost`
 *
 * Returns the concatenated text and optional token usage.
 */
function parseOpenCodeOutput(raw: string): { text: string; tokens?: { input?: number; output?: number } } {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const textParts: string[] = [];
  let tokens: { input?: number; output?: number } | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as OpenCodeEvent;
      if (event.type === 'text') {
        const textEvent = event as OpenCodeTextEvent;
        if (textEvent.part?.text) {
          textParts.push(textEvent.part.text);
        }
      } else if (event.type === 'step_finish') {
        const finishEvent = event as OpenCodeStepFinishEvent;
        if (finishEvent.part?.tokens) {
          tokens = finishEvent.part.tokens;
        }
      }
    } catch {
      // Skip malformed JSON lines (e.g., partial output on error)
    }
  }

  return { text: textParts.join(''), tokens };
}

// ─── Adapters ───────────────────────────────────────────────────

const adapters: CLIAdapter[] = [
  {
    name: 'opencode',
    command: 'opencode',
    available: detectCLI('opencode'),
    generate(prompt, systemPrompt, cliModel) {
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

      // Build args: opencode run --model <model> --format json [inline-prompt]
      const args = ['run'];
      if (cliModel) {
        args.push('--model', cliModel);
      }
      args.push('--format', 'json');

      const cmdArgs = args.map((a) => JSON.stringify(a)).join(' ');

      let raw: string;
      if (fullPrompt.length > STDIN_THRESHOLD) {
        // Large prompt: pipe via stdin (OpenCode auto-detects piped stdin)
        raw = execSync(`opencode ${cmdArgs}`, {
          ...CLI_EXEC_OPTIONS,
          input: fullPrompt,
        });
      } else {
        // Inline prompt as trailing argument
        raw = execSync(`opencode ${cmdArgs} ${JSON.stringify(fullPrompt)}`, {
          ...CLI_EXEC_OPTIONS,
        });
      }

      const parsed = parseOpenCodeOutput(raw);
      if (!parsed.text) {
        throw new Error('OpenCode returned no text content in JSON output');
      }
      return parsed.text.trim();
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
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get list of available CLI providers.
 * Returns names from the adapter list (opencode, copilot, gemini).
 */
export function getAvailableCLIs(): string[] {
  return adapters.filter((a) => a.available).map((a) => a.name);
}

/**
 * Generate text using CLI bridge.
 * Tries each available CLI in priority order: opencode -> copilot -> gemini.
 *
 * Legacy alias: 'claude' is mapped to 'opencode' with default model
 * 'anthropic/claude-sonnet-4-5'.
 *
 * @param prompt - User prompt
 * @param systemPrompt - Optional system prompt
 * @param preferredCLI - Optional preferred CLI name ('opencode', 'gemini', 'copilot', or 'claude' legacy alias)
 * @returns { text, provider, cli }
 */
export function generateViaCLI(
  prompt: string,
  systemPrompt?: string,
  preferredCLI?: string,
): { text: string; provider: string; cli: string } {
  // ── Legacy alias: 'claude' → 'opencode' with default model ──
  let resolvedCLI = preferredCLI;
  let cliModel: string | undefined;

  if (preferredCLI === 'claude') {
    resolvedCLI = 'opencode';
    cliModel = CLAUDE_LEGACY_DEFAULT_MODEL;
  }

  const available = adapters.filter((a) => a.available);

  if (available.length === 0) {
    throw new Error('No CLI providers available. Install one of: opencode, copilot, gemini');
  }

  // Reorder: preferred first, then rest
  const ordered = resolvedCLI
    ? [
        ...available.filter((a) => a.name === resolvedCLI),
        ...available.filter((a) => a.name !== resolvedCLI),
      ]
    : available;

  for (const adapter of ordered) {
    try {
      // Pass cliModel only to the opencode adapter (others ignore it)
      const modelArg = adapter.name === 'opencode' ? cliModel : undefined;
      const text = adapter.generate(prompt, systemPrompt, modelArg);
      return { text, provider: 'cli-bridge', cli: adapter.name };
    } catch (error) {
      // Truncate error message — stderr from CLI failures can contain the entire prompt
      // (including huge diffs like package-lock.json), making logs unreadable.
      const fullMessage = (error as Error).message ?? String(error);
      const truncated =
        fullMessage.length > 500 ? `${fullMessage.slice(0, 500)}... [truncated]` : fullMessage;
      console.error(`[cli-bridge] ${adapter.name} failed: ${truncated}`);
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
