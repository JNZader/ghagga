# Changelog

All notable changes to GHAGGA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive project documentation
  - Main README with quick start guide
  - Installation guide with step-by-step instructions
  - Configuration guide with all options documented
  - API documentation with endpoints and schemas
  - Contributing guidelines

## [0.1.0] - 2025-01-28

### Added

#### Dashboard
- Dashboard page with metrics overview
  - Total reviews, passed, and failed counts
  - Pass rate visualization with ring progress
  - Timeline chart showing reviews over time
- Reviews page with full history
  - Searchable review list
  - Filter by status (passed/failed/pending/in_progress/skipped)
  - Filter by repository
  - Pagination with configurable page size
  - Modal view for review details
- Memory page for Hebbian associations
  - View learned patterns
  - Association strength visualization
- Settings page for repository configuration
  - Enable/disable reviews per repository
  - Provider and model selection
  - Custom review rules editor
  - Feature toggles (workflow, consensus, hebbian)
- Login page with GitHub OAuth

#### Backend (Edge Functions)
- Webhook handler for GitHub events
  - HMAC-SHA256 signature verification
  - Support for pull_request events
  - Support for installation events
  - Support for installation_repositories events
- Review function with multiple modes
  - Simple review mode (single provider)
  - Workflow review mode (multi-stage)
  - Consensus review mode (multi-model)
- Shared utilities
  - Chunking service for large files
  - Embedding service for vector search
  - Hebbian learner for pattern associations
  - Hybrid search (semantic + full-text)
  - Provider registry for LLM management
  - Token budgeting utilities

#### Database
- Core tables (installations, repo_configs)
- Reviews and review_chunks tables
- Hebbian association tables
- Thread management tables
- Full-text search indexes (pg_trgm)
- Vector similarity search (pgvector)
- Row Level Security policies

#### LLM Provider Support
- Anthropic Claude (claude-sonnet-4-20250514)
- OpenAI GPT (gpt-4o, gpt-4-turbo)
- Google Gemini (gemini-2.0-flash, gemini-1.5-pro)
- Azure OpenAI

### Security
- Webhook signature verification
- Constant-time comparison for signatures
- Row Level Security on all tables
- Environment variable management

---

## Version History

| Version | Date | Description |
|---------|------|-------------|
| 0.1.0 | 2025-01-28 | Initial release with core features |

---

## Upgrade Notes

### Upgrading to 0.1.0

This is the initial release. For new installations, follow the [Installation Guide](docs/INSTALLATION.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute to this project.
