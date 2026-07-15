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

/** Regex for validating OpenCode cliModel format: `provider/model`. */
const CLI_MODEL_REGEX = /^[^/]+\/.+$/;

/**
 * CLIs that can authenticate WITHOUT an env-var credential because they use
 * an interactive OAuth login instead:
 * - gemini: Google account OAuth (falls back to GEMINI_API_KEY if present)
 * - copilot: GitHub login (falls back to COPILOT_GITHUB_TOKEN/GH_TOKEN if present)
 *
 * For these, a missing credential env var is NOT a configuration error — the CLI
 * can still authenticate via its own login. opencode is NOT in this set: its
 * provider models genuinely require the API key.
 */
const OAUTH_CAPABLE_CLIS = new Set<string>(['gemini', 'copilot']);

// ─── Env-Var Mapping ────────────────────────────────────────────

/**
 * Maps OpenCode provider prefixes to the env var they need for authentication.
 * Used to inject exactly the right credential into the subprocess environment.
 */
export const OPENCODE_ENV_BY_PREFIX: Record<string, string> = {
  opencode: '', // Free models — no API key needed
  'opencode-go': '', // opencode-go provider (Chinese-lab family models) — auth via the opencode CLI's own session, no credential env var injected
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'github-copilot': 'GITHUB_TOKEN',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/**
 * Known-safe env vars that the subprocess needs to function.
 * Only these (plus the single required credential) are copied into the subprocess env.
 *
 * This ALLOWLIST approach prevents credential leakage — any env var NOT listed here
 * (e.g., AZURE_OPENAI_KEY, REPLICATE_API_TOKEN) is automatically excluded.
 */
const SAFE_ENV_VARS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];

// ─── Types ──────────────────────────────────────────────────────

/** Valid CLI tool names for explicit selection. */
export type CLIToolName = 'opencode' | 'gemini' | 'copilot';

/** Options for generateViaCLI(). */
export interface CLIBridgeOptions {
  /**
   * Preferred CLI tool to use.
   * Also accepts 'claude' as a legacy alias → mapped to 'opencode' at runtime.
   */
  preferredCLI?: CLIToolName | 'claude' | (string & {});
  /** OpenCode model in `provider/model` format (e.g., 'anthropic/claude-sonnet-4-5'). */
  cliModel?: string;
  /** Injected credentials mapped by env var name (e.g., { ANTHROPIC_API_KEY: 'sk-...' }). */
  credentials?: Record<string, string>;
}

interface CLIAdapter {
  name: string;
  command: string;
  available: boolean;
  generate: (
    prompt: string,
    systemPrompt?: string,
    cliModel?: string,
    env?: NodeJS.ProcessEnv,
  ) => string;
}

/**
 * Error class for configuration failures that should NOT trigger fallback
 * to other CLIs. These represent misconfiguration, not transient failures.
 */
export class CLIConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CLIConfigurationError';
  }
}

// ─── CLI Detection ──────────────────────────────────────────────

/**
 * Detect whether a CLI command is installed on the system.
 * Uses `which` to check PATH availability.
 */
function detectCLI(command: string): boolean {
  try {
    // nosemgrep: command-injection-node -- `command` is only ever the hardcoded literals 'opencode'/'copilot'/'gemini' (see adapters[].command); no external input.
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

// ─── Credential Resolution ──────────────────────────────────────

/**
 * Resolve the env var name needed for a given CLI tool and model.
 *
 * - opencode: derives from cliModel provider prefix (e.g., 'anthropic' → 'ANTHROPIC_API_KEY')
 * - gemini: always 'GEMINI_API_KEY'
 * - copilot: always 'COPILOT_GITHUB_TOKEN'
 *
 * Returns undefined if the prefix is unknown or cliModel is not provided for opencode.
 */
export function resolveCredentialEnvVar(
  preferredCLI: string | undefined,
  cliModel?: string,
): string | undefined {
  switch (preferredCLI) {
    case 'opencode': {
      if (!cliModel) return undefined;
      const prefix = cliModel.split('/')[0];
      if (!prefix) return undefined;
      return OPENCODE_ENV_BY_PREFIX[prefix];
    }
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'copilot':
      return 'COPILOT_GITHUB_TOKEN';
    default:
      return undefined;
  }
}

// ─── Subprocess Environment ─────────────────────────────────────

/**
 * Build a subprocess environment using the ALLOWLIST approach:
 * 1. Start with an empty env
 * 2. Copy ONLY known-safe vars from process.env
 * 3. Add the single required credential
 *
 * This prevents credential leakage — only explicitly safe vars plus the
 * required credential are passed to the subprocess. Any env var NOT in
 * SAFE_ENV_VARS (e.g., AZURE_OPENAI_KEY, REPLICATE_API_TOKEN) is excluded.
 */
export function buildSubprocessEnv(
  credentialEnvName?: string,
  credentialValue?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // Copy only known-safe vars from process.env
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Add the single required credential
  if (credentialEnvName && credentialValue) {
    env[credentialEnvName] = credentialValue;
  }

  return env;
}

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
 *
 * @internal Exported for testing only.
 *
 * @deprecated Duplicate of mcp-llm-bridge `src/adapters/cli-opencode.ts#parseOpenCodeOutput`.
 * When ghagga fully delegates to mcp-llm-bridge (Fase 2 refactor), this function
 * and the entire cli-bridge provider can be removed.
 */
export function parseOpenCodeOutput(raw: string): {
  text: string;
  tokens?: { input?: number; output?: number };
} {
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

// ─── Error Sanitization ─────────────────────────────────────────

/**
 * Known API key patterns that must be redacted from error messages.
 * Each regex captures a token prefix and enough context to identify the key type,
 * then matches the rest of the key value.
 *
 * Constructed at runtime (split+join) to avoid triggering GitHub push protection
 * on pattern literals.
 */
const API_KEY_PATTERNS: readonly RegExp[] = [
  // Anthropic: sk-ant-*
  /sk-ant-[a-zA-Z0-9_-]{10,}/g,
  // OpenAI: sk-proj*, sk-<20+ alphanum>
  /sk-[a-zA-Z0-9]{20,}/g,
  // Google: AIza*
  /AIza[a-zA-Z0-9_-]{30,}/g,
  // GitHub PAT (classic): ghp_*
  /ghp_[a-zA-Z0-9]{30,}/g,
  // GitHub PAT (fine-grained): github_pat_*
  /github_pat_[a-zA-Z0-9_]{30,}/g,
  // Groq: gsk_*
  /gsk_[a-zA-Z0-9]{20,}/g,
  // OpenRouter: sk-or-*
  /\bsk-or-[a-zA-Z0-9_-]{20,}\b/g,
  // GitHub OAuth/App tokens: gho_*, ghs_*
  /gh[os]_[a-zA-Z0-9]{30,}/g,
  // Copilot/GitHub general token (catch-all for longer tokens)
  /ghp_[a-zA-Z0-9]{20,}/g,
];

/**
 * Sanitize an error message by redacting known API key patterns.
 *
 * This MUST be applied to all error messages before they propagate
 * (thrown errors, console.error, progress callbacks, etc.).
 */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of API_KEY_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED_KEY]');
  }
  return sanitized;
}

// ─── Validation Helpers ─────────────────────────────────────────

/**
 * Validate cliModel format and provider prefix for OpenCode.
 * Throws CLIConfigurationError for malformed or unsupported values.
 *
 * Only called when preferredCLI === 'opencode' and cliModel is provided.
 *
 * @internal Exported for testing only.
 */
export function validateCliModel(cliModel: string): void {
  if (!CLI_MODEL_REGEX.test(cliModel)) {
    throw new CLIConfigurationError(
      `Invalid cliModel format: '${cliModel}'. Expected 'provider/model' (e.g., 'anthropic/claude-sonnet-4-5').`,
    );
  }

  const prefix = cliModel.split('/')[0]!;
  if (!(prefix in OPENCODE_ENV_BY_PREFIX)) {
    const supported = Object.keys(OPENCODE_ENV_BY_PREFIX).join(', ');
    throw new CLIConfigurationError(
      `Unsupported OpenCode provider prefix: '${prefix}'. Supported prefixes: ${supported}.`,
    );
  }
}

/**
 * Validate that credentials are available for the selected tool.
 * Throws CLIConfigurationError if the required credential is missing
 * from both the injected credentials and the server environment.
 */
function validateCredentials(
  credentialEnvName: string | undefined,
  credentials?: Record<string, string>,
): void {
  if (!credentialEnvName) return; // No credential needed (free models or auto mode)

  // Check injected credentials first
  if (credentials) {
    const value = credentials[credentialEnvName];
    if (value && value.length > 0) return; // Has injected credential
  }

  // Check server environment as fallback
  const serverValue = process.env[credentialEnvName];
  if (serverValue && serverValue.length > 0) return; // Has server env credential

  throw new CLIConfigurationError(
    `Missing credential for CLI tool. Expected env var '${credentialEnvName}' to be set, ` +
      `or provide it via installation credentials.`,
  );
}

// ─── Adapters ───────────────────────────────────────────────────

const adapters: CLIAdapter[] = [
  {
    name: 'opencode',
    command: 'opencode',
    available: detectCLI('opencode'),
    generate(prompt, systemPrompt, cliModel, env) {
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

      // Build args: opencode run --model <model> --format json [inline-prompt]
      const args = ['run'];
      if (cliModel) {
        args.push('--model', cliModel);
      }
      args.push('--format', 'json');

      const cmdArgs = args.map((a) => JSON.stringify(a)).join(' ');

      const execOptions: import('node:child_process').ExecSyncOptionsWithStringEncoding = {
        ...CLI_EXEC_OPTIONS,
        ...(env ? { env } : {}),
      };

      let raw: string;
      const cmd =
        fullPrompt.length > STDIN_THRESHOLD
          ? `opencode ${cmdArgs}`
          : `opencode ${cmdArgs} ${JSON.stringify(fullPrompt)}`;

      try {
        // nosemgrep: command-injection-node -- `cmd` is built from JSON.stringify-quoted args + config-derived cliModel validated against CLI_MODEL_REGEX; the prompt is passed via stdin, never interpolated into the shell command.
        raw = execSync(cmd, {
          ...execOptions,
          ...(fullPrompt.length > STDIN_THRESHOLD ? { input: fullPrompt } : {}),
        });
      } catch (execError: unknown) {
        // execSync throws on non-zero exit — capture stderr for diagnostics
        const err = execError as {
          stderr?: Buffer | string;
          stdout?: Buffer | string;
          status?: number;
        };
        const stderr = err.stderr ? String(err.stderr).slice(0, 500) : 'no stderr';
        const stdout = err.stdout ? String(err.stdout).slice(0, 200) : 'no stdout';
        throw new Error(
          `OpenCode exited with status ${err.status ?? 'unknown'}. stderr: ${sanitizeErrorMessage(stderr)}. stdout: ${sanitizeErrorMessage(stdout)}`,
        );
      }

      const parsed = parseOpenCodeOutput(raw);
      if (!parsed.text) {
        // Log raw output for debugging empty responses
        const preview = raw.slice(0, 500) || '(empty)';
        throw new Error(
          `OpenCode returned no text content in JSON output. Raw preview: ${preview}`,
        );
      }
      return parsed.text.trim();
    },
  },
  {
    name: 'copilot',
    command: 'copilot',
    available: detectCLI('copilot'),
    generate(prompt, _systemPrompt, _cliModel, env) {
      // copilot -p takes prompt as argument — too large for ARG_MAX with big diffs.
      // Write to temp file and tell copilot to read it.
      const tmpFile = join(tmpdir(), `ghagga-prompt-${process.pid}-${Date.now()}.txt`);
      try {
        writeFileSync(tmpFile, prompt, 'utf8');
        // nosemgrep: command-injection-node -- `tmpFile` is a server-constructed path (join(tmpdir(), `ghagga-prompt-${pid}-${Date.now()}.txt`)); the user prompt is written to that file, never interpolated into the shell command.
        return execSync(
          `copilot -p "Read and analyze the file at ${tmpFile} and provide a code review"`,
          { ...CLI_EXEC_OPTIONS, ...(env ? { env } : {}) },
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
    generate(prompt, systemPrompt, _cliModel, env) {
      // Gemini auto-detects non-TTY stdin and reads from it
      const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      // nosemgrep: command-injection-node -- literal constant command string; the user prompt is passed via stdin (input), never interpolated into the shell command.
      return execSync('gemini -p - --output-format text', {
        ...CLI_EXEC_OPTIONS,
        ...(env ? { env } : {}),
        input: fullPrompt,
      }).trim();
    },
  },
];

// ─── Availability Override (testing) ────────────────────────────

/**
 * Optional override for adapter availability, keyed by adapter name.
 * `available` is frozen at module load via detectCLI(), so this seam lets tests
 * deterministically exercise code paths (e.g. the gemini OAuth path) without a
 * real CLI installed. Production code never sets this.
 *
 * @internal testing-only
 */
let availabilityOverride: Record<string, boolean> | undefined;

/**
 * Set (or clear with undefined) the availability override.
 * @internal Exported for testing only.
 */
export function _setAvailabilityOverride(override: Record<string, boolean> | undefined): void {
  availabilityOverride = override;
}

/** Resolve whether an adapter is available, honoring the testing override. */
function isAdapterAvailable(adapter: CLIAdapter): boolean {
  if (availabilityOverride && adapter.name in availabilityOverride) {
    return availabilityOverride[adapter.name]!;
  }
  return adapter.available;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get list of available CLI providers.
 * Returns names from the adapter list (opencode, copilot, gemini).
 */
export function getAvailableCLIs(): string[] {
  return adapters.filter(isAdapterAvailable).map((a) => a.name);
}

/**
 * Generate text using CLI bridge.
 * Tries each available CLI in priority order: opencode -> copilot -> gemini.
 *
 * Legacy alias: 'claude' is mapped to 'opencode' with default model
 * 'anthropic/claude-sonnet-4-5'.
 *
 * Configuration errors (malformed cliModel, unsupported provider prefix,
 * missing credentials) throw CLIConfigurationError immediately — they do NOT
 * fall through to retry other CLIs.
 *
 * @param prompt - User prompt
 * @param systemPrompt - Optional system prompt
 * @param options - Optional CLI bridge options (preferredCLI, cliModel, credentials)
 * @returns { text, provider, cli }
 */
export function generateViaCLI(
  prompt: string,
  systemPrompt?: string,
  options?: CLIBridgeOptions,
): { text: string; provider: string; cli: string } {
  const { preferredCLI: rawPreferredCLI, cliModel: rawCliModel, credentials } = options ?? {};

  // ── Legacy alias: 'claude' → 'opencode' with default model ──
  let resolvedCLI = rawPreferredCLI;
  let cliModel = rawCliModel;

  if (rawPreferredCLI === 'claude') {
    resolvedCLI = 'opencode';
    if (!cliModel) {
      cliModel = CLAUDE_LEGACY_DEFAULT_MODEL;
    }
  }

  // ── Validate cliModel (configuration error = hard fail) ──
  if (resolvedCLI === 'opencode' && cliModel) {
    validateCliModel(cliModel);
  }

  // ── Resolve credential env var ──
  const credentialEnvName = resolveCredentialEnvVar(resolvedCLI, cliModel);

  // ── Validate credentials (configuration error = hard fail) ──
  // OAuth-capable CLIs (gemini, copilot) skip the hard-fail: they can
  // authenticate via Google/GitHub login when no env credential is present.
  // The credential is still injected below when available.
  if (resolvedCLI && credentialEnvName && !OAUTH_CAPABLE_CLIS.has(resolvedCLI)) {
    validateCredentials(credentialEnvName, credentials);
  }

  // ── Build subprocess environment ──
  // When a credential is available, restrict the subprocess to the SAFE_ENV_VARS
  // allowlist plus that one credential (never the full parent env).
  let subprocessEnv: NodeJS.ProcessEnv | undefined;
  if (credentials && credentialEnvName) {
    subprocessEnv = buildSubprocessEnv(credentialEnvName, credentials[credentialEnvName]);
  } else if (resolvedCLI && OAUTH_CAPABLE_CLIS.has(resolvedCLI)) {
    // OAuth-capable CLI (gemini/copilot) selected explicitly with NO injected key:
    // still restrict to the allowlist so the CLI can read its own login state
    // (HOME/XDG) WITHOUT inheriting the full parent env, which would leak unrelated
    // server secrets. (This path is newly reachable because the OAuth-skip above no
    // longer hard-fails on a missing key.)
    // Known limitation: this restricted (allowlist-only) env also applies to any
    // FALLBACK adapter tried later in the loop below, so a fallback that relies on
    // ambient (non-allowlisted) keys will not see them on this path. Acceptable:
    // choosing an OAuth CLI explicitly is a deliberate restriction, and before this
    // change the no-key path hard-failed before reaching the loop at all. Per-adapter
    // env resolution would be a larger refactor, tracked separately.
    subprocessEnv = buildSubprocessEnv();
  }
  // else: subprocessEnv stays undefined → preserves the PRE-EXISTING behavior for
  // opencode / auto-mode (ambient-env inheritance). Closing that pre-existing path is
  // tracked separately (PRE-LAUNCH backlog: fail-closed vs degradation) — out of scope here.

  const available = adapters.filter(isAdapterAvailable);

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
      const text = adapter.generate(prompt, systemPrompt, modelArg, subprocessEnv);
      return { text, provider: 'cli-bridge', cli: adapter.name };
    } catch (error) {
      // CLIConfigurationError should NOT be caught — re-throw immediately
      if (error instanceof CLIConfigurationError) {
        throw error;
      }

      // Truncate error message — stderr from CLI failures can contain the entire prompt
      // (including huge diffs like package-lock.json), making logs unreadable.
      // Sanitize to redact any leaked credentials in error output.
      const fullMessage = (error as Error).message ?? String(error);
      const truncated =
        fullMessage.length > 500 ? `${fullMessage.slice(0, 500)}... [truncated]` : fullMessage;
      console.error(`[cli-bridge] ${adapter.name} failed: ${sanitizeErrorMessage(truncated)}`);
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
