# @ghagga/core

Core review engine for [GHAGGA](https://github.com/JNZader/ghagga) — AI-powered multi-agent code reviewer.

This package contains the distribution-agnostic review pipeline, the three provider modes (`gateway`, `cli-bridge`, `ollama`), the 17-tool static-analysis registry, and six review modes (`simple`, `workflow`, `consensus`, `diagnostic`, `fan-out`, `hybrid-4r`).

## Installation

```bash
npm install ghagga-core
```

## Usage

```typescript
import { reviewPipeline, DEFAULT_SETTINGS } from '@ghagga/core';

const result = await reviewPipeline({
  diff: '...unified diff string...',
  mode: 'simple',          // simple | workflow | consensus | diagnostic | fan-out | hybrid-4r
  provider: 'gateway',     // gateway | cli-bridge | ollama
  model: 'auto',
  apiKey: process.env.GHAGGA_API_KEY!,
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
| **consensus** | 3 | Three stances plus an algorithmic vote. A split vote is `INCONCLUSIVE` |
| **diagnostic** | varies | Ranked hypotheses with verification steps |
| **fan-out** | ~5 | Parallel lenses, merged by severity |
| **hybrid-4r** | ~5 | Fan-out with `pinLensesToFirst` forced on |

## Providers

- **gateway** — route through mcp-llm-bridge. This is what `ghagga login` saves
- **cli-bridge** — local CLIs (Claude, Codex, OpenCode, Gemini, Copilot)
- **ollama** — local models via [Ollama](https://ollama.ai/)

Legacy names (`github`, `openai`, `anthropic`, `google`, `qwen`, and the rest of that list) are not provider modes. Saved config that still has one is remapped to `gateway`.

> **Tip:** For the CLI, install [`ghagga`](https://www.npmjs.com/package/ghagga).

## License

MIT
