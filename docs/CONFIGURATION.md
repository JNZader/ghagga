# Configuration Guide

This guide covers all configuration options for GHAGGA, from environment variables to repository-level settings.

## Table of Contents

1. [Configuration Layers](#configuration-layers)
2. [Environment Variables](#environment-variables)
3. [Repository Settings](#repository-settings)
4. [Review Modes](#review-modes)
5. [Custom Rules](#custom-rules)
6. [File Patterns](#file-patterns)
7. [Advanced Features](#advanced-features)

---

## Configuration Layers

GHAGGA uses three layers of configuration:

| Layer | Scope | Location |
|-------|-------|----------|
| Environment | Global | `.env` files, Supabase secrets |
| Repository | Per-repo | Dashboard Settings page |
| Review | Per-review | PR-specific rules |

Settings cascade from global to specific, with more specific settings taking precedence.

---

## Environment Variables

See [ENV_VARIABLES.md](ENV_VARIABLES.md) for the complete environment variable reference.

### Quick Reference

```bash
# Required: GitHub App
GITHUB_APP_ID=123456
GITHUB_CLIENT_ID=Iv1.xxx
GITHUB_CLIENT_SECRET=secret
GITHUB_PRIVATE_KEY=base64_encoded_key
GITHUB_WEBHOOK_SECRET=webhook_secret

# Required: Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
GOOGLE_AI_API_KEY=AIza-xxx

# Optional: Application settings
NODE_ENV=development
LOG_LEVEL=info
MAX_CONCURRENT_REVIEWS=5
REVIEW_TIMEOUT_MS=300000
```

---

## Repository Settings

Configure repositories through the Dashboard Settings page.

### Basic Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Enabled** | `true` | Enable/disable reviews for this repo |
| **Provider** | `claude` | LLM provider (claude, openai, gemini) |
| **Model** | `claude-sonnet-4-20250514` | Specific model to use |

### Available Models

**Anthropic (Claude)**
- `claude-sonnet-4-20250514` (default, recommended)
- `claude-3-opus-20240229`
- `claude-3-haiku-20240307`

**OpenAI**
- `gpt-4o`
- `gpt-4-turbo`
- `gpt-4`
- `gpt-3.5-turbo`

**Google AI (Gemini)**
- `gemini-2.0-flash`
- `gemini-1.5-pro`
- `gemini-1.5-flash`

### Feature Toggles

| Feature | Default | Description |
|---------|---------|-------------|
| **Workflow Enabled** | `false` | Enable multi-step workflow review |
| **Consensus Enabled** | `false` | Enable multi-model consensus |
| **Hebbian Enabled** | `false` | Enable learning from past reviews |

---

## Review Modes

### Simple Mode

The default review mode. A single LLM analyzes the code changes.

**Best for:**
- Quick reviews
- Smaller PRs
- Consistent reviewer behavior

**Configuration:**
```
workflow_enabled: false
consensus_enabled: false
```

### Workflow Mode

Multi-step review process with sequential stages.

**Best for:**
- Complex PRs
- Deep analysis
- Structured review process

**Configuration:**
```
workflow_enabled: true
consensus_enabled: false
```

**Stages:**
1. Initial analysis
2. Pattern detection
3. Security review
4. Final synthesis

### Consensus Mode

Multiple AI models review the code and reach consensus.

**Best for:**
- Critical code paths
- Diverse perspectives
- High-confidence requirements

**Configuration:**
```
workflow_enabled: false
consensus_enabled: true
```

**Process:**
1. Route to multiple providers
2. Collect independent reviews
3. Synthesize findings
4. Determine consensus status

---

## Custom Rules

Define project-specific review guidelines using markdown.

### Setting Rules via Dashboard

1. Navigate to **Settings** in the dashboard
2. Select the repository
3. Edit the **Review Rules** field
4. Save changes

### Rule Format

```markdown
## Code Standards

- Use TypeScript strict mode
- Prefer functional components
- Maximum function length: 50 lines

## Security Requirements

- Never log sensitive data
- Validate all user inputs
- Use parameterized queries

## Testing

- Unit tests required for utilities
- Integration tests for API endpoints
- Minimum 80% coverage for new code
```

### Rule Examples

**React Project:**
```markdown
## React Guidelines

- Use functional components with hooks
- Avoid inline styles
- Memoize expensive computations
- Handle loading and error states

## State Management

- Use React Query for server state
- Keep local state minimal
- Avoid prop drilling beyond 2 levels
```

**API Project:**
```markdown
## API Standards

- RESTful endpoint naming
- Consistent error response format
- Rate limiting on public endpoints
- Request validation with schemas

## Database

- Use transactions for multi-table operations
- Index frequently queried fields
- Avoid N+1 queries
```

---

## File Patterns

Control which files are reviewed using glob patterns.

### Default Patterns

**Include:**
```
*.ts
*.tsx
*.js
*.py
```

**Exclude:**
```
*.test.*
node_modules/*
```

### Custom Patterns

Configure via the Settings page:

**File Patterns (include):**
```
*.ts
*.tsx
*.js
*.jsx
*.py
*.go
*.rs
src/**/*.vue
```

**Exclude Patterns:**
```
*.test.*
*.spec.*
__tests__/*
node_modules/*
dist/*
build/*
.next/*
vendor/*
```

### Pattern Syntax

| Pattern | Matches |
|---------|---------|
| `*.ts` | All TypeScript files |
| `src/**/*.ts` | TypeScript in src directory |
| `!*.test.ts` | Exclude test files |
| `{*.ts,*.tsx}` | TypeScript and TSX files |
| `**/__tests__/*` | All test directories |

---

## Advanced Features

### Hebbian Learning

Learns associations between code patterns and review findings.

**How it works:**
1. Tracks patterns from reviewed code
2. Correlates file types with finding categories
3. Strengthens associations over repeated observations
4. Improves recommendations for similar future code

**Enable:**
```
hebbian_enabled: true
```

**What it learns:**
- File extension patterns (`.ts`, `.py`, etc.)
- Directory patterns (`src/*`, `lib/*`)
- Finding categories (security, performance, style)
- Severity patterns

### Hybrid Search

Combines semantic embeddings with full-text search to find similar past reviews.

**How it works:**
1. Generates embeddings for review content
2. Stores in pgvector for similarity search
3. Combines with pg_trgm text search
4. Retrieves contextually similar reviews

**Benefits:**
- Consistent feedback for similar code
- Learn from organizational patterns
- Reduce repeated issues

### Token Budgeting

Automatically manages context limits for LLM calls.

**Smart Chunking:**
- Splits large files into manageable chunks
- Preserves context across chunks
- Optimizes token usage per request

**Configuration:**
```bash
REVIEW_TIMEOUT_MS=300000  # 5 minutes default
```

---

## Configuration Best Practices

### Development Environment

```bash
NODE_ENV=development
LOG_LEVEL=debug
MAX_CONCURRENT_REVIEWS=2
```

### Production Environment

```bash
NODE_ENV=production
LOG_LEVEL=info
MAX_CONCURRENT_REVIEWS=5
REVIEW_TIMEOUT_MS=300000
```

### Per-Repository Recommendations

**Small Projects:**
- Simple mode
- Hebbian disabled
- Basic file patterns

**Large Monorepos:**
- Workflow mode
- Custom file patterns per area
- Specific exclude patterns

**Critical Systems:**
- Consensus mode
- Strict rules
- All features enabled

---

## Troubleshooting

### Reviews Not Triggering

1. Check repository is enabled in Settings
2. Verify file patterns match changed files
3. Ensure PR is not a draft
4. Check exclude patterns

### Slow Reviews

1. Reduce file patterns scope
2. Enable smart chunking
3. Increase concurrent limit
4. Use faster models (Haiku, Flash)

### Inconsistent Results

1. Enable Hebbian learning
2. Define explicit rules
3. Consider consensus mode
4. Review and update patterns
