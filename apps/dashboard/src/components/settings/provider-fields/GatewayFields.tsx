import type { ProviderEntryState } from '../ProviderEntry';

export interface GatewayFieldsProps {
  index: number;
  entry: ProviderEntryState;
  /** Called when the user edits the gateway URL */
  onUrlChange: (url: string) => void;
  /** Called when the user edits the gateway model (empty string falls back to 'auto') */
  onModelChange: (model: string) => void;
}

/**
 * LLM Gateway-specific provider fields.
 *
 * Renders the Gateway URL input and the Model datalist input. The
 * Validate button + status messages live in the parent (ProviderEntry)
 * credential block because they are shared with cli-bridge/ollama.
 */
export function GatewayFields({ index, entry, onUrlChange, onModelChange }: GatewayFieldsProps) {
  return (
    <div className="mb-3 space-y-3">
      <div>
        <label
          htmlFor={`gateway-url-${index}`}
          className="mb-1 block text-xs font-medium text-text-secondary"
        >
          Gateway URL
          <span className="ml-1 text-red-400">*</span>
        </label>
        <input
          id={`gateway-url-${index}`}
          type="url"
          autoComplete="off"
          value={entry.gatewayUrl ?? ''}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://llm-gateway.example.com"
          className="input-field w-full"
        />
      </div>
      <div>
        <label
          htmlFor={`gateway-model-${index}`}
          className="mb-1 block text-xs font-medium text-text-secondary"
        >
          Model
          <span className="ml-2 font-normal text-text-muted">(type or select from gateway)</span>
        </label>
        <input
          id={`gateway-model-${index}`}
          type="text"
          autoComplete="off"
          list={`gateway-models-${index}`}
          value={entry.model === 'auto' ? '' : entry.model}
          onChange={(e) => onModelChange(e.target.value)}
          placeholder="auto (gateway selects best available)"
          className="input-field w-full"
        />
        <datalist id={`gateway-models-${index}`}>
          <option value="auto">Auto — gateway selects best available</option>
          {/* ── Copilot FREE (0x multiplier, no premium requests) ── */}
          <option value="github-copilot/gpt-4o">GPT-4o (Copilot FREE)</option>
          <option value="github-copilot/gpt-4.1">GPT-4.1 (Copilot FREE)</option>
          <option value="github-copilot/gpt-5-mini">GPT-5 Mini (Copilot FREE)</option>
          {/* ── Copilot CHEAP (0.25-0.33x multiplier) ── */}
          <option value="github-copilot/claude-haiku-4.5">Claude Haiku 4.5 (Copilot 0.33x)</option>
          <option value="github-copilot/gemini-3-flash-preview">
            Gemini 3 Flash (Copilot 0.33x)
          </option>
          <option value="github-copilot/gpt-5.4-mini">GPT-5.4 Mini (Copilot 0.33x)</option>
          <option value="github-copilot/grok-code-fast-1">Grok Code Fast 1 (Copilot 0.25x)</option>
          {/* ── Copilot STANDARD (1x multiplier) ── */}
          <option value="github-copilot/claude-sonnet-4">Claude Sonnet 4 (Copilot 1x)</option>
          <option value="github-copilot/claude-sonnet-4.5">Claude Sonnet 4.5 (Copilot 1x)</option>
          <option value="github-copilot/claude-sonnet-4.6">Claude Sonnet 4.6 (Copilot 1x)</option>
          <option value="github-copilot/gemini-2.5-pro">Gemini 2.5 Pro (Copilot 1x)</option>
          <option value="github-copilot/gemini-3-pro-preview">Gemini 3 Pro (Copilot 1x)</option>
          <option value="github-copilot/gpt-5">GPT-5 (Copilot 1x)</option>
          <option value="github-copilot/gpt-5.1">GPT-5.1 (Copilot 1x)</option>
          <option value="github-copilot/gpt-5.1-codex">GPT-5.1 Codex (Copilot 1x)</option>
          <option value="github-copilot/gpt-5.2-codex">GPT-5.2 Codex (Copilot 1x)</option>
          {/* ── Copilot EXPENSIVE (3x multiplier) ── */}
          <option value="github-copilot/claude-opus-4.5">Claude Opus 4.5 (Copilot 3x)</option>
          <option value="github-copilot/claude-opus-4.6">Claude Opus 4.6 (Copilot 3x)</option>
          {/* ── OpenCode FREE ── */}
          <option value="opencode/gpt-5-nano">GPT-5 Nano (OpenCode free)</option>
          <option value="opencode/big-pickle">Big Pickle (OpenCode free)</option>
          <option value="opencode/minimax-m2.5-free">MiniMax M2.5 Free (OpenCode free)</option>
          <option value="opencode/mimo-v2-pro-free">MIMO v2 Pro Free (OpenCode free)</option>
          <option value="opencode/mimo-v2-omni-free">MIMO v2 Omni Free (OpenCode free)</option>
          <option value="opencode/nemotron-3-super-free">
            Nemotron 3 Super Free (OpenCode free)
          </option>
          {/* ── Anthropic via OpenCode ── */}
          <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5 (Anthropic)</option>
          <option value="anthropic/claude-opus-4-6">Claude Opus 4.6 (Anthropic)</option>
          <option value="anthropic/claude-haiku-4-5">Claude Haiku 4.5 (Anthropic)</option>
          {/* ── OpenAI via OpenCode ── */}
          <option value="openai/gpt-5-codex">GPT-5 Codex (OpenAI)</option>
          <option value="openai/gpt-5.2-codex">GPT-5.2 Codex (OpenAI)</option>
          {/* ── OpenCode Subscription ── */}
          <option value="opencode-go/kimi-k2.5">Kimi K2.5 (OpenCode sub)</option>
          <option value="opencode-go/minimax-m2.7">MiniMax M2.7 (OpenCode sub)</option>
        </datalist>
        <p className="mt-1 text-xs text-text-secondary">
          Leave empty for auto-selection. Type any model ID available on your gateway.
        </p>
      </div>
      <p className="text-xs text-text-secondary">The token goes in the API Key field below.</p>
    </div>
  );
}
