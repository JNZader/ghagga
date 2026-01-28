# API Documentation

This document covers the GHAGGA API, including webhook endpoints, edge functions, and database schema.

## Table of Contents

1. [Overview](#overview)
2. [Webhook Endpoint](#webhook-endpoint)
3. [Review Function](#review-function)
4. [Database Schema](#database-schema)
5. [Types Reference](#types-reference)

---

## Overview

GHAGGA uses Supabase Edge Functions to handle GitHub webhooks and execute code reviews. The system follows a serverless architecture with PostgreSQL for persistence.

### Base URL

**Local Development:**
```
http://localhost:54321/functions/v1
```

**Production:**
```
https://your-project.supabase.co/functions/v1
```

### Authentication

Edge functions use GitHub webhook signature verification (HMAC-SHA256) for incoming webhooks and Supabase service role keys for database operations.

---

## Webhook Endpoint

### POST /webhook

Receives and processes GitHub webhook events.

**URL:** `/functions/v1/webhook`

**Method:** `POST`

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `x-github-event` | Yes | Event type (e.g., `pull_request`) |
| `x-hub-signature-256` | Yes | HMAC-SHA256 signature |
| `x-github-delivery` | No | Unique delivery ID |

**Request Body:** GitHub webhook payload (varies by event type)

### Supported Events

#### pull_request

Triggers code review on PR open, synchronize, or reopen.

**Trigger Actions:**
- `opened` - New PR created
- `synchronize` - PR updated with new commits
- `reopened` - Closed PR reopened

**Skipped When:**
- PR is in draft state
- PR is closed or merged
- Repository reviews are disabled

**Response:**
```json
{
  "message": "Review triggered",
  "reviewId": "uuid",
  "prNumber": 123,
  "mode": "simple"
}
```

#### installation

Handles GitHub App installation events.

**Actions:**
- `created` - App installed
- `deleted` - App uninstalled

**Response:**
```json
{
  "message": "Installation processed",
  "installationId": 12345678,
  "action": "created"
}
```

#### installation_repositories

Handles repository selection changes.

**Actions:**
- `added` - Repositories added to installation
- `removed` - Repositories removed from installation

**Response:**
```json
{
  "message": "Repositories updated",
  "added": ["owner/repo1"],
  "removed": []
}
```

### Error Responses

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Invalid JSON payload | Request body is not valid JSON |
| 400 | Missing event header | x-github-event header not provided |
| 401 | Invalid signature | Webhook signature verification failed |
| 405 | Method not allowed | Only POST requests accepted |
| 500 | Internal server error | Server-side processing error |

**Error Response Format:**
```json
{
  "error": "Error message"
}
```

---

## Review Function

The review function orchestrates code analysis using configured LLM providers.

### Review Modes

#### Simple Review

Single-pass analysis using one LLM provider.

**Input:**
```typescript
interface SimpleReviewInput {
  diff: string;
  files: ReviewFile[];
  rules?: string;
  prTitle?: string;
  prBody?: string;
}
```

**Output:**
```typescript
interface SimpleReviewResult {
  status: 'passed' | 'failed';
  summary: string;
  findings: ReviewFinding[];
}
```

#### Workflow Review

Multi-stage review with sequential processing.

**Stages:**
1. Initial analysis
2. Pattern detection
3. Security review
4. Final synthesis

**Output:**
```typescript
interface WorkflowReviewResult {
  status: 'passed' | 'failed' | 'error';
  summary: string;
  findings: ReviewFinding[];
  stages: StageResult[];
}
```

#### Consensus Review

Multi-model review with consensus determination.

**Output:**
```typescript
interface ConsensusReviewResult {
  status: 'passed' | 'failed' | 'discuss';
  summary: string;
  findings: ReviewFinding[];
  modelVotes: ModelVote[];
  consensusReached: boolean;
}
```

### Review Finding Structure

```typescript
interface ReviewFinding {
  /** Severity level */
  severity: 'error' | 'warning' | 'info' | 'suggestion';

  /** Category (e.g., security, performance, style) */
  category: string;

  /** Human-readable message */
  message: string;

  /** File path (optional) */
  file?: string;

  /** Line number (optional) */
  line?: number;

  /** Suggested fix (optional) */
  suggestion?: string;
}
```

---

## Database Schema

### Tables

#### installations

Tracks GitHub App installations.

```sql
CREATE TABLE installations (
  id BIGINT PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  account_avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### repo_configs

Per-repository review settings.

```sql
CREATE TABLE repo_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT REFERENCES installations(id) ON DELETE CASCADE,
  repo_full_name TEXT UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  provider TEXT DEFAULT 'claude',
  model TEXT DEFAULT 'claude-sonnet-4-20250514',
  rules TEXT,
  file_patterns TEXT[] DEFAULT ARRAY['*.ts', '*.tsx', '*.js', '*.py'],
  exclude_patterns TEXT[] DEFAULT ARRAY['*.test.*', 'node_modules/*'],
  workflow_enabled BOOLEAN DEFAULT FALSE,
  consensus_enabled BOOLEAN DEFAULT FALSE,
  hebbian_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### reviews

Code review results and history.

```sql
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'pending', 'in_progress', 'skipped')),
  result_summary TEXT,
  result_full JSONB,
  files_reviewed TEXT[],
  embedding VECTOR(1536),
  thread_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### review_chunks

Chunked content for embeddings.

```sql
CREATE TABLE review_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes

```sql
-- Fast repo config lookups
CREATE INDEX idx_repo_configs_installation_id ON repo_configs(installation_id);

-- Review queries
CREATE INDEX idx_reviews_repo_pr ON reviews(repo_full_name, pr_number);
CREATE INDEX idx_reviews_status ON reviews(status);
CREATE INDEX idx_reviews_created ON reviews(created_at DESC);

-- Full-text search
CREATE INDEX idx_reviews_summary_trgm ON reviews USING gin(result_summary gin_trgm_ops);

-- Vector similarity search
CREATE INDEX idx_reviews_embedding ON reviews USING ivfflat(embedding vector_cosine_ops);
```

### Functions

#### hybrid_search

Combines vector similarity with full-text search.

```sql
SELECT * FROM hybrid_search(
  query_embedding := '[0.1, 0.2, ...]'::vector,
  query_text := 'search terms',
  repo_filter := 'owner/repo',
  match_count := 10
);
```

**Returns:**
```typescript
interface HybridSearchResult {
  id: string;
  repo_full_name: string;
  similarity: number;
  text_rank: number;
  combined_score: number;
}
```

---

## Types Reference

### ReviewStatus

```typescript
type ReviewStatus = 'passed' | 'failed' | 'pending' | 'in_progress' | 'skipped';
```

### ReviewMode

```typescript
type ReviewMode = 'simple' | 'workflow' | 'consensus';
```

### Provider

```typescript
type Provider = 'claude' | 'openai' | 'gemini' | 'azure';
```

### ReviewFile

```typescript
interface ReviewFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}
```

### RepoConfig

```typescript
interface RepoConfig {
  id: string;
  installation_id: number;
  repo_full_name: string;
  enabled: boolean;
  provider: Provider;
  model: string;
  rules: string | null;
  file_patterns: string[];
  exclude_patterns: string[];
  workflow_enabled: boolean;
  consensus_enabled: boolean;
  hebbian_enabled: boolean;
  created_at: string;
  updated_at: string;
}
```

### Review

```typescript
interface Review {
  id: string;
  repo_full_name: string;
  pr_number: number;
  pr_title: string | null;
  status: ReviewStatus;
  result_summary: string | null;
  result_full: {
    findings: ReviewFinding[];
  } | null;
  files_reviewed: string[];
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}
```

### GitHub Webhook Payloads

```typescript
interface PullRequestEventPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    draft: boolean;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
  installation: {
    id: number;
  };
}

interface InstallationEventPayload {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
  installation: {
    id: number;
    account: {
      login: string;
      type: 'User' | 'Organization';
      avatar_url: string;
    };
  };
  repositories?: Array<{ full_name: string }>;
}
```

---

## Rate Limits

### GitHub API

GHAGGA uses GitHub App authentication with higher rate limits:
- 5,000 requests/hour per installation
- Automatic token refresh

### LLM Providers

Rate limits vary by provider and plan. GHAGGA handles rate limiting with:
- Automatic retries with exponential backoff
- Configurable concurrent review limit
- Request queuing

---

## Webhook Security

### Signature Verification

All webhooks are verified using HMAC-SHA256:

```typescript
// Verification process
const signature = req.headers.get('x-hub-signature-256');
const isValid = await verifyWebhookSignature(body, signature, secret);
```

**Best Practices:**
- Use constant-time comparison to prevent timing attacks
- Reject requests without valid signatures
- Log verification failures for monitoring

### IP Filtering (Optional)

For additional security, restrict webhooks to GitHub's IP ranges:
- https://api.github.com/meta
