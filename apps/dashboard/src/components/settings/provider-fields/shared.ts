import type { SaaSProvider } from '@/lib/types';

// ─── Known Models per Provider (for instant model selection without re-validation) ──

export const KNOWN_MODELS: Record<SaaSProvider, string[]> = {
  'cli-bridge': ['auto', 'opencode', 'copilot', 'gemini'],
  gateway: ['auto'],
  ollama: ['llama3', 'llama3.1', 'codellama', 'mistral', 'gemma3', 'qwen2.5-coder'],
};

// ─── Ollama suggestions ─────────────────────────────────────────

// Ollama local-models suggestions for the model input datalist
export const OLLAMA_MODEL_SUGGESTIONS = [
  'llama3',
  'llama3.1',
  'llama3.2',
  'codellama',
  'mistral',
  'gemma3',
  'qwen2.5-coder',
  'deepseek-coder-v2',
  'phi3',
];

// ─── CLI Bridge: tool options + OpenCode model suggestions ──────

export const CLI_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto-detect (best available)' },
  { value: 'opencode', label: 'OpenCode (recommended)' },
  { value: 'copilot', label: 'Copilot CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
];

/** Free OpenCode models — no API key needed */
export const OPENCODE_FREE_MODELS = [
  'opencode/gpt-5-nano',
  'opencode/big-pickle',
  'opencode/mimo-v2-pro-free',
  'opencode/minimax-m2.5-free',
  'opencode/nemotron-3-super-free',
  'opencode/mimo-v2-omni-free',
];

/** Curated OpenCode model suggestions (require API key for the provider) */
export const OPENCODE_PAID_MODELS = [
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5-codex',
  'groq/openai/gpt-oss-120b',
  'openrouter/deepseek/deepseek-chat',
];

export const OPENCODE_MODEL_SUGGESTIONS = [...OPENCODE_FREE_MODELS, ...OPENCODE_PAID_MODELS];

// ─── CLI Bridge: credential helpers ─────────────────────────────

/** Derive a human-readable credential label from the CLI tool and cliModel prefix */
export function getCliCredentialLabel(cliTool: string, cliModel?: string): string {
  if (cliTool === 'gemini') return 'Gemini API Key';
  if (cliTool === 'copilot') return 'GitHub Token (Fine-Grained PAT)';
  if (cliTool === 'auto') return 'API Key (optional)';

  // opencode — derive from cliModel prefix
  if (cliTool === 'opencode' && cliModel) {
    const prefix = cliModel.split('/')[0];
    switch (prefix) {
      case 'opencode':
        return ''; // Free models — no API key needed
      case 'anthropic':
        return 'Anthropic API Key';
      case 'openai':
        return 'OpenAI API Key';
      case 'google':
        return 'Gemini API Key';
      case 'github-copilot':
        return 'GitHub Token';
      case 'groq':
        return 'Groq API Key';
      case 'openrouter':
        return 'OpenRouter API Key';
      default:
        return 'Provider API Key';
    }
  }

  return 'Provider API Key';
}

/** Get contextual help text for the CLI credential input */
export function getCliCredentialHelp(cliTool: string): string {
  switch (cliTool) {
    case 'opencode':
      return 'Models prefixed with opencode/ are free and need no API key. For other providers (anthropic/, openai/, etc.), provide the corresponding API key.';
    case 'gemini':
      return 'Provide a Gemini API key, or leave empty to use the server’s GEMINI_API_KEY.';
    case 'copilot':
      return 'Provide a GitHub Fine-Grained PAT with Copilot permissions, or leave empty to use the server’s token.';
    case 'auto':
      return 'Credentials are optional. The server will use its own keys if no credential is provided.';
    default:
      return '';
  }
}

/** Check if cliModel matches the expected provider/model format */
export function isValidCliModelFormat(cliModel: string): boolean {
  return /^[^/]+\/.+$/.test(cliModel);
}
