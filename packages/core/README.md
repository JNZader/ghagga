# @ghagga/core

Core review engine for [GHAGGA](https://github.com/JNZader/ghagga) — AI-powered multi-agent code reviewer.

This package contains the distribution-agnostic review pipeline, LLM provider integrations, static analysis runners, and all three review modes (simple, workflow, consensus).

## Installation

```bash
npm install @ghagga/core
```

## Usage

```typescript
import { reviewPipeline, DEFAULT_SETTINGS } from '@ghagga/core';

const result = await reviewPipeline({
  diff: '...unified diff string...',
  mode: 'simple',          // 'simple' | 'workflow' | 'consensus'
  provider: 'github',      // 'github' | 'openai' | 'anthropic' | 'google' | 'ollama' | 'qwen'
  model: 'gpt-4o-mini',
  apiKey: process.env.GITHUB_TOKEN!,
  settings: DEFAULT_SETTINGS,
});

console.log(result.status);   // 'PASSED' | 'FAILED' | 'NEEDS_HUMAN_REVIEW'
console.log(result.summary);
console.log(result.findings);
```

## Review Modes

| Mode | LLM Calls | Best For |
|------|-----------|----------|
| **simple** | 1 | Small PRs, quick feedback |
| **workflow** | 6 | Thorough review with 5 specialist agents + synthesis |
| **consensus** | 3 | Same model, three perspectives (for/against/neutral) + algorithmic vote |

## Providers

- **github** — Free via [GitHub Models](https://github.com/marketplace/models) (default)
- **openai** — OpenAI API (GPT-4o, GPT-4o-mini, etc.)
- **anthropic** — Anthropic API (Claude Sonnet, Haiku, etc.)
- **google** — Google AI (Gemini Pro, Flash, etc.)
- **ollama** — Local models via [Ollama](https://ollama.ai/) (Qwen2.5-Coder, CodeLlama, etc.)
- **qwen** — Alibaba Cloud DashScope API (Qwen-Coder-Plus, etc.)

> **Tip:** For the CLI experience, use [`@ghagga/cli`](https://www.npmjs.com/package/@ghagga/cli) instead.

## License

MIT
