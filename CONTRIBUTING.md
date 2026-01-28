# Contributing to GHAGGA

Thank you for your interest in contributing to GHAGGA! This document provides guidelines and instructions for contributing.

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Development Workflow](#development-workflow)
4. [Code Style](#code-style)
5. [Testing](#testing)
6. [Pull Request Process](#pull-request-process)
7. [Commit Guidelines](#commit-guidelines)
8. [Project Structure](#project-structure)

---

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment. Please:

- Be respectful of differing viewpoints
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards others

---

## Getting Started

### Prerequisites

Ensure you have the following installed:

- Node.js v18+
- Deno v1.38+
- Supabase CLI
- Docker
- Git

### Setup

1. **Fork the repository**
   ```bash
   # Fork via GitHub UI, then clone your fork
   git clone https://github.com/YOUR_USERNAME/ghagga.git
   cd ghagga
   ```

2. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/original-org/ghagga.git
   ```

3. **Install dependencies**
   ```bash
   # Backend
   supabase start

   # Frontend
   cd dashboard
   npm install
   ```

4. **Set up environment**
   ```bash
   cp supabase/.env.example supabase/.env
   # Edit .env with your development credentials
   ```

---

## Development Workflow

### Branch Strategy

We use GitFlow with the following branches:

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code |
| `develop` | Integration branch |
| `feat/*` | New features |
| `fix/*` | Bug fixes |
| `docs/*` | Documentation |

### Creating a Feature Branch

```bash
# Update develop branch
git checkout develop
git pull upstream develop

# Create feature branch
git checkout -b feat/your-feature-name
```

### Making Changes

1. Make your changes
2. Test locally
3. Commit with conventional commits
4. Push to your fork
5. Open a pull request

---

## Code Style

### TypeScript (Frontend & Backend)

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use explicit return types for functions
- Avoid `any` type; use `unknown` if necessary

```typescript
// Good
export function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// Avoid
export function calculateTotal(items: any) {
  return items.reduce((sum: any, item: any) => sum + item.price, 0);
}
```

### React Components

- Use functional components with hooks
- Extract complex logic into custom hooks
- Keep components focused and small

```typescript
// Good
export function ReviewCard({ review }: ReviewCardProps) {
  const { status, summary } = review;

  return (
    <Card>
      <StatusBadge status={status} />
      <Text>{summary}</Text>
    </Card>
  );
}
```

### SQL Migrations

- Use descriptive names: `001_description.sql`
- Include comments explaining purpose
- Use lowercase for SQL keywords (consistent style)

```sql
-- 001_add_feature.sql
-- Adds support for feature X

create table feature_x (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);
```

### Formatting

- Use 2 spaces for indentation
- Maximum line length: 100 characters
- Use trailing commas in multi-line structures

Run linting before committing:

```bash
# Frontend
cd dashboard
npm run lint

# Backend
deno lint supabase/functions
```

---

## Testing

### Frontend Tests

```bash
cd dashboard
npm test
```

### Backend Tests

```bash
deno test supabase/functions
```

### Test Guidelines

- Write tests for new functionality
- Maintain existing test coverage
- Use descriptive test names
- Test edge cases

```typescript
// Good test structure
Deno.test('ChunkingService splits large content correctly', () => {
  const service = new ChunkingService({ maxTokens: 100 });
  const result = service.chunk(largeContent);

  assertEquals(result.length, 3);
  assert(result.every(chunk => chunk.tokens <= 100));
});
```

---

## Pull Request Process

### Before Submitting

1. **Update from upstream**
   ```bash
   git fetch upstream
   git rebase upstream/develop
   ```

2. **Run tests**
   ```bash
   deno test
   cd dashboard && npm test
   ```

3. **Run linting**
   ```bash
   cd dashboard && npm run lint
   deno lint supabase/functions
   ```

4. **Build successfully**
   ```bash
   cd dashboard && npm run build
   ```

### PR Template

When creating a PR, include:

```markdown
## Summary
Brief description of changes

## Changes
- List of specific changes
- Bullet points work well

## Testing
How was this tested?

## Screenshots
If applicable, add screenshots

## Checklist
- [ ] Tests pass
- [ ] Linting passes
- [ ] Documentation updated
```

### Review Process

1. Submit PR against `develop` branch
2. Automated checks must pass
3. At least one approval required
4. Address review feedback
5. Squash and merge

---

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
type(scope): description

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Code style (formatting, semicolons) |
| `refactor` | Code refactoring |
| `test` | Adding or updating tests |
| `chore` | Maintenance tasks |

### Examples

```bash
# Feature
feat(review): add consensus mode support

# Bug fix
fix(webhook): handle empty PR body

# Documentation
docs(api): update endpoint descriptions

# Refactor
refactor(dashboard): extract review hooks
```

### Commit Best Practices

- Keep commits atomic (one logical change)
- Write clear, descriptive messages
- Reference issues when applicable: `fix(auth): resolve login bug (#123)`

---

## Project Structure

```
ghagga/
├── dashboard/                 # React frontend
│   ├── src/
│   │   ├── components/        # Reusable components
│   │   ├── contexts/          # React contexts
│   │   ├── lib/               # Utilities and hooks
│   │   └── pages/             # Page components
│   └── package.json
├── supabase/                  # Backend
│   ├── functions/             # Edge functions
│   │   ├── webhook/           # GitHub webhook handler
│   │   ├── review/            # Review orchestration
│   │   └── _shared/           # Shared code
│   │       ├── chunking/      # Content chunking
│   │       ├── consensus/     # Consensus engine
│   │       ├── embeddings/    # Vector embeddings
│   │       ├── hebbian/       # Learning system
│   │       ├── providers/     # LLM providers
│   │       ├── search/        # Hybrid search
│   │       └── types/         # Type definitions
│   └── migrations/            # Database migrations
└── docs/                      # Documentation
```

### Key Files

| File | Purpose |
|------|---------|
| `supabase/functions/webhook/index.ts` | Webhook entry point |
| `supabase/functions/review/index.ts` | Review orchestrator |
| `supabase/functions/_shared/types/index.ts` | Shared types |
| `dashboard/src/App.tsx` | Frontend routing |
| `dashboard/src/lib/supabase.ts` | Supabase client |

---

## Questions?

- Open an issue for bugs or features
- Start a discussion for questions
- Check existing issues before creating new ones

Thank you for contributing!
