# GHAGGA CLI

AI-powered code review from the command line. **Free** with GitHub Models.

```bash
npx ghagga login
npx ghagga review
```

That's it. Zero config, zero cost.

## What is GHAGGA?

GHAGGA is a multi-agent AI code reviewer that analyzes your code changes using LLMs. It supports three review modes with increasing depth:

| Mode | Speed | Depth | LLM Calls |
|------|-------|-------|-----------|
| **simple** | ~2s | Single-pass review | 1 |
| **workflow** | ~15s | 5 specialist agents + synthesis | 6 |
| **consensus** | ~7s | Same model, three perspectives + algorithmic vote | 3 |

## Quick Start

### 1. Login (one time)

```bash
npx ghagga login
```

This authenticates with GitHub using Device Flow. Your GitHub token gives you **free access** to AI models via [GitHub Models](https://github.com/marketplace/models).

### 2. Review your code

```bash
# Review staged/uncommitted changes (simple mode)
npx ghagga review

# Thorough review with 5 specialist agents
npx ghagga review --mode workflow

# Balanced review with for/against/neutral voting
npx ghagga review --mode consensus

# See detailed progress of each step
npx ghagga review --mode workflow --verbose
```

### 3. Check your status

```bash
npx ghagga status    # Show auth & config
npx ghagga logout    # Clear credentials
```

### 4. Install git hooks (optional)

```bash
npx ghagga hooks install    # Auto-review on every commit
npx ghagga hooks status     # Check hook status
npx ghagga hooks uninstall  # Remove hooks
```

### 5. Manage review memory

```bash
npx ghagga memory list                    # List stored observations
npx ghagga memory search "error handling" # Search by content
npx ghagga memory stats                   # Database statistics
```

## Global Installation

If you use it frequently:

```bash
npm install -g ghagga

ghagga login
ghagga review
ghagga review -m workflow -v
```

## Global Options

```
  --plain     Disable styled terminal output (auto-enabled in non-TTY/CI)
  --version   Show version number
  --help      Show help
```

> The CLI uses [`@clack/prompts`](https://github.com/natemoo-re/clack) for styled terminal output (spinners, colored headers). In non-TTY or CI environments, output automatically falls back to plain `console.log`.

## Review Options

```
Usage: ghagga review [options] [path]

Options:
  -m, --mode <mode>          Review mode: simple, workflow, consensus (default: "simple")
  -p, --provider <provider>  LLM provider: github, anthropic, openai, google, ollama, qwen
  --model <model>            LLM model identifier
  --api-key <key>            LLM provider API key
  -o, --output <format>      Output format: markdown, json, sarif (default: "markdown")
  --enhance                  AI-powered post-analysis enhancement (groups findings, adds fix suggestions)
  --issue <target>           Create (new) or update (<number>) a GitHub issue with review results
  -v, --verbose              Show detailed progress during review
  --enable-tool <name>       Force-enable a specific tool (can be repeated)
  --disable-tool <name>      Force-disable a specific tool (can be repeated)
  --list-tools               Show all 15 available tools with status
  --no-memory                Disable review memory (skip search and persist)
  --memory-backend <type>    Memory backend: sqlite (default) or engram
  --staged                   Review only staged files (for pre-commit hook)
  --quick                    Static analysis only, skip AI review (~5-10s)
  --commit-msg <file>        Validate commit message from file
  --exit-on-issues           Exit with code 1 if critical/high issues found
  -c, --config <path>        Path to .ghagga.json config file
```

## Git Hooks

Install git hooks for automatic code review on every commit:

```bash
ghagga hooks install                  # Install pre-commit + commit-msg hooks
ghagga hooks install --force          # Overwrite existing hooks (backs up originals)
ghagga hooks install --pre-commit     # Only pre-commit hook
ghagga hooks install --commit-msg     # Only commit-msg hook
ghagga hooks uninstall                # Remove GHAGGA-managed hooks
ghagga hooks status                   # Show hook status
```

Hooks auto-detect `ghagga` in PATH and fail gracefully if not found. Installed hooks use `--plain --exit-on-issues` automatically.

## Memory Subcommands

```bash
ghagga memory list [--repo <owner/repo>] [--type <type>] [--limit <n>]
ghagga memory search [--repo <owner/repo>] [--limit <n>] <query>
ghagga memory show <id>
ghagga memory delete [--force] <id>
ghagga memory stats
ghagga memory clear [--repo <owner/repo>] [--force]
```

Memory is stored locally at `~/.config/ghagga/memory.db` (SQLite + FTS5). Observations are automatically extracted from reviews and used to provide context in future reviews.

### Deprecated Flags

The following flags still work but show deprecation warnings:

```
  -f, --format <format>      Use --output instead
  --no-semgrep               Use --disable-tool semgrep instead
  --no-trivy                 Use --disable-tool trivy instead
  --no-cpd                   Use --disable-tool cpd instead
```

## Health Command

Run a project health assessment with scoring, historical trends, and actionable recommendations:

```bash
# Basic health check
ghagga health

# Health check on a specific path
ghagga health ./src

# Show top 10 issues
ghagga health --top 10

# JSON output for CI integration
ghagga health --output json
```

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `[path]` | `.` | Path to repository or subdirectory |
| `--top <n>` | `5` | Number of top issues to display |
| `--output <format>` | `markdown` | Output format (inherits global `--output`) |

## BYOK (Bring Your Own Key)

Use any supported LLM provider:

```bash
# GitHub Models (default, free)
ghagga review --provider github

# Ollama (local, free, 100% offline)
ghagga review --provider ollama
ghagga review --provider ollama --model codellama:13b

# OpenAI
ghagga review --provider openai --api-key sk-...

# Anthropic
ghagga review --provider anthropic --api-key sk-ant-...

# Google
ghagga review --provider google --api-key AIza...

# Qwen (Alibaba Cloud)
ghagga review --provider qwen --api-key sk-...
```

## Local Models with Ollama

Run reviews 100% offline with [Ollama](https://ollama.com):

```bash
# 1. Install Ollama and pull a model
ollama pull qwen2.5-coder:7b

# 2. Review with local AI (no API key, no internet needed)
ghagga review --provider ollama

# Recommended models for code review:
#   qwen2.5-coder:7b    (~5 GB RAM, great for code)
#   codellama:13b        (~8 GB RAM, solid analysis)
#   deepseek-coder-v2:16b (~10 GB RAM, excellent quality)
#   llama3.1:8b          (~5 GB RAM, general purpose)
```

## Environment Variables

```bash
GHAGGA_API_KEY=<key>              # API key for the LLM provider
GHAGGA_PROVIDER=<provider>        # LLM provider override
GHAGGA_MODEL=<model>              # Model identifier override
GHAGGA_MEMORY_BACKEND=<type>      # Memory backend: sqlite (default) or engram
GHAGGA_ENGRAM_HOST=<url>          # Engram server URL (default: http://localhost:7437)
GHAGGA_ENGRAM_TIMEOUT=<seconds>   # Engram connection timeout (default: 5)
GITHUB_TOKEN=<token>              # GitHub token (fallback for github provider)
```

## Config File

Create a `.ghagga.json` in your project root:

```json
{
  "mode": "workflow",
  "enabledTools": ["ruff", "bandit"],
  "disabledTools": ["markdownlint"],
  "ignorePatterns": ["*.test.ts", "*.spec.ts"],
  "reviewLevel": "strict"
}
```

> The legacy fields `enableSemgrep`, `enableTrivy`, `enableCpd` still work but are deprecated. Use `enabledTools`/`disabledTools` arrays instead.

## How It Works

1. Gets your `git diff` (staged or uncommitted changes; `--staged` uses `git diff --cached`)
2. Parses the diff and detects tech stacks
3. Runs static analysis (Semgrep, Trivy, CPD) if available
4. Searches memory for relevant past observations (SQLite + FTS5 at `~/.config/ghagga/memory.db`, or Engram if `--memory-backend engram`)
5. Sends the diff + static findings + memory context to the AI review agent (skipped with `--quick`)
6. Returns findings with severity, file, line, and suggestions
7. Persists new observations (decisions, patterns, bug fixes) to local memory for future reviews

With `ghagga hooks install`, steps 1-7 run automatically on every commit via pre-commit and commit-msg hooks.

## Requirements

- Node.js >= 20
- Git (for diff detection)
- A GitHub account (for free AI models)

## License

MIT

## Links

- [GitHub Repository](https://github.com/JNZader/ghagga)
- [Full CLI Guide](https://jnzader.github.io/ghagga/docs/#/cli) — Complete setup guide with troubleshooting
- [Documentation](https://jnzader.github.io/ghagga/docs/)
- [Landing Page](https://jnzader.github.io/ghagga/)
