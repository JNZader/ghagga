# GHAGGA - Multi-Agent GitHub Code Reviewer

A powerful, AI-powered code review system that integrates with GitHub to provide automated, intelligent code reviews on pull requests.

## Features

- **Multi-Mode Code Review** - Choose from Simple, Workflow, or Consensus review modes
- **Multi-Provider AI Support** - Works with Claude, GPT-4, Gemini, and Azure OpenAI
- **Hebbian Learning** - Learns from past reviews to improve recommendations over time
- **Hybrid Search** - Combines semantic embeddings with full-text search for context
- **Interactive Dashboard** - Monitor reviews, configure repositories, and track metrics
- **GitHub Integration** - Automatic PR comments with detailed findings

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Deno](https://deno.land/) (v1.38+)
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A GitHub account with permissions to create GitHub Apps
- API key for at least one LLM provider (Claude, OpenAI, or Gemini)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/ghagga.git
cd ghagga

# Copy environment configuration
cp supabase/.env.example supabase/.env

# Start Supabase locally
supabase start

# Deploy edge functions
supabase functions deploy

# Install dashboard dependencies
cd dashboard
npm install

# Start development server
npm run dev
```

For detailed setup instructions, see the [Installation Guide](docs/INSTALLATION.md).

## Project Structure

```
ghagga/
├── dashboard/               # React frontend application
│   ├── src/
│   │   ├── components/      # Reusable UI components
│   │   ├── contexts/        # React context providers
│   │   ├── lib/             # Utility functions and hooks
│   │   └── pages/           # Page components
│   └── package.json
├── supabase/                # Backend infrastructure
│   ├── config.toml          # Supabase configuration
│   ├── functions/           # Deno Edge Functions
│   │   ├── webhook/         # GitHub webhook handler
│   │   ├── review/          # Code review orchestrator
│   │   └── _shared/         # Shared utilities
│   └── migrations/          # Database schema (SQL)
└── docs/                    # Documentation
    ├── INSTALLATION.md      # Setup guide
    ├── CONFIGURATION.md     # Configuration reference
    ├── API.md               # API documentation
    ├── ENV_VARIABLES.md     # Environment variables
    └── GITHUB_APP_SETUP.md  # GitHub App guide
```

## Review Modes

### Simple Review

Single LLM provider performs code analysis. Fast and straightforward.

### Workflow Review

Multi-step workflow engine with sequential processing stages for deeper analysis.

### Consensus Review

Multiple AI models evaluate code and reach consensus, providing diverse perspectives.

## Configuration

Configure GHAGGA through:

1. **Environment Variables** - Set API keys and application settings
2. **Repository Settings** - Per-repo configuration via the dashboard
3. **Custom Rules** - Define project-specific review guidelines

See [Configuration Guide](docs/CONFIGURATION.md) for details.

## Dashboard

Access the dashboard at `http://localhost:5173/ghagga/` to:

- View review history and metrics
- Configure repository settings
- Enable/disable review features
- Set custom review rules
- Monitor pass/fail rates

## Development

```bash
# Start local Supabase instance
supabase start

# Serve edge functions locally
supabase functions serve

# Run tests
deno test

# Dashboard development
cd dashboard
npm run dev

# Build dashboard for production
npm run build

# Lint dashboard code
npm run lint
```

## Technology Stack

### Frontend

- React 18 with TypeScript
- Mantine UI component library
- Vite build system
- React Router for navigation

### Backend

- Supabase (PostgreSQL + Edge Functions)
- Deno runtime
- pgvector for embeddings
- pg_trgm for text search

### AI Providers

- Anthropic Claude (claude-sonnet-4-20250514)
- OpenAI GPT (gpt-4o, gpt-4-turbo)
- Google Gemini (gemini-2.0-flash, gemini-1.5-pro)
- Azure OpenAI

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Configuration Guide](docs/CONFIGURATION.md)
- [API Documentation](docs/API.md)
- [Environment Variables](docs/ENV_VARIABLES.md)
- [GitHub App Setup](docs/GITHUB_APP_SETUP.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT License - see LICENSE file for details.
